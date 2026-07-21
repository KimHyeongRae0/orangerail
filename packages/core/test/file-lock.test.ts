import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquireLock, releaseLock, unlockStore } from '../src/store/file-lock';

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'ont-003-lock-'));

/** A pid that is (almost certainly) not a live process on this host. */
const DEAD_PID = 2_147_483_646;

const fabricateLock = ({
  dir,
  pid,
  withOwner = true,
}: {
  dir: string;
  pid: number;
  withOwner?: boolean;
}) => {
  mkdirSync(dir, { recursive: true });
  const lockDir = join(dir, 'lock');
  mkdirSync(lockDir);

  if (withOwner) {
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid, token: 'fabricated', acquiredAt: new Date().toISOString() }),
    );
  }
};

describe('file lock — acquisition', () => {
  it('acquires an unheld lock and releases it', async () => {
    const dir = freshDir();
    const token = await acquireLock({ dir });
    expect(existsSync(join(dir, 'lock'))).toBe(true);

    releaseLock({ dir, token });
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  it('re-acquires after release (single mkdir winner semantics)', async () => {
    const dir = freshDir();
    const t1 = await acquireLock({ dir });
    releaseLock({ dir, token: t1 });
    const t2 = await acquireLock({ dir });
    expect(t2).not.toBe(t1);
    releaseLock({ dir, token: t2 });
  });
});

describe('file lock — fail-closed timeout, NEVER steals (§3.1)', () => {
  it('times out with a dead-owner diagnostic and does NOT steal the lock', async () => {
    const dir = freshDir();
    fabricateLock({ dir, pid: DEAD_PID });

    await expect(acquireLock({ dir, timeoutMs: 150 })).rejects.toThrow(
      /is dead — run `orangerail store unlock`/,
    );

    // No steal: the fabricated owner is untouched.
    const owner = JSON.parse(readFileSync(join(dir, 'lock', 'owner.json'), 'utf8'));
    expect(owner.pid).toBe(DEAD_PID);
    expect(owner.token).toBe('fabricated');
  });

  it('times out with a held diagnostic against a live owner', async () => {
    const dir = freshDir();
    fabricateLock({ dir, pid: process.pid });

    await expect(acquireLock({ dir, timeoutMs: 150 })).rejects.toThrow(/held by pid/);
  });

  it('reports a missing owner.json as held-by-unknown, never stale', async () => {
    const dir = freshDir();
    fabricateLock({ dir, pid: DEAD_PID, withOwner: false });

    await expect(acquireLock({ dir, timeoutMs: 150 })).rejects.toThrow(/unknown owner/);
  });
});

describe('store unlock — clears dead only (§3.1)', () => {
  it('clears a provably-dead owner lock', () => {
    const dir = freshDir();
    fabricateLock({ dir, pid: DEAD_PID });

    const result = unlockStore({ dir });
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  it('refuses a live owner', () => {
    const dir = freshDir();
    fabricateLock({ dir, pid: process.pid });

    const result = unlockStore({ dir });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/alive/);
    expect(existsSync(join(dir, 'lock'))).toBe(true);
  });

  it('refuses a missing owner.json', () => {
    const dir = freshDir();
    fabricateLock({ dir, pid: DEAD_PID, withOwner: false });

    const result = unlockStore({ dir });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing or unreadable/);
    expect(existsSync(join(dir, 'lock'))).toBe(true);
  });

  it('reports no lock held when there is none', () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });

    const result = unlockStore({ dir });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/no lock/);
  });
});
