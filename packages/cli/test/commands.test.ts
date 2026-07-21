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

import { approvalsApprove, approvalsReject } from '../src/commands/approvals';
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
