import {
  createEngine,
  createMemoryStore,
  createRegistry,
  DEV_SUBJECT,
  type Identity,
  type ResolveIdentity,
  type Store,
} from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { approvalsApprove, approvalsReject, approvalsShow } from '../src/commands/approvals';
import { auditVerify } from '../src/commands/audit';
import type { OrangerailConfig } from '../src/config';

const devCaller: Identity = { subject: DEV_SUBJECT, roles: [], devMode: true };

const buildConfig = ({
  resolveIdentity,
}: { resolveIdentity?: ResolveIdentity } = {}): OrangerailConfig => {
  const registry = createRegistry();
  registry.defineAction({
    name: 'act',
    input: z.object({ v: z.string() }),
    policy: { approval: 'required', roles: ['editor'] },
    execute: async () => ({ ok: true }),
  });
  const store = createMemoryStore();

  return { registry, store, ...(resolveIdentity ? { resolveIdentity } : {}) };
};

const stage = async ({
  config,
  caller,
}: {
  config: OrangerailConfig;
  caller: Identity;
}): Promise<string> => {
  const engine = createEngine({ registry: config.registry, store: config.store });
  const staged = await engine.stage({ actionName: 'act', input: { v: 'x' }, caller });
  if (staged.status !== 'approval_pending') {
    throw new Error(`stage failed: ${staged.status}`);
  }

  return staged.approvalId;
};

const approvedDevMode = async ({ store }: { store: Store }): Promise<boolean> => {
  const audit = await store.readAudit({});
  const approved = audit.items.find((r) => r.phase === 'approved');

  return approved?.devMode === true;
};

describe('cli approvals — exit codes and role mapping (AC-3/AC-4)', () => {
  it('approves with the correct adapter-mapped role (exit 0)', async () => {
    const config = buildConfig({
      resolveIdentity: () => ({ subject: 'alice', roles: ['editor'] }),
    });
    const id = await stage({ config, caller: { subject: 'agent', roles: ['editor'] } });

    expect(await approvalsApprove({ config, id })).toBe(0);
  });

  it('refuses a wrong-role approver (non-zero exit)', async () => {
    const config = buildConfig({ resolveIdentity: () => ({ subject: 'bob', roles: ['viewer'] }) });
    const id = await stage({ config, caller: { subject: 'agent', roles: ['editor'] } });

    expect(await approvalsApprove({ config, id })).not.toBe(0);
  });

  it('refuses an anonymous approver (adapter null, non-zero exit)', async () => {
    const config = buildConfig({ resolveIdentity: () => null });
    const id = await stage({ config, caller: { subject: 'agent', roles: ['editor'] } });

    expect(await approvalsApprove({ config, id })).not.toBe(0);
  });

  it('rejects via the reject command (exit 0)', async () => {
    const config = buildConfig({
      resolveIdentity: () => ({ subject: 'alice', roles: ['editor'] }),
    });
    const id = await stage({ config, caller: { subject: 'agent', roles: ['editor'] } });

    expect(await approvalsReject({ config, id })).toBe(0);
  });
});

describe('cli — devMode stamped over both stage and approve paths (AC-4)', () => {
  it('stamps devMode on the staged and approved audit records with no adapter', async () => {
    const config = buildConfig();
    const id = await stage({ config, caller: devCaller });

    const audit = await config.store.readAudit({});
    expect(audit.items.find((r) => r.phase === 'staged')?.devMode).toBe(true);

    expect(await approvalsApprove({ config, id })).toBe(0);
    expect(await approvedDevMode({ store: config.store })).toBe(true);
  });
});

/**
 * The approver's screen has to answer "what does this change?" — half of which
 * is the row as it stands now (§3.11 / ONT-057). Driven through the real command
 * so the registry lookup, the target read and the redaction policy are all
 * exercised, not just the renderer.
 */
describe('cli approvals show — the current target row (§3.11 / ONT-057)', () => {
  const buildTargetConfig = ({
    redactAudit,
  }: { redactAudit?: OrangerailConfig['redactAudit'] } = {}): OrangerailConfig => {
    const registry = createRegistry();
    const Product = registry.defineObject({
      name: 'Product',
      schema: z.object({ id: z.string(), stock: z.number() }),
      resolve: { get: async ({ id }) => ({ id, stock: 0 }) },
    });
    registry.defineAction({
      name: 'updateProduct',
      target: Product,
      targetIdFrom: 'id',
      input: z.object({ id: z.string(), stock: z.number() }),
      policy: { approval: 'required' },
      execute: async ({ input }) => input,
    });

    return {
      registry,
      store: createMemoryStore(),
      ...(redactAudit ? { redactAudit } : {}),
    };
  };

  const stageUpdate = async ({ config }: { config: OrangerailConfig }): Promise<string> => {
    const engine = createEngine({ registry: config.registry, store: config.store });
    const staged = await engine.stage({
      actionName: 'updateProduct',
      input: { id: 'p3', stock: 25 },
      caller: { subject: 'agent', roles: [] },
    });
    if (staged.status !== 'approval_pending') {
      throw new Error(`stage failed: ${staged.status}`);
    }

    return staged.approvalId;
  };

  const captureStdout = async ({ run }: { run: () => Promise<number> }): Promise<string> => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((value: string) => {
      chunks.push(String(value));
      return true;
    }) as typeof process.stdout.write;

    try {
      await run();
    } finally {
      process.stdout.write = original;
    }

    return chunks.join('');
  };

  it('prints the row the write is aimed at, alongside the staged input', async () => {
    const config = buildTargetConfig();
    const id = await stageUpdate({ config });

    const out = await captureStdout({ run: () => approvalsShow({ config, id }) });

    expect(out).toContain('target (current state, read now):');
    expect(out).toContain('"stock": 0');
    expect(out).toContain('"stock": 25');
  });

  it('withholds the row under the same policy the audit chain applies', async () => {
    const config = buildTargetConfig({ redactAudit: ({ input }) => input });
    const id = await stageUpdate({ config });

    const out = await captureStdout({ run: () => approvalsShow({ config, id }) });

    expect(out).toContain('WITHHELD');
    expect(out).not.toContain('"stock": 0');
  });
});

describe('cli audit verify — exit codes (AC-5)', () => {
  it('exits 0 on a clean chain', async () => {
    const config = buildConfig();
    expect(await auditVerify({ config })).toBe(0);
  });

  it('exits non-zero when a consumed approval has no execution_started (orphan)', async () => {
    const config = buildConfig();
    const created = await config.store.createApproval({
      record: {
        actionName: 'act',
        input: { v: 'x' },
        signatureHash: 'sig',
        requestedBy: 'agent',
        requestedByRoles: [],
        devMode: false,
      },
    });
    await config.store.resolveApproval({
      id: created.id,
      decision: 'approved',
      approver: { subject: 'alice', roles: ['editor'] },
    });
    await config.store.consumeApproval({ id: created.id });

    expect(await auditVerify({ config })).not.toBe(0);
  });
});
