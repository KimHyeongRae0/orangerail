/**
 * ONT-002 e2e scenario (driven by tests/e2e/ONT-002-core-lifecycle.sh via tsx).
 *
 * Exercises the governed action lifecycle end-to-end against the in-memory
 * store, importing orangerail-core straight from source:
 *
 *   Scenario 1 (happy path + authorization):
 *     define Product (mutable in-memory backend) + issueCoupon (approval
 *     required, roles ['cs-manager'], where status neq 'soldout')
 *     -> stage as an authenticated non-approver     => approval_pending
 *     -> approve with the WRONG role                => rejected
 *     -> approve with cs-manager                    => wins
 *     -> execute (authoritative re-eval passes)     => executed
 *     -> audit chain verifies
 *
 *   Scenario 2 (TOCTOU condition_changed):
 *     stage -> approve -> mutate backend status to 'soldout' -> execute
 *     => condition_changed, audited, approval stays consumed.
 *
 * The script throws on any unmet assertion so a failure surfaces as a non-zero
 * exit (the RED signal before the engine modules exist).
 */
import { z } from 'zod';

import {
  createEngine,
  createMemoryStore,
  createRegistry,
  verifyAudit,
  type Identity,
} from '../../packages/core/src/index.ts';

const assert = ({ cond, msg }: { cond: unknown; msg: string }): void => {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${msg}`);
  }

  console.log(`  ok: ${msg}`);
};

type ProductRow = { id: string; title: string; status: 'draft' | 'active' | 'soldout' };

const agent: Identity = { subject: 'agent-1', roles: ['viewer'] };
const wrongApprover: Identity = { subject: 'bob', roles: ['ops'] };
const csManager: Identity = { subject: 'alice', roles: ['cs-manager'] };

const buildFixture = () => {
  const backend = new Map<string, ProductRow>();
  backend.set('p1', { id: 'p1', title: 'Widget', status: 'active' });

  const registry = createRegistry();

  const Product = registry.defineObject({
    name: 'Product',
    schema: z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(['draft', 'active', 'soldout']),
    }),
    resolve: {
      get: async ({ id }: { id: string }) => backend.get(id) ?? null,
    },
  });

  registry.defineAction({
    name: 'issueCoupon',
    target: Product,
    targetIdFrom: 'productId',
    input: z.object({ productId: z.string(), amount: z.number() }),
    policy: {
      approval: 'required',
      roles: ['cs-manager'],
      where: { field: 'status', op: 'neq', value: 'soldout' },
    },
    execute: async ({ input }) => ({ couponId: `c-${input.productId}`, amount: input.amount }),
  });

  const store = createMemoryStore();
  const engine = createEngine({ registry, store });

  return { backend, store, engine };
};

const scenarioHappyPath = async (): Promise<void> => {
  console.log('\n== Scenario 1: staging -> role-gated approval -> execute -> audit verify ==');
  const { store, engine } = buildFixture();

  const staged = await engine.stage({
    actionName: 'issueCoupon',
    input: { productId: 'p1', amount: 10 },
    caller: agent,
  });
  assert({
    cond: staged.status === 'approval_pending',
    msg: 'non-approver staging yields approval_pending',
  });
  if (staged.status !== 'approval_pending') {
    return;
  }

  const approvalId = staged.approvalId;

  const wrong = await engine.approve({ approvalId, approver: wrongApprover });
  assert({ cond: wrong.status === 'rejected_role', msg: 'wrong-role approve is rejected' });

  const right = await engine.approve({ approvalId, approver: csManager });
  assert({ cond: right.status === 'approved', msg: 'cs-manager approve wins' });

  const executed = await engine.execute({ approvalId });
  assert({
    cond: executed.status === 'executed',
    msg: 'execute succeeds after authoritative re-eval',
  });
  if (executed.status === 'executed') {
    const result = executed.result as { couponId: string };
    assert({ cond: result.couponId === 'c-p1', msg: 'execute returns the coupon result' });
  }

  const verdict = await verifyAudit({ store });
  assert({
    cond: verdict.ok,
    msg: 'audit chain verifies (no tampering, no incomplete executions)',
  });
};

const scenarioConditionChanged = async (): Promise<void> => {
  console.log('\n== Scenario 2: stage -> approve -> backend goes soldout -> condition_changed ==');
  const { backend, store, engine } = buildFixture();

  const staged = await engine.stage({
    actionName: 'issueCoupon',
    input: { productId: 'p1', amount: 5 },
    caller: agent,
  });
  assert({ cond: staged.status === 'approval_pending', msg: 'staging yields approval_pending' });
  if (staged.status !== 'approval_pending') {
    return;
  }

  const approvalId = staged.approvalId;

  const approved = await engine.approve({ approvalId, approver: csManager });
  assert({ cond: approved.status === 'approved', msg: 'cs-manager approve wins' });

  const row = backend.get('p1');
  if (row) {
    row.status = 'soldout';
  }

  const executed = await engine.execute({ approvalId });
  assert({
    cond: executed.status === 'condition_changed',
    msg: 'execute is refused with condition_changed on drift',
  });

  const consumed = await store.getApproval({ id: approvalId });
  assert({
    cond: consumed?.status === 'consumed',
    msg: 'approval stays consumed after condition_changed',
  });

  const retry = await engine.execute({ approvalId });
  assert({
    cond: retry.status === 'consume_failed',
    msg: 'a second execute cannot re-consume the approval',
  });

  const audit = await store.readAudit({});
  const hasConditionChanged = audit.items.some((r) => r.phase === 'condition_changed');
  assert({ cond: hasConditionChanged, msg: 'condition_changed is audited' });

  const verdict = await verifyAudit({ store });
  assert({ cond: verdict.ok, msg: 'audit chain verifies after condition_changed' });
};

const main = async (): Promise<void> => {
  await scenarioHappyPath();
  await scenarioConditionChanged();
  console.log('\nALL ONT-002 LIFECYCLE SCENARIOS PASSED');
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
