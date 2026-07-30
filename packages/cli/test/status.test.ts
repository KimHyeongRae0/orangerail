import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { actionPostures, writeBaseline } from '../src/governance';
import {
  computeStatus,
  formatStatusLine,
  runStatus,
  type StatusReport,
} from '../src/commands/status';
import {
  formatServerLiveness,
  readServerLiveness,
  startServerHeartbeat,
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

/** Capture both streams; `runStatus` writes to them directly. */
const captureStreams = (): { out: () => string; err: () => string; restore: () => void } => {
  let out = '';
  let err = '';
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err += chunk;
    return true;
  }) as typeof process.stderr.write;

  return {
    out: () => out,
    err: () => err,
    restore: () => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    },
  };
};

/** A project root with no baseline in it, so `computeStatus` is not cwd-dependent. */
const emptyRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orangerail-status-'));
  roots.push(dir);

  return dir;
};

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const base: StatusReport = {
  objectCount: 2,
  gatedCount: 3,
  autoCount: 1,
  preset: 'approval-for-writes',
  readOnly: false,
  audit: { ok: true, count: 5, issues: [] },
  pendingCount: 0,
  server: { state: 'not_detected' },
  governance: {
    state: 'verified',
    recordedBy: 'sync',
    postures: [],
    changes: [],
    weakenedActions: [],
  },
  withheld: [],
  skew: { state: 'aligned' },
};

describe('computeStatus — governance posture from registry + store', () => {
  it('counts gated vs auto actions and objects, with a clean chain and no pending', async () => {
    const report = await computeStatus({ config: buildConfig(), projectRoot: emptyRoot() });

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

    const report = await computeStatus({ config, projectRoot: emptyRoot() });
    expect(report.pendingCount).toBe(1);
  });

  /**
   * ONT-050 — the counts above are self-reported and unfalsifiable on their own.
   * An ontology whose gate someone deleted reports them with total confidence
   * and every word is true; only the baseline can say one of them moved.
   */
  it('carries the baseline verdict and the withheld set', async () => {
    const config = buildConfig();
    const root = emptyRoot();

    const unrecorded = await computeStatus({ config, projectRoot: root });
    expect(unrecorded.governance.state).toBe('unrecorded');
    expect(unrecorded.withheld).toEqual([]);

    writeBaseline({
      projectRoot: root,
      postures: actionPostures({ registry: config.registry }).map((posture) =>
        posture.name === 'pingWidget' ? { ...posture, approval: 'required' as const } : posture,
      ),
      recordedBy: 'sync',
    });

    const weakened = await computeStatus({ config, projectRoot: root });
    expect(weakened.governance.state).toBe('weakened');
    expect(weakened.withheld).toEqual(['pingWidget']);
  });
});

