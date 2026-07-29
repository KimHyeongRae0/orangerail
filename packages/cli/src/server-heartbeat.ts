import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isFileStore, type FileStore, type Store } from 'orangerail-core';

/**
 * The liveness heartbeat an `orangerail mcp` server writes while it is actually
 * serving. It is a genuine signal, not a re-derivation from config: `status`
 * only counts a server as "running" when an entry names a live pid AND its
 * `lastHeartbeatAt` is fresh. The entries live OUTSIDE the locked append-only
 * store (a sibling of the store dir, `.orangerail/servers/`) so refreshing one
 * never contends with the audit/approvals lock.
 *
 * One file PER SERVER, named `<pid>.json`: any number of servers may share a
 * store, and each one only ever writes and removes its own entry. That is what
 * keeps the signal honest — a single shared slot let the second server overwrite
 * the first, and let either one's clean shutdown delete the file while the other
 * was still enforcing, so `status` claimed "not detected" of a live server.
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
 * A heartbeat older than this (or a dead pid) means that server is not enforcing
 * anymore — `status` reports it as `stale` rather than `running`. Sized
 * generously above the refresh interval so a momentarily busy event loop never
 * flaps.
 */
export const STALE_THRESHOLD_MS = 15_000;

/** How often the serving process rewrites `lastHeartbeatAt`. */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** Entry file names are exactly `<pid>.json`; anything else is not ours. */
const ENTRY_NAME = /^(\d+)\.json$/;

/**
 * The heartbeat directory for a store, or `null` when the store is not a file
 * store (a memory store has no shared on-disk location, so cross-process
 * liveness cannot be observed and `status` honestly reports "not detected").
 * Placed at `<storeDir>/../servers` — a sibling of the store dir, kept out of
 * the lock-guarded append-only files.
 */
