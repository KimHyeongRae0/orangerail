import { describe, expect, it } from 'vitest';

import { GENESIS_HASH } from '../src/audit/chain';
import { verifyAudit } from '../src/audit/verify';
import { createEngine } from '../src/lifecycle/engine';
import { createMemoryStore } from '../src/store/memory';
import type { AuditHead, Store } from '../src/store/contract';
import { agent, buildCouponFixture, csManager, wrapStoreThrowingOn } from './fixtures';

const ts = (): string => new Date().toISOString();

/** Append `phases` as bare audit records; returns the resulting chain. */
const appendPhases = async ({ store, phases }: { store: Store; phases: string[] }) => {
  for (const phase of phases) {
    await store.appendAudit({
      record: { phase: phase as never, actionName: 'a', timestamp: ts() },
    });
  }

  return (await store.readAudit({})).items;
};

describe('audit chain (AC-7)', () => {
  it('verifies an empty store', async () => {
    const store = createMemoryStore();
    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(true);
    expect(verdict.count).toBe(0);
  });

  it('anchors the first record to the genesis prev-hash and chains subsequent records', async () => {
    const store = createMemoryStore();
    const first = await store.appendAudit({
      record: { phase: 'staged', actionName: 'a', timestamp: new Date().toISOString() },
    });
    const second = await store.appendAudit({
      record: { phase: 'approved', actionName: 'a', timestamp: new Date().toISOString() },
    });

    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect((await verifyAudit({ store })).ok).toBe(true);
  });

  it('detects tampering with a recorded field', async () => {
    const store = createMemoryStore();
    await store.appendAudit({
      record: {
        phase: 'succeeded',
        actionName: 'a',
        result: { amount: 10 },
        timestamp: new Date().toISOString(),
      },
    });

    const page = await store.readAudit({});
    const record = page.items[0];
    if (!record) {
      throw new Error('no record');
    }
    record.result = { amount: 999 };

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.includes('tampered'))).toBe(true);
  });

  it('detects a started-but-unfinished execution (fail-closed detection)', async () => {
    // A store that drops the terminal append after execute runs: the side
    // effect happened, but only execution_started survives -> verify must flag.
    const base = createMemoryStore();
    const store = wrapStoreThrowingOn({ base, phases: ['succeeded', 'failed'] });

    const fixture = buildCouponFixture();
    const engine = createEngine({ registry: fixture.registry, store });

    const staged = await engine.stage({
      actionName: 'issueCoupon',
      input: { productId: 'p1', amount: 1 },
      caller: agent,
    });
    if (staged.status !== 'approval_pending') {
      throw new Error('staging failed');
    }
    await engine.approve({ approvalId: staged.approvalId, approver: csManager });

    const executed = await engine.execute({ approvalId: staged.approvalId });
    expect(executed.status).toBe('executed');

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.includes('incomplete execution'))).toBe(true);
  });
});

describe('audit anchored-head checkpoint (§3.1, AC-1..AC-3)', () => {
  it('flags a tail-truncated chain against the anchored head (H-AUDIT PoC replay)', async () => {
    const store = createMemoryStore();
    const full = await appendPhases({
      store,
      phases: ['staged', 'approved', 'execution_started', 'succeeded'],
    });
    expect((await verifyAudit({ store })).ok).toBe(true);

    // A store whose on-disk chain lost its tail but whose anchored head still
    // records the full length — the exact PoC (drop the terminal + started).
    const truncated: Store = {
      ...store,
      readAudit: async () => ({ items: full.slice(0, full.length - 2) }),
    };

    const verdict = await verifyAudit({ store: truncated });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.includes('truncated'))).toBe(true);
  });

  it('tolerates a chain one record ahead of the checkpoint (crash window, no false positive)', async () => {
    const store = createMemoryStore();
    const full = await appendPhases({ store, phases: ['staged', 'approved', 'execution_started'] });

    // Simulate the single crash-between-append-and-head-write window: the chain
    // is one record longer than the persisted checkpoint. Containment passes.
    const last = full[full.length - 2];
    if (!last) {
      throw new Error('no penultimate record');
    }
    const staleHead: AuditHead = { seq: last.seq, hash: last.hash, count: full.length - 1 };
    const view: Store = { ...store, readAuditHead: async () => staleHead };

    expect((await verifyAudit({ store: view })).ok).toBe(true);
  });

  it('flags a diverged anchored head (hash mismatch at the checkpoint seq)', async () => {
    const store = createMemoryStore();
    await appendPhases({ store, phases: ['staged', 'approved'] });

    const view: Store = {
      ...store,
      readAuditHead: async () => ({ seq: 2, hash: 'deadbeef', count: 2 }),
    };

    const verdict = await verifyAudit({ store: view });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.includes('diverged'))).toBe(true);
  });

  it('fails closed when the anchored head is missing on a non-empty chain', async () => {
    const store = createMemoryStore();
    await appendPhases({ store, phases: ['staged'] });

    const view: Store = { ...store, readAuditHead: async () => null };

    const verdict = await verifyAudit({ store: view });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.includes('checkpoint missing'))).toBe(true);
  });

  it('flags an auto execution_started with no terminal via its correlationId', async () => {
    const store = createMemoryStore();
    await store.appendAudit({
      record: {
        phase: 'execution_started',
        actionName: 'auto',
        correlationId: 'corr-1',
        timestamp: ts(),
      },
    });

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.includes('incomplete execution'))).toBe(true);
  });
});