describe('formatStatusLine — the MCP startup confidence signal', () => {
  it('states it is serving with governance, the gated count and audit record count', () => {
    expect(formatStatusLine({ report: base })).toBe(
      'orangerail mcp: serving · governance active · 3 action(s) approval-gated · matches the recorded baseline · audit chain OK (5 record(s))',
    );
  });

  /**
   * The line the reproduction caught: `serving · governance active · 18
   * action(s) approval-gated` printed by a server that had just been handed an
   * ontology with a gate removed. It is not allowed to describe a posture the
   * baseline contradicts without saying so.
   */
  it('names the drift and the withheld actions instead of a clean gated count', () => {
    const line = formatStatusLine({
      report: {
        ...base,
        governance: {
          state: 'weakened',
          recordedBy: 'sync',
          postures: [],
          changes: [],
          weakenedActions: ['deleteOrder'],
        },
        withheld: ['deleteOrder'],
      },
    });

    expect(line).toContain('GOVERNANCE DRIFT');
    expect(line).toContain('1 action(s) WITHHELD');
    expect(line).toContain('deleteOrder');
  });

  it('says the posture is unverified when no baseline is recorded, and when one cannot be read', () => {
    const unrecorded = formatStatusLine({
      report: {
        ...base,
        governance: { state: 'unrecorded', postures: [], changes: [], weakenedActions: [] },
      },
    });
    expect(unrecorded).toContain('no governance baseline recorded');
    expect(unrecorded).toContain('unverified');

    const unreadable = formatStatusLine({
      report: {
        ...base,
        governance: {
          state: 'unreadable',
          detail: 'not valid JSON',
          postures: [],
          changes: [],
          weakenedActions: [],
        },
      },
    });
    expect(unreadable).toContain('UNREADABLE');
  });

  it('flags an init-recorded baseline as not yet reviewed', () => {
    expect(
      formatStatusLine({
        report: { ...base, governance: { ...base.governance, recordedBy: 'init' } },
      }),
    ).toContain('recorded by init, not yet reviewed');
  });

  it('says nothing about a baseline for an ontology with no actions', () => {
    expect(
      formatStatusLine({
        report: {
          ...base,
          governance: { state: 'no-actions', postures: [], changes: [], weakenedActions: [] },
        },
      }),
    ).toBe(
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

  it('reports a broken chain AND a weakened posture — one loud failure never swallows the other', () => {
    const line = formatStatusLine({
      report: {
        ...base,
        audit: { ok: false, count: 5, issues: ['seq 3 hash mismatch'] },
        governance: {
          state: 'weakened',
          recordedBy: 'sync',
          postures: [],
          changes: [],
          weakenedActions: ['deleteOrder'],
        },
        withheld: ['deleteOrder'],
      },
    });

    expect(line).toContain('AUDIT CHAIN FAILED');
    expect(line).toContain('GOVERNANCE DRIFT');
  });
});

describe('runStatus — exit codes', () => {
  it('exits 0 on a clean chain', async () => {
    expect(await runStatus({ config: buildConfig(), projectRoot: emptyRoot() })).toBe(0);
  });

  it('exits 1 when the posture is weaker than the recorded baseline, and names it', async () => {
    const config = buildConfig();
    const root = emptyRoot();

    writeBaseline({
      projectRoot: root,
      postures: actionPostures({ registry: config.registry }).map((posture) =>
        posture.name === 'pingWidget' ? { ...posture, approval: 'required' as const } : posture,
      ),
      recordedBy: 'sync',
    });

    const streams = captureStreams();
    let code: number;
    try {
      code = await runStatus({ config, projectRoot: root });
    } finally {
      streams.restore();
    }

    // Pre-fix this readout printed `1 approval-gated, 1 auto` and exited 0.
    expect(code).toBe(1);
    expect(streams.out()).toContain('baseline: DRIFTED');
    expect(streams.out()).toContain('pingWidget');
    expect(streams.out()).toContain('withholds these');
  });

  it('reports an absent baseline on the readout but does not call it an error', async () => {
    const streams = captureStreams();
    let code: number;
    try {
      code = await runStatus({ config: buildConfig(), projectRoot: emptyRoot() });
    } finally {
      streams.restore();
    }

    expect(code).toBe(0);
    expect(streams.out()).toContain('baseline: NONE');
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

    expect(await runStatus({ config, projectRoot: emptyRoot() })).not.toBe(0);
  });
});

describe('runStatus — the audit FAILURE goes to stderr (ONT-044 H)', () => {
  /** A config whose chain is broken by an approved-then-consumed orphan record. */
  const brokenChainConfig = async (): Promise<OrangerailConfig> => {
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

    return config;
  };

  it('survives `orangerail status >/dev/null` — the finding is on stderr, exit 1', async () => {
    const config = await brokenChainConfig();
    const streams = captureStreams();

    let code: number;
    try {
      code = await runStatus({ config, projectRoot: emptyRoot() });
    } finally {
      streams.restore();
    }

    expect(code).toBe(1);
    // Redirecting stdout away must not erase the one line that matters.
    expect(streams.err()).toContain('audit:    FAILED');
    expect(streams.err()).toMatch(/- /);
    expect(streams.out()).not.toContain('FAILED');
  });

  it('leaves the healthy readout on stdout', async () => {
    const streams = captureStreams();

    let code: number;
    try {
      code = await runStatus({ config: buildConfig(), projectRoot: emptyRoot() });
    } finally {
      streams.restore();
    }

    expect(code).toBe(0);
    expect(streams.out()).toContain('orangerail status');
    expect(streams.out()).toContain('audit:    chain OK');
    expect(streams.err()).toBe('');
  });
});

describe('readServerLiveness — running / stale / not detected from heartbeat entries', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orangerail-hb-'));
    mkdirSync(join(dir, 'servers'), { recursive: true });
    dir = join(dir, 'servers');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeHeartbeat = ({ heartbeat }: { heartbeat: ServerHeartbeat }): void => {
    writeFileSync(join(dir, `${heartbeat.pid}.json`), `${JSON.stringify(heartbeat)}\n`);
  };

  it('reports not detected when no heartbeat entry exists', () => {
    expect(readServerLiveness({ dir })).toEqual({ state: 'not_detected' });
    expect(readServerLiveness({ dir: null })).toEqual({ state: 'not_detected' });
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

    const server = readServerLiveness({ dir, now });
    expect(server.state).toBe('running');
    if (server.state === 'running') {
      expect(server.servers).toEqual([{ pid: process.pid, startedAgoSec: 8 }]);
      expect(server.staleCount).toBe(0);
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

    const server = readServerLiveness({ dir, now });
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

    expect(readServerLiveness({ dir, now }).state).toBe('stale');
  });

  it('reports not detected for a malformed heartbeat entry (never a false running claim)', () => {
    writeFileSync(join(dir, '999.json'), 'not json at all');
    expect(readServerLiveness({ dir }).state).toBe('not_detected');
  });

  it('keeps reporting the live server when a sibling entry is malformed', () => {
    const now = Date.now();
    writeFileSync(join(dir, '999.json'), 'not json at all');
    writeHeartbeat({
      heartbeat: {
        pid: process.pid,
        startedAt: new Date(now - 1_000).toISOString(),
        lastHeartbeatAt: new Date(now - 1_000).toISOString(),
      },
    });

    expect(readServerLiveness({ dir, now }).state).toBe('running');
  });

  it('surfaces a crashed leftover alongside a live server instead of hiding it', () => {
    const now = Date.now();
    writeHeartbeat({
      heartbeat: {
        pid: process.pid,
        startedAt: new Date(now - 4_000).toISOString(),
        lastHeartbeatAt: new Date(now - 1_000).toISOString(),
      },
    });
    writeHeartbeat({
      heartbeat: {
        pid: 2_147_483_646,
        startedAt: new Date(now - 90_000).toISOString(),
        lastHeartbeatAt: new Date(now - 40_000).toISOString(),
      },
    });

    const server = readServerLiveness({ dir, now });
    expect(server.state).toBe('running');
    expect(formatServerLiveness({ server })).toBe(
      `running (pid ${process.pid}, started 4s ago) · 1 stale entry — a server may have crashed`,
    );
  });
});

/**
 * ONT-036 — the regression this ticket exists for. Two servers share one store;
 * the signal must describe BOTH, and one shutting down must never erase the
 * other. Driven through the real writer with real, distinct, live pids (idle
 * child processes) rather than hand-written files, so the pid-liveness check and
 * the shutdown path are genuinely exercised.
 */
describe('multi-server liveness — two servers against one store', () => {
  let dir: string;
  const children: ChildProcess[] = [];

  /** An idle child whose pid is genuinely live for the duration of the test. */
  const spawnIdle = (): number => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    children.push(child);

    if (child.pid === undefined) {
      throw new Error('failed to spawn an idle child process');
    }

    return child.pid;
  };

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'orangerail-hb-')), 'servers');
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports both servers, and still reports the survivor after one stops cleanly', () => {
    const pidA = spawnIdle();
    const pidB = spawnIdle();

    const a = startServerHeartbeat({ dir, pid: pidA });
    const b = startServerHeartbeat({ dir, pid: pidB });

    const both = readServerLiveness({ dir });
    expect(both.state).toBe('running');
    if (both.state === 'running') {
      expect(both.servers.map((entry) => entry.pid).sort((x, y) => x - y)).toEqual(
        [pidA, pidB].sort((x, y) => x - y),
      );
    }
    expect(formatServerLiveness({ server: both })).toContain('2 servers');

    // A shuts down cleanly while B is still serving. Before this fix A's exit
    // deleted the one shared file and `status` claimed "not detected" of B.
    a.stop();

    const survivor = readServerLiveness({ dir });
    expect(survivor.state).toBe('running');
    if (survivor.state === 'running') {
      expect(survivor.servers).toEqual([{ pid: pidB, startedAgoSec: 0 }]);
    }
    expect(formatServerLiveness({ server: survivor })).toBe(
      `running (pid ${pidB}, started 0s ago)`,
    );

    b.stop();
    expect(readServerLiveness({ dir }).state).toBe('not_detected');
  });

  it('writes each entry atomically, leaving no partial file for a reader to trip on', () => {
    const pid = spawnIdle();
    const handle = startServerHeartbeat({ dir, pid });

    expect(readdirSync(dir)).toEqual([`${pid}.json`]);

    handle.stop();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reaps a provably abandoned entry on the next server start, keeping a fresh crash visible', () => {
    mkdirSync(dir, { recursive: true });
    const now = Date.now();

    // Dead pid, heartbeat aged past the threshold — garbage.
    writeFileSync(
      join(dir, '2147483646.json'),
      `${JSON.stringify({
        pid: 2_147_483_646,
        startedAt: new Date(now - 90_000).toISOString(),
        lastHeartbeatAt: new Date(now - 40_000).toISOString(),
      })}\n`,
    );

    // Dead pid, but only just — the crash evidence must survive so `status` can
    // still report `stale` rather than quietly forgetting the server.
    writeFileSync(
      join(dir, '2147483645.json'),
      `${JSON.stringify({
        pid: 2_147_483_645,
        startedAt: new Date(now - 9_000).toISOString(),
        lastHeartbeatAt: new Date(now - 1_000).toISOString(),
      })}\n`,
    );

    const pid = spawnIdle();
    const handle = startServerHeartbeat({ dir, pid });

    expect(existsSync(join(dir, '2147483646.json'))).toBe(false);
    expect(existsSync(join(dir, '2147483645.json'))).toBe(true);

    handle.stop();
    expect(readServerLiveness({ dir }).state).toBe('stale');
  });
});