export const heartbeatDirForStore = ({ store }: { store: Store }): string | null => {
  if (!isFileStore({ store })) {
    return null;
  }

  const { dir } = store as FileStore;

  return join(dirname(dir), 'servers');
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

/** One live server, as `status` reports it. */
export interface RunningServer {
  pid: number;
  startedAgoSec: number;
}

/**
 * The liveness verdict `status` renders, aggregated over every entry in the
 * directory. A discriminated union so each surface formats exactly the fields
 * that state carries — never a "running" claim without a live pid behind it,
 * and never a "not detected" claim while any entry proves a serving process.
 */
export type ServerLiveness =
  | { state: 'running'; servers: RunningServer[]; staleCount: number }
  | { state: 'stale'; lastHeartbeatAgoSec: number; staleCount: number }
  | { state: 'not_detected' };

/** Best-effort parse of one on-disk entry; malformed input yields `null`. */
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
 * Read every parseable entry in the heartbeat directory. An entry that vanishes
 * between the listing and the read (a server shutting down) or that fails to
 * parse is skipped rather than failing the sweep — one bad entry must never
 * make `status` blind to the others.
 */
const readEntries = ({ dir }: { dir: string }): ServerHeartbeat[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: ServerHeartbeat[] = [];

  for (const name of names) {
    if (!ENTRY_NAME.test(name)) {
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }

    const record = parseHeartbeat({ raw });
    if (record !== null) {
      entries.push(record);
    }
  }

  return entries;
};

/**
 * Read the heartbeat directory and classify liveness across ALL servers sharing
 * the store. An entry counts as live only when its pid is alive AND its
 * heartbeat is fresh — so a dead server's leftover entry, or a stale entry whose
 * pid was later reused by an unrelated process, can only ever downgrade the
 * verdict, never manufacture a "running" claim. Conversely a single live entry
 * is enough for `running`, so a shutting-down sibling can no longer erase a
 * serving server from the readout. `now` is injectable so every branch is unit
 * testable against a fixed clock.
 */
export const readServerLiveness = ({
  dir,
  now = Date.now(),
}: {
  dir: string | null;
  now?: number;
}): ServerLiveness => {
  if (dir === null) {
    return { state: 'not_detected' };
  }

  const entries = readEntries({ dir });

  const running: RunningServer[] = [];
  let newestStaleMs: number | null = null;
  let staleCount = 0;

  for (const entry of entries) {
    const lastMs = Date.parse(entry.lastHeartbeatAt);
    if (Number.isNaN(lastMs)) {
      continue;
    }

    const fresh = now - lastMs <= STALE_THRESHOLD_MS;

    if (fresh && isPidAlive({ pid: entry.pid })) {
      const startMs = Date.parse(entry.startedAt);
      running.push({
        pid: entry.pid,
        startedAgoSec: Number.isNaN(startMs) ? 0 : Math.max(0, Math.round((now - startMs) / 1000)),
      });
      continue;
    }

    staleCount += 1;
    newestStaleMs = newestStaleMs === null ? lastMs : Math.max(newestStaleMs, lastMs);
  }

  if (running.length > 0) {
    return { state: 'running', servers: running.sort((a, b) => a.pid - b.pid), staleCount };
  }

  if (newestStaleMs !== null) {
    return {
      state: 'stale',
      lastHeartbeatAgoSec: Math.max(0, Math.round((now - newestStaleMs) / 1000)),
      staleCount,
    };
  }

  return { state: 'not_detected' };
};

/** The trailing clause naming crashed leftovers alongside a live server. */
const formatStaleClause = ({ staleCount }: { staleCount: number }): string => {
  if (staleCount === 0) {
    return '';
  }

  const noun = staleCount === 1 ? 'entry' : 'entries';

  return ` · ${staleCount} stale ${noun} — a server may have crashed`;
};

/** Render a `ServerLiveness` as the honest one-line `status` readout value. */
export const formatServerLiveness = ({ server }: { server: ServerLiveness }): string => {
  if (server.state === 'running') {
    const stale = formatStaleClause({ staleCount: server.staleCount });

    const [only, ...rest] = server.servers;
    if (only !== undefined && rest.length === 0) {
      return `running (pid ${only.pid}, started ${only.startedAgoSec}s ago)${stale}`;
    }

    const each = server.servers
      .map((entry) => `pid ${entry.pid} started ${entry.startedAgoSec}s ago`)
      .join(', ');

    return `running (${server.servers.length} servers — ${each})${stale}`;
  }

  if (server.state === 'stale') {
    return `stale — last heartbeat ${server.lastHeartbeatAgoSec}s ago (it may have crashed)`;
  }

  return 'not detected — no orangerail mcp is running against this store';
};

/** A running heartbeat writer whose `stop` removes its entry and clears the timer. */
export interface HeartbeatHandle {
  stop: () => void;
}

/**
 * Remove entries that are provably abandoned: a dead pid whose last heartbeat
 * has already aged past the stale threshold. Both conditions are required — a
 * just-killed server's entry is kept so `status` can still report the crash
 * instead of quietly forgetting it, and a live pid's entry is never touched by
 * anyone but its owner. Called by serving processes on the heartbeat tick
 * (writers garbage-collect; readers stay pure), best-effort — two servers
 * reaping the same entry at once is harmless (`force` ignores a missing file).
 */
const reapDeadEntries = ({ dir, now }: { dir: string; now: number }): void => {
  for (const entry of readEntries({ dir })) {
    const lastMs = Date.parse(entry.lastHeartbeatAt);
    const aged = Number.isNaN(lastMs) || now - lastMs > STALE_THRESHOLD_MS;

    if (!aged || isPidAlive({ pid: entry.pid })) {
      continue;
    }

    try {
      rmSync(join(dir, `${entry.pid}.json`), { force: true });
    } catch {
      // Best-effort — a surviving entry only ever reads as `stale`.
    }
  }
};

/**
 * Begin writing this process's heartbeat entry: write it once, then refresh
 * `lastHeartbeatAt` on an `unref`'d timer so it never keeps the process alive.
 * The entry is written to a temp file and renamed into place, an atomic
 * same-directory rename, so a concurrent `status` can never read a half-written
 * entry and wrongly conclude nothing is serving. All writes are best-effort — a
 * heartbeat IO failure must never take down the governed server. Signal/exit
 * handlers call `stop`, which removes ONLY this process's entry, so a clean
 * shutdown never erases a sibling server that is still enforcing.
 */
export const startServerHeartbeat = ({
  dir,
  pid = process.pid,
}: {
  dir: string;
  /** Overridable so tests can drive several distinct live pids through the real writer. */
  pid?: number;
}): HeartbeatHandle => {
  const startedAt = new Date().toISOString();
  const path = join(dir, `${pid}.json`);
  const tmpPath = join(dir, `${pid}.json.tmp`);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort — a write failure below is already tolerated.
  }

  const tick = (): void => {
    const now = Date.now();
    const record: ServerHeartbeat = {
      pid,
      startedAt,
      lastHeartbeatAt: new Date(now).toISOString(),
    };

    try {
      writeFileSync(tmpPath, `${JSON.stringify(record)}\n`);
      renameSync(tmpPath, path);
    } catch {
      // Best-effort — never let a heartbeat write crash the server.
    }

    reapDeadEntries({ dir, now });
  };

  tick();

  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
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
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort — a leftover entry just reads as "stale" once the pid dies.
    }
  };

  return { stop };
};
