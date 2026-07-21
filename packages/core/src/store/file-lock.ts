import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cross-process exclusive lock for the file store (§3.1). A lock is a
 * DIRECTORY (`<dir>/lock/`) created with `fs.mkdirSync` — atomic and
 * `EEXIST`-on-collision identically across macOS / Linux / Windows local
 * filesystems, sidestepping the POSIX advisory-lock variance table. Inside it,
 * `owner.json` records `{ pid, token, acquiredAt }` for diagnostics and the
 * own-token re-verify.
 *
 * The runtime NEVER steals or force-removes a held lock. A waiter that cannot
 * acquire before its timeout throws fail-closed with an owner diagnostic;
 * recovery of a provably-dead owner's lock is the explicit operator command
 * `orangerail store unlock` ({@link unlockStore}). This trades a rare liveness
 * cost (a process SIGKILL'd inside the ms-long critical section leaves the
 * store locked until unlock) for zero runtime steal-race surface.
 */

/** Persisted lock owner metadata. */
export interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

/** Result of {@link unlockStore}. */
export interface UnlockResult {
  ok: boolean;
  reason: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const BACKOFF_MS = 20;

const sleep = ({ ms }: { ms: number }): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const lockPath = ({ dir }: { dir: string }): string => join(dir, 'lock');

const ownerPath = ({ lockDir }: { lockDir: string }): string => join(lockDir, 'owner.json');

/** Read `owner.json`; returns `null` for missing / unreadable / malformed (never throws). */
const readOwner = ({ lockDir }: { lockDir: string }): LockOwner | null => {
  try {
    const raw = readFileSync(ownerPath({ lockDir }), 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as LockOwner).pid === 'number' &&
      typeof (parsed as LockOwner).token === 'string'
    ) {
      return parsed as LockOwner;
    }

    return null;
  } catch {
    return null;
  }
};

/**
 * Liveness of a pid via `process.kill(pid, 0)`. `ESRCH` ⇒ dead; `EPERM`
 * (a foreign-user process) ⇒ alive — implementations MUST NOT lump `EPERM`
 * with `ESRCH`, or `store unlock` would clear a live foreign-owned lock.
 */
const pidLiveness = ({ pid }: { pid: number }): 'alive' | 'dead' | 'unknown' => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === 'ESRCH') {
      return 'dead';
    }
    if (code === 'EPERM') {
      return 'alive';
    }

    return 'unknown';
  }
};

const timeoutMessage = ({ lockDir }: { lockDir: string }): string => {
  const owner = readOwner({ lockDir });

  if (!owner) {
    return `store lock ${lockDir} is held by an unknown owner (owner.json missing or unreadable) — timed out fail-closed`;
  }

  const liveness = pidLiveness({ pid: owner.pid });

  if (liveness === 'dead') {
    return `store lock ${lockDir} owner pid ${owner.pid} is dead — run \`orangerail store unlock\` to recover`;
  }

  return `store lock ${lockDir} is held by pid ${owner.pid} — timed out fail-closed (the runtime never steals a lock)`;
};

/**
 * Acquire the store lock, returning the owner token. Ensures `dir` exists,
 * then spins on atomic `mkdir` with jittered backoff until the timeout, at
 * which point it throws fail-closed with an owner diagnostic.
 */
export const acquireLock = async ({
  dir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  dir: string;
  timeoutMs?: number;
}): Promise<string> => {
  mkdirSync(dir, { recursive: true });

  const lockDir = lockPath({ dir });
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lockDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }

      if (Date.now() >= deadline) {
        throw new Error(timeoutMessage({ lockDir }));
      }

      await sleep({ ms: BACKOFF_MS + Math.floor(Math.random() * BACKOFF_MS) });
      continue;
    }

    writeFileSync(
      ownerPath({ lockDir }),
      JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }),
    );

    return token;
  }
};

/**
 * Whether the caller still owns the lock (own-token re-verify, §3.1). Called
 * before each data-file write and before release to detect an out-of-band
 * operator unlock under a live holder.
 */
export const isLockOwner = ({ dir, token }: { dir: string; token: string }): boolean =>
  readOwner({ lockDir: lockPath({ dir }) })?.token === token;

/**
 * Release the lock — removes `lock/` ONLY when `owner.json` still carries the
 * caller's token (protects a successor holder if an operator removed the lock
 * out-of-band mid-hold, against the documented precondition).
 */
export const releaseLock = ({ dir, token }: { dir: string; token: string }): void => {
  const lockDir = lockPath({ dir });

  if (readOwner({ lockDir })?.token === token) {
    rmSync(lockDir, { recursive: true, force: true });
  }
};

/**
 * Operator recovery (`orangerail store unlock`, §3.1): removes `lock/` ONLY when
 * the owner pid is provably dead (`ESRCH`). Refuses a live owner, an ambiguous
 * (`EPERM` / other) owner, and a missing/unreadable `owner.json` (clearing an
 * ownerless lock could remove a live acquirer inside the mkdir→write gap —
 * manual `rm -r <dir>/lock` stays the documented last resort). Human-invoked
 * at operator scale, so it needs no concurrent-reaper protocol.
 */
export const unlockStore = ({ dir }: { dir: string }): UnlockResult => {
  const lockDir = lockPath({ dir });

  if (!existsSync(lockDir)) {
    return { ok: true, reason: 'no lock is held' };
  }

  const owner = readOwner({ lockDir });
  if (!owner) {
    return {
      ok: false,
      reason:
        'owner.json is missing or unreadable — refusing (could remove a live acquirer mid-acquire); if no orangerail process is running, manually remove the lock/ directory',
    };
  }

  const liveness = pidLiveness({ pid: owner.pid });
  if (liveness === 'alive') {
    return {
      ok: false,
      reason: `owner pid ${owner.pid} is alive — refusing to unlock a live owner`,
    };
  }
  if (liveness === 'unknown') {
    return { ok: false, reason: `owner pid ${owner.pid} liveness is ambiguous — refusing` };
  }

  // Final re-read: only clear if the same dead owner still holds it.
  const confirm = readOwner({ lockDir });
  if (!confirm || confirm.token !== owner.token) {
    return { ok: false, reason: 'lock owner changed during unlock — refusing' };
  }

  rmSync(lockDir, { recursive: true, force: true });

  return { ok: true, reason: `cleared lock held by dead pid ${owner.pid}` };
};
