import { describe, expect, it } from 'vitest';

import { GENESIS_HASH } from '../src/audit/chain';
import { verifyAudit } from '../src/audit/verify';
import { createEngine } from '../src/lifecycle/engine';
import { createMemoryStore } from '../src/store/memory';
import { agent, buildCouponFixture, csManager, wrapStoreThrowingOn } from './fixtures';

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
