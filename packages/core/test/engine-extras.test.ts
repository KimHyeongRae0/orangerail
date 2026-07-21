import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { notImplemented } from '../src/define/action';
import { createEngine } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createMemoryStore } from '../src/store/memory';
import type { Identity } from '../src/types';

const editor: Identity = { subject: 'alice', roles: ['editor'] };

/**
 * A fixture whose execute captures the identity it receives, so the test can
 * assert the execute-time identity carries the SAME roles that staged (the
 * exact input a functional `where` reading `identity.roles` would see).
 */
const buildRoleCaptureFixture = () => {
  const registry = createRegistry();
  const seen: { roles?: string[] } = {};

  registry.defineAction({
    name: 'edit_doc',
    input: z.object({ v: z.string() }),
    policy: { approval: 'required' },
    execute: async ({ identity }) => {
      seen.roles = identity.roles;
      return { ok: true };
    },
  });

  const store = createMemoryStore();
  const engine = createEngine({ registry, store });

  return { registry, store, engine, seen };
};

describe('engine — staged roles persist through execute (§3.8, AC-9)', () => {
  it('reconstructs the execute-time identity with the persisted staging roles', async () => {
    const { engine, store, seen } = buildRoleCaptureFixture();

    const staged = await engine.stage({
      actionName: 'edit_doc',
      input: { v: 'x' },
      caller: editor,
    });
    if (staged.status !== 'approval_pending') {
      throw new Error(`stage failed: ${staged.status}`);
    }

    const record = await store.getApproval({ id: staged.approvalId });
    expect(record?.requestedByRoles).toEqual(['editor']);

    await engine.approve({ approvalId: staged.approvalId, approver: editor });
    const executed = await engine.execute({ approvalId: staged.approvalId });

    expect(executed.status).toBe('executed');
    // The ONT-002 `roles: []` drift is structurally impossible now.
    expect(seen.roles).toEqual(['editor']);
  });
});

describe('engine — dry_run mode / sandbox (§3.6, AC-6)', () => {
  it('never creates an approval or executes, and audits a dry_run phase', async () => {
    const registry = createRegistry();
    let ran = false;
    registry.defineAction({
      name: 'write_thing',
      input: z.object({ v: z.string() }),
      policy: { approval: 'required' },
      execute: async () => {
        ran = true;
        return { ok: true };
      },
    });
    const store = createMemoryStore();
    const engine = createEngine({ registry, store, mode: 'dry_run' });

    const result = await engine.stage({
      actionName: 'write_thing',
      input: { v: 'x' },
      caller: { subject: 'agent', roles: [] },
    });

    expect(result.status).toBe('dry_run');
    expect(ran).toBe(false);
    expect(await store.listApprovals()).toHaveLength(0);

    const audit = await store.readAudit({});
    expect(audit.items.map((r) => r.phase)).toEqual(['dry_run']);
  });
});

describe('engine — notImplemented stub (§3.7, AC-8)', () => {
  it('rejects at staging before any approval and audits not_implemented', async () => {
    const registry = createRegistry();
    registry.defineAction({
      name: 'stub_action',
      input: z.object({ v: z.string() }),
      policy: { approval: 'required' },
      execute: notImplemented,
    });
    const store = createMemoryStore();
    const engine = createEngine({ registry, store });

    const result = await engine.stage({
      actionName: 'stub_action',
      input: { v: 'x' },
      caller: { subject: 'agent', roles: [] },
    });

    expect(result.status).toBe('not_implemented');
    expect(await store.listApprovals()).toHaveLength(0);

    const audit = await store.readAudit({});
    expect(audit.items.map((r) => r.phase)).toEqual(['not_implemented']);
  });
});

describe('engine — redactAudit masks audit input only (§3.9, AC-7)', () => {
  it('masks the audit record input but leaves the approval record verbatim', async () => {
    const registry = createRegistry();
    registry.defineAction({
      name: 'secret_action',
      input: z.object({ token: z.string() }),
      policy: { approval: 'required' },
      execute: async () => ({ ok: true }),
    });
    const store = createMemoryStore();
    const engine = createEngine({
      registry,
      store,
      redactAudit: ({ input }) => ({ ...(input as object), token: '***' }),
    });

    const staged = await engine.stage({
      actionName: 'secret_action',
      input: { token: 'super-secret' },
      caller: { subject: 'agent', roles: [] },
    });
    if (staged.status !== 'approval_pending') {
      throw new Error('stage failed');
    }

    const approval = await store.getApproval({ id: staged.approvalId });
    expect(approval?.input).toEqual({ token: 'super-secret' });

    const audit = await store.readAudit({});
    const stagedRecord = audit.items.find((r) => r.phase === 'staged');
    expect(stagedRecord?.input).toEqual({ token: '***' });
  });
});
