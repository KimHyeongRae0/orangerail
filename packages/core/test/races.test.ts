import { describe, expect, it } from 'vitest';

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
    const { engine, approvalId } = await stage();
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
  });
});
