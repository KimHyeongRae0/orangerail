import { describe, expect, it } from 'vitest';

import { verifyAudit } from '../src/audit/verify';
import { createMemoryStore } from '../src/store/memory';
import { agent, buildCouponFixture, csManager, csManager2 } from './fixtures';

const stage = async () => {
  const fixture = buildCouponFixture();
  const staged = await fixture.engine.stage({
    actionName: 'issueCoupon',
    input: { productId: 'p1', amount: 2 },
    caller: agent,
  });
  if (staged.status !== 'approval_pending') {
    throw new Error('staging failed');
  }

  return { ...fixture, approvalId: staged.approvalId };
};

describe('approval CAS — single winner', () => {
  it('resolves exactly one winner under concurrent approves (rest already_resolved)', async () => {
    const { engine, approvalId } = await stage();

    const results = await Promise.all([
      engine.approve({ approvalId, approver: csManager }),
      engine.approve({ approvalId, approver: csManager2 }),
      engine.approve({ approvalId, approver: csManager }),
    ]);

    const approved = results.filter((r) => r.status === 'approved');
    const already = results.filter((r) => r.status === 'already_resolved');

    expect(approved).toHaveLength(1);
    expect(already).toHaveLength(2);
  });
});

describe('consume CAS — single winner (double-execute race)', () => {
  it('executes exactly once under concurrent execute calls', async () => {
    const { engine, store, approvalId } = await stage();
    await engine.approve({ approvalId, approver: csManager });

    const results = await Promise.all([
      engine.execute({ approvalId }),
      engine.execute({ approvalId }),
      engine.execute({ approvalId }),
    ]);

    const executed = results.filter((r) => r.status === 'executed');
    const consumeFailed = results.filter((r) => r.status === 'consume_failed');

    expect(executed).toHaveLength(1);
    expect(consumeFailed).toHaveLength(2);

    // ONT-069: the claim now happens AFTER `execution_started` is durable, so
    // the losers each wrote one. Exactly one execution ran, the losers say so,
    // and the chain that records the race verifies — a legitimate race must not
    // read as a replayed approval.
    const phases = (await store.readAudit({})).items.map((record) => record.phase);
    expect(phases.filter((phase) => phase === 'execution_started')).toHaveLength(3);
    expect(phases.filter((phase) => phase === 'execution_aborted')).toHaveLength(2);
    expect(phases.filter((phase) => phase === 'succeeded')).toHaveLength(1);

    const verdict = await verifyAudit({ store });
    expect(verdict.issues).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('does not let a race loser stand in for an attempt that died mid-execution', async () => {
    // Two attempts, one abort, no outcome: the winner started and never
    // finished. Pairing counts closers against starts, so the loser's abort
    // cannot cover for it.
    const store = createMemoryStore();
    for (const phase of [
      'staged',
      'approved',
      'execution_started',
      'execution_started',
      'execution_aborted',
    ] as const) {
      await store.appendAudit({
        record: { phase, actionName: 'a', approvalId: 'y', timestamp: new Date().toISOString() },
      });
    }

    const verdict = await verifyAudit({ store });
    expect(verdict.issues.some((issue) => issue.includes('incomplete execution for y'))).toBe(true);
    expect(verdict.issues.some((issue) => issue.includes('replayed approval y'))).toBe(false);
  });

  it('reports a re-armed approval as a replay even though races are tolerated', async () => {
    // The subtraction that makes the race clean must not blunt the tamper tell:
    // a second execution with no abort behind it is still a replay.
    const store = createMemoryStore();
    for (const phase of ['staged', 'approved', 'execution_started', 'succeeded'] as const) {
      await store.appendAudit({
        record: { phase, actionName: 'a', approvalId: 'x', timestamp: new Date().toISOString() },
      });
    }
    for (const phase of ['execution_started', 'succeeded'] as const) {
      await store.appendAudit({
        record: { phase, actionName: 'a', approvalId: 'x', timestamp: new Date().toISOString() },
      });
    }

    const verdict = await verifyAudit({ store });
    expect(verdict.issues.some((issue) => issue.includes('replayed approval x'))).toBe(true);
  });
});
