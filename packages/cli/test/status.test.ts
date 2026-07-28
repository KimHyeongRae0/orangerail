import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createEngine,
  createMemoryStore,
  createRegistry,
  DEV_SUBJECT,
  type Identity,
} from 'orangerail-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { OrangerailConfig } from '../src/config';
import {
  computeStatus,
  formatStatusLine,
  runStatus,
  type StatusReport,
} from '../src/commands/status';
import {
  formatServerLiveness,
  readServerLiveness,
  type ServerHeartbeat,
} from '../src/server-heartbeat';

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
  server: { state: 'not_detected' },
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
  it('states it is serving with governance, the gated count and audit record count', () => {
    expect(formatStatusLine({ report: base })).toBe(
      'orangerail mcp: serving · governance active · 3 action(s) approval-gated · audit chain OK (5 record(s))',
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

describe('readServerLiveness — running / stale / not detected from a heartbeat file', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orangerail-hb-'));
    path = join(dir, 'server.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeHeartbeat = ({ heartbeat }: { heartbeat: ServerHeartbeat }): void => {
    writeFileSync(path, `${JSON.stringify(heartbeat)}\n`);
  };

  it('reports not detected when no heartbeat file exists', () => {
    expect(readServerLiveness({ path })).toEqual({ state: 'not_detected' });
    expect(readServerLiveness({ path: null })).toEqual({ state: 'not_detected' });
  });

  it('reports running when the pid is alive and the heartbeat is fresh', () => {
    const now = Date.now();
    writeHeartbeat({
      heartbeat: {
        pid: process.pid,
        startedAt: new Date(now - 8_000).toISOString(),
        lastHeartbeatAt: new Date(now - 2_000).toISOString(),
      },
    });

    const server = readServerLiveness({ path, now });
    expect(server.state).toBe('running');
    if (server.state === 'running') {
      expect(server.pid).toBe(process.pid);
      expect(server.startedAgoSec).toBe(8);
    }
    expect(formatServerLiveness({ server })).toBe(`running (pid ${process.pid}, started 8s ago)`);
  });

  it('reports stale when the heartbeat is older than the threshold, even for a live pid', () => {
    const now = Date.now();
    writeHeartbeat({
      heartbeat: {
        pid: process.pid,
        startedAt: new Date(now - 60_000).toISOString(),
        lastHeartbeatAt: new Date(now - 30_000).toISOString(),
      },
    });

    const server = readServerLiveness({ path, now });
    expect(server.state).toBe('stale');
    expect(formatServerLiveness({ server })).toBe(
      'stale — last heartbeat 30s ago (it may have crashed)',
    );
  });

  it('reports stale when the pid is dead even though the heartbeat is fresh', () => {
    const now = Date.now();
    // A pid that is essentially never live in a test runner; process.kill(pid,0)
    // throws ESRCH, so freshness alone must not upgrade this to "running".
    writeHeartbeat({
      heartbeat: {
        pid: 2_147_483_646,
        startedAt: new Date(now - 3_000).toISOString(),
        lastHeartbeatAt: new Date(now - 1_000).toISOString(),
      },
    });

    expect(readServerLiveness({ path, now }).state).toBe('stale');
  });

  it('reports not detected for a malformed heartbeat file (never a false running claim)', () => {
    writeFileSync(path, 'not json at all');
    expect(readServerLiveness({ path }).state).toBe('not_detected');
  });
});
