import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isFileStore, type FileStore, type Store } from 'orangerail-core';

/**
 * The liveness heartbeat an `orangerail mcp` server writes while it is actually
 * serving. It is a genuine signal, not a re-derivation from config: `status`
 * only claims a server is "running" when this file names a live pid AND its
 * `lastHeartbeatAt` is fresh. The file lives OUTSIDE the locked append-only
 * store (a sibling of the store dir, `.orangerail/server.json`) so refreshing
 * it never contends with the audit/approvals lock.
 */
export interface ServerHeartbeat {
  /** The serving process id, checked with `process.kill(pid, 0)` for liveness. */
  pid: number;
  /** ISO timestamp of when the server began serving. */
  startedAt: string;
  /** ISO timestamp refreshed on a periodic timer while the server serves. */
  lastHeartbeatAt: string;
}

/**
 * A heartbeat older than this (or a dead pid) means the server is not enforcing
 * anymore — `status` reports `stale` rather than `running`. Sized generously
 * above the refresh interval so a momentarily busy event loop never flaps.
 */
export const STALE_THRESHOLD_MS = 15_000;

/** How often the serving process rewrites `lastHeartbeatAt`. */
const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * The heartbeat file path for a store, or `null` when the store is not a file
 * store (a memory store has no shared on-disk location, so cross-process
 * liveness cannot be observed and `status` honestly reports "not detected").
 * Placed at `<storeDir>/../server.json` — a sibling of the store dir, kept out
 * of the lock-guarded append-only files.
 */
export const heartbeatPathForStore = ({ store }: { store: Store }): string | null => {
  if (!isFileStore({ store })) {
    return null;
  }

  const { dir } = store as FileStore;

  return join(dirname(dir), 'server.json');
};

/** Whether a pid names a live process (`EPERM` means alive-but-not-ours). */
const isPidAlive = ({ pid }: { pid: number }): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The liveness verdict `status` renders. A discriminated union so each surface
 * formats exactly the fields that state carries — never a "running" claim for a
 * dead pid or a stale heartbeat.
 */
export type ServerLiveness =
  | { state: 'running'; pid: number; startedAgoSec: number }
  | { state: 'stale'; lastHeartbeatAgoSec: number }
  | { state: 'not_detected' };

/** Best-effort parse of the on-disk heartbeat; malformed input yields `null`. */
const parseHeartbeat = ({ raw }: { raw: string }): ServerHeartbeat | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const record = parsed as Partial<ServerHeartbeat>;
  if (
    typeof record.pid !== 'number' ||
    typeof record.startedAt !== 'string' ||
    typeof record.lastHeartbeatAt !== 'string'
  ) {
    return null;
  }

  return { pid: record.pid, startedAt: record.startedAt, lastHeartbeatAt: record.lastHeartbeatAt };
};

/**
 * Read the heartbeat and classify liveness. `running` requires BOTH a live pid
 * and a fresh heartbeat; a present-but-dead/stale file is `stale`; an absent,
 * unreadable, or malformed file is `not_detected` (we cannot prove a server, so
 * we never claim one). `now` is injectable so the three branches are unit
 * testable against a fixed clock.
 */
export const readServerLiveness = ({
  path,
  now = Date.now(),
}: {
  path: string | null;
  now?: number;
}): ServerLiveness => {
  if (path === null) {
    return { state: 'not_detected' };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { state: 'not_detected' };
  }

  const record = parseHeartbeat({ raw });
  if (record === null) {
    return { state: 'not_detected' };
  }

  const lastMs = Date.parse(record.lastHeartbeatAt);
  if (Number.isNaN(lastMs)) {
    return { state: 'not_detected' };
  }

  const ageMs = now - lastMs;
  const fresh = ageMs <= STALE_THRESHOLD_MS;

  if (isPidAlive({ pid: record.pid }) && fresh) {
    const startMs = Date.parse(record.startedAt);
    const startedAgoSec = Number.isNaN(startMs)
      ? 0
      : Math.max(0, Math.round((now - startMs) / 1000));

    return { state: 'running', pid: record.pid, startedAgoSec };
  }

  return { state: 'stale', lastHeartbeatAgoSec: Math.max(0, Math.round(ageMs / 1000)) };
};

/** Render a `ServerLiveness` as the honest one-line `status` readout value. */
export const formatServerLiveness = ({ server }: { server: ServerLiveness }): string => {
  if (server.state === 'running') {
    return `running (pid ${server.pid}, started ${server.startedAgoSec}s ago)`;
  }

  if (server.state === 'stale') {
    return `stale — last heartbeat ${server.lastHeartbeatAgoSec}s ago (it may have crashed)`;
  }

  return 'not detected — no orangerail mcp is running against this store';
};

/** A running heartbeat writer whose `stop` removes the file and clears the timer. */
export interface HeartbeatHandle {
  stop: () => void;
}

/**
 * Begin writing the heartbeat for the serving process: write it once, then
 * refresh `lastHeartbeatAt` on an `unref`'d timer so it never keeps the process
 * alive. All writes are best-effort — a heartbeat IO failure must never take
 * down the governed server. Signal/exit handlers call `stop` to remove the file
 * so a clean shutdown reads as "not detected" rather than a lingering "stale".
 */
export const startServerHeartbeat = ({ path }: { path: string }): HeartbeatHandle => {
  const startedAt = new Date().toISOString();

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Best-effort — the store dir is created by its own lazy lock mkdir.
  }

  const write = (): void => {
    const record: ServerHeartbeat = {
      pid: process.pid,
      startedAt,
      lastHeartbeatAt: new Date().toISOString(),
    };

    try {
      writeFileSync(path, `${JSON.stringify(record)}\n`);
    } catch {
      // Best-effort — never let a heartbeat write crash the server.
    }
  };

  write();

  const timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
  timer.unref();

  let stopped = false;
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;

    clearInterval(timer);

    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort — a leftover file just reads as "stale" once the pid dies.
    }
  };

  return { stop };
};
