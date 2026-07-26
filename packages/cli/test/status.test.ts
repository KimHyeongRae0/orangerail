import {
  createEngine,
  createMemoryStore,
  createRegistry,
  DEV_SUBJECT,
  type Identity,
} from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { OrangerailConfig } from '../src/config';
import {
  computeStatus,
  formatStatusLine,
  runStatus,
  type StatusReport,
} from '../src/commands/status';

const devCaller: Identity = { subject: DEV_SUBJECT, roles: [], devMode: true };

/** A registry with one approval-gated action, one auto action, and one object. */
const buildConfig = (): OrangerailConfig => {
  const registry = createRegistry();
  registry.defineObject({ name: 'Widget', schema: z.object({ id: z.number() }) });
  registry.defineAction({
    name: 'deleteWidget',
    input: z.object({ id: z.number() }),
    policy: { approval: 'required' },
    execute: async () => ({ ok: true }),
  });
  registry.defineAction({
    name: 'pingWidget',
    input: z.object({ id: z.number() }),
    execute: async () => ({ ok: true }),
  });

  return { registry, store: createMemoryStore() };
};

const base: StatusReport = {
  objectCount: 2,
  gatedCount: 3,
  autoCount: 1,
  preset: 'approval-for-writes',
  readOnly: false,
  audit: { ok: true, count: 5, issues: [] },
  pendingCount: 0,
};

describe('computeStatus — governance posture from registry + store', () => {
  it('counts gated vs auto actions and objects, with a clean chain and no pending', async () => {
    const report = await computeStatus({ config: buildConfig() });

    expect(report.gatedCount).toBe(1);
    expect(report.autoCount).toBe(1);
    expect(report.objectCount).toBe(1);
    expect(report.audit.ok).toBe(true);
    expect(report.pendingCount).toBe(0);
  });

  it('reflects a staged approval in pendingCount', async () => {
    const config = buildConfig();
    const engine = createEngine({ registry: config.registry, store: config.store });
    const staged = await engine.stage({
      actionName: 'deleteWidget',
      input: { id: 1 },
      caller: devCaller,
    });
    expect(staged.status).toBe('approval_pending');

    const report = await computeStatus({ config });
    expect(report.pendingCount).toBe(1);
  });
});

describe('formatStatusLine — the MCP startup confidence signal', () => {
  it('states governance active with the gated count and audit record count', () => {
    expect(formatStatusLine({ report: base })).toBe(
      'orangerail: governance active · 3 action(s) approval-gated · audit chain OK (5 record(s))',
    );
  });

  it('appends the pending count when approvals are waiting', () => {
    expect(formatStatusLine({ report: { ...base, pendingCount: 2 } })).toContain(
      '· 2 pending approval(s)',
    );
  });

  it('says read-only when the preset exposes no write tools', () => {
    expect(formatStatusLine({ report: { ...base, readOnly: true, preset: 'readonly' } })).toContain(
      'read-only (no write tools exposed)',
    );
  });

  it('surfaces a broken audit chain loudly instead of claiming active', () => {
    const line = formatStatusLine({
      report: { ...base, audit: { ok: false, count: 5, issues: ['seq 3 hash mismatch'] } },
    });
    expect(line).toContain('AUDIT CHAIN FAILED (1 issue(s))');
    expect(line).toContain("run 'orangerail audit verify'");
  });
});

describe('runStatus — exit codes', () => {
  it('exits 0 on a clean chain', async () => {
    expect(await runStatus({ config: buildConfig() })).toBe(0);
  });

  it('exits non-zero when the audit chain is broken (orphan consumed approval)', async () => {
    const config = buildConfig();
    const created = await config.store.createApproval({
      record: {
        actionName: 'deleteWidget',
        input: { id: 1 },
        signatureHash: 'sig',
        requestedBy: 'agent',
        requestedByRoles: [],
        devMode: false,
      },
    });
    await config.store.resolveApproval({
      id: created.id,
      decision: 'approved',
      approver: { subject: 'alice', roles: [] },
    });
    await config.store.consumeApproval({ id: created.id });

    expect(await runStatus({ config })).not.toBe(0);
  });
});
