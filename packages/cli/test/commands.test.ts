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

import {
  approvalsApprove,
  approvalsList,
  approvalsReject,
  approvalsShow,
} from '../src/commands/approvals';
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

/**
 * The one screen the gate exists for, driven through the real command (ONT-070).
 *
 * The renderer is unit-tested next door; what is proved here is the whole read
 * path an approver actually runs — store read, registry lookup, target read,
 * redaction mask, render — over a row a datasource can genuinely hand back and
 * `JSON.stringify` cannot print. Exit 0, the field named, and nothing on stderr:
 * the crash used to be the ONLY outcome, on an approval whose own input was
 * `{"id":3}` and perfectly serializable.
 */
describe('cli approvals show — total over an unrenderable row (ONT-070)', () => {
  /** A row with a cycle in it, which is not the `BigInt` case ONT-068 owns. */
  const circularRow = ({ id }: { id: string }): Record<string, unknown> => {
    const row: Record<string, unknown> = { id, stock: 0, retire: function retireRow() {} };
    row.self = row;

    return row;
  };

  const buildRowConfig = ({
    get,
    redactPrior,
  }: {
    get: (args: { id: string }) => Promise<unknown>;
    redactPrior?: OrangerailConfig['redactPrior'];
  }): OrangerailConfig => {
    const registry = createRegistry();
    const Product = registry.defineObject({
      name: 'Product',
      schema: z.object({ id: z.string(), stock: z.number() }),
      resolve: { get },
    });
    registry.defineAction({
      name: 'deleteProduct',
      target: Product,
      targetIdFrom: 'id',
      input: z.object({ id: z.string() }),
      policy: { approval: 'required' },
      execute: async ({ input }) => input,
    });

    return {
      registry,
      store: createMemoryStore(),
      ...(redactPrior ? { redactPrior } : {}),
    };
  };

  const stageDelete = async ({
    config,
    input = { id: 'p3' },
  }: {
    config: OrangerailConfig;
    input?: unknown;
  }): Promise<string> => {
    const engine = createEngine({ registry: config.registry, store: config.store });
    const staged = await engine.stage({
      actionName: 'deleteProduct',
      input,
      caller: { subject: 'agent', roles: [] },
    });
    if (staged.status !== 'approval_pending') {
      throw new Error(`stage failed: ${staged.status}`);
    }

    return staged.approvalId;
  };

  /** Both streams, so "no raw error text on stderr" (AC-4) is an assertion. */
  const capture = async ({
    run,
  }: {
    run: () => Promise<number>;
  }): Promise<{ code: number; out: string; err: string }> => {
    const out: string[] = [];
    const err: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((value: string) => {
      out.push(String(value));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((value: string) => {
      err.push(String(value));
      return true;
    }) as typeof process.stderr.write;

    try {
      const code = await run();

      return { code, out: out.join(''), err: err.join('') };
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  };

  it('exits 0 and prints action, input and target for a row JSON cannot render', async () => {
    const config = buildRowConfig({ get: async ({ id }) => circularRow({ id }) });
    const id = await stageDelete({ config });

    const { code, out, err } = await capture({ run: () => approvalsShow({ config, id }) });

    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('action:       "deleteProduct"');
    expect(out).toContain('"stock": 0');
    expect(out).toContain('input (agent-supplied):');
    expect(out).toContain('"id": "p3"');
  });

  it('names every field it could not print, with its key', async () => {
    const config = buildRowConfig({ get: async ({ id }) => circularRow({ id }) });
    const id = await stageDelete({ config });

    const { out } = await capture({ run: () => approvalsShow({ config, id }) });

    expect(out).toContain('NOT SHOWN AS-IS');
    expect(out).toContain('$.self — a circular reference');
    expect(out).toContain('$.retire — a function (retireRow)');
  });

  it('behaves the same under --full, with nothing truncated', async () => {
    const config = buildRowConfig({
      get: async ({ id }) => {
        const row = circularRow({ id });
        row.blob = 'A'.repeat(4000);

        return row;
      },
    });
    const id = await stageDelete({ config });

    const { code, out, err } = await capture({
      run: () => approvalsShow({ config, id, full: true }),
    });

    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).not.toContain('TRUNCATED');
    expect(out).toContain('$.self — a circular reference');
    expect(out).toContain('A'.repeat(4000));
  });

  it('renders an unrenderable INPUT while the target reads fine', async () => {
    const config = buildRowConfig({ get: async ({ id }) => ({ id, stock: 7 }) });
    const id = await stageDelete({ config });
    const staged = await config.store.getApproval({ id });

    // The staged payload is schema-parsed, so a cycle cannot get in through
    // `stage`. It can arrive from the store, which hydrates a record written by
    // a different process — so that is where this one is injected.
    const cyclic: Record<string, unknown> = { id: 'p3' };
    cyclic.self = cyclic;
    const hydrated: OrangerailConfig = {
      ...config,
      store: { ...config.store, getApproval: async () => ({ ...staged!, input: cyclic }) },
    };

    const { code, out } = await capture({ run: () => approvalsShow({ config: hydrated, id }) });

    expect(code).toBe(0);
    expect(out).toContain('"stock": 7');
    expect(out).toContain('circular reference');
  });

  it('keeps the pre-existing answer when the row was deleted since staging', async () => {
    const config = buildRowConfig({ get: async () => null });
    const id = await stageDelete({ config });

    const { code, out } = await capture({ run: () => approvalsShow({ config, id }) });

    expect(code).toBe(0);
    expect(out).toContain('NONE — no such object right now.');
  });

  it('reports a redactPrior that throws instead of losing the screen to it', async () => {
    const config = buildRowConfig({
      get: async ({ id }) => circularRow({ id }),
      redactPrior: () => {
        throw new Error('mask has a bug');
      },
    });
    const id = await stageDelete({ config });

    const { code, out, err } = await capture({ run: () => approvalsShow({ config, id }) });

    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('COULD NOT READ');
    expect(out).toContain('mask has a bug');
  });

  it('leaves list and reject working on the same approval', async () => {
    const config = buildRowConfig({ get: async ({ id }) => circularRow({ id }) });
    const id = await stageDelete({ config });

    const listed = await capture({ run: () => approvalsList({ config }) });
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(id);

    expect(await approvalsReject({ config, id })).toBe(0);
    expect((await config.store.getApproval({ id }))?.status).toBe('rejected');
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
