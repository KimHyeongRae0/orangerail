import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { verifyAudit } from '../src/audit/verify';
import { createEngine } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createMemoryStore } from '../src/store/memory';
import type { WhereClause } from '../src/types';
import { agent, csManager, productSchema } from './fixtures';

/**
 * The flagship fixture with one thing changed: the resolver returns whatever the
 * test hands it, including a row the declared schema refuses.
 *
 * The policy is the repo's own (`fixtures.ts:64`,
 * `where: { field: 'status', op: 'neq', value: 'soldout' }`) — the gate that was
 * measured permitting exactly the action it exists to stop.
 */
const buildFixture = ({
  row,
  where = { field: 'status', op: 'neq', value: 'soldout' },
  schema = productSchema,
  approval = true,
}: {
  row: unknown;
  /** `null` means the action declares no gate at all — `undefined` would take the default. */
  where?: WhereClause | null;
  schema?: z.ZodType;
  approval?: boolean;
}) => {
  const registry = createRegistry();
  let reads = 0;

  const Product = registry.defineObject({
    name: 'Product',
    schema,
    resolve: {
      get: async () => {
        reads += 1;

        return row as never;
      },
    },
  });

  registry.defineAction({
    name: 'issueCoupon',
    target: Product,
    targetIdFrom: 'productId',
    input: z.object({ productId: z.string(), amount: z.number() }),
    policy: {
      ...(approval ? { approval: 'required' as const, roles: ['cs-manager'] } : {}),
      ...(where === null ? {} : { where }),
    },
    execute: async ({ input }) => ({ couponId: `c-${(input as { productId: string }).productId}` }),
  });

  const store = createMemoryStore();

  return { registry, store, engine: createEngine({ registry, store }), reads: () => reads };
};

const stage = async ({ engine }: { engine: ReturnType<typeof createEngine> }) =>
  engine.stage({
    actionName: 'issueCoupon',
    input: { productId: 'p1', amount: 10 },
    caller: agent,
  });

describe('a target row that drifts from its declared schema (ONT-074)', () => {
  // The control. On `062e527` this was the ONLY one of the four that refused.
  it('still refuses a conforming row whose condition does not hold', async () => {
    const { engine } = buildFixture({ row: { id: 'p1', title: 'Widget', status: 'soldout' } });

    expect((await stage({ engine })).status).toBe('rejected_where');
  });

  it('still stages a conforming row whose condition holds', async () => {
    const { engine } = buildFixture({ row: { id: 'p1', title: 'Widget', status: 'active' } });

    expect((await stage({ engine })).status).toBe('approval_pending');
  });

  // AC-1 — the measured case. `undefined !== 'soldout'` is `true`, so the clause
  // written to stop the action permitted it, and it executed.
  it('AC-1: refuses when the field the clause reads is absent', async () => {
    const { engine, store } = buildFixture({ row: { id: 'p1', title: 'Widget' } });

    const staged = await stage({ engine });

    expect(staged.status).toBe('target_nonconforming');
    expect(staged).toMatchObject({ field: 'status' });

    const audit = await store.readAudit({});

    expect(audit.items.map((record) => record.phase)).toEqual(['target_nonconforming']);
    expect(audit.items[0]?.error).toContain('`status`');
    expect(audit.items[0]?.error).toContain('not what Product declares');
  });

  // AC-2 — present, wrong type. JSON serializes it cleanly, so nothing
  // downstream noticed either.
  it('AC-2: refuses when the field the clause reads is the wrong type', async () => {
    const { engine } = buildFixture({
      row: { id: 'p1', title: 'Widget', status: { code: 'soldout' } },
    });

    const staged = await stage({ engine });

    expect(staged.status).toBe('target_nonconforming');
    expect(staged).toMatchObject({ field: 'status' });
  });

  // AC-3 — the no-over-refusal criterion. This is what keeps AC-1 from being a
  // breaking change: the clause reads `status`, and `title` is none of its
  // business.
  it('AC-3: passes a row that fails its schema in a field the clause never reads', async () => {
    const { engine } = buildFixture({ row: { id: 'p1', title: 7, status: 'active' } });

    expect((await stage({ engine })).status).toBe('approval_pending');
  });

  it('AC-3: a row drifted elsewhere is still refused when its condition holds against it', async () => {
    const { engine } = buildFixture({ row: { id: 'p1', title: 7, status: 'soldout' } });

    expect((await stage({ engine })).status).toBe('rejected_where');
  });

  // AC-4 — the two refusals are different repairs and must not share a name.
  it('AC-4: the refusal is distinguishable from rejected_where and names the field', async () => {
    const drifted = await stage({ engine: buildFixture({ row: { id: 'p1', title: 'W' } }).engine });
    const refused = await stage({
      engine: buildFixture({ row: { id: 'p1', title: 'W', status: 'soldout' } }).engine,
    });

    expect(drifted.status).not.toBe(refused.status);
    expect(drifted).toMatchObject({ status: 'target_nonconforming', field: 'status' });
    expect(refused.status).toBe('rejected_where');
  });

  it('AC-4: the reason names the object and carries zod own sentence', async () => {
    const staged = await stage({ engine: buildFixture({ row: { id: 'p1', title: 'W' } }).engine });

    expect(staged).toMatchObject({ status: 'target_nonconforming' });
    expect('reason' in staged ? staged.reason : '').toContain('not what Product declares');
  });

  // AC-6 — an ungated action pays nothing for this ticket.
  it('AC-6: an action with no where clause reads nothing at staging', async () => {
    const { engine, reads } = buildFixture({
      row: { id: 'p1', title: 'Widget' },
      where: null,
      approval: true,
    });

    expect((await stage({ engine })).status).toBe('approval_pending');
    expect(reads()).toBe(0);
  });

  it('AC-6: an ungated auto action executes on a drifted row exactly as before', async () => {
    const { engine } = buildFixture({
      row: { id: 'p1', title: 'Widget' },
      where: null,
      approval: false,
    });

    expect((await stage({ engine })).status).toBe('executed');
  });

  // A functional predicate is delegated verbatim and stays uncovered — the
  // engine cannot know which fields it reads (§2, and said out loud here).
  it('leaves a functional where predicate uncovered, deliberately', async () => {
    const { engine } = buildFixture({
      row: { id: 'p1', title: 'Widget' },
      where: ({ object }) => (object as { status?: string }).status !== 'soldout',
    });

    expect((await stage({ engine })).status).toBe('approval_pending');
  });

  // §4: an optional field that is absent is conforming, and the behaviour is
  // today's.
  it('passes an absent field the schema declares optional', async () => {
    const { engine } = buildFixture({
      row: { id: 'p1', title: 'Widget' },
      schema: z.object({
        id: z.string(),
        title: z.string(),
        status: z.enum(['draft', 'active', 'soldout']).optional(),
      }),
    });

    expect((await stage({ engine })).status).toBe('approval_pending');
  });

  // §4: a throwing getter is arbitrary user code and lands on the existing
  // resolve_error path rather than escaping.
  it('routes a parse that throws to resolve_error', async () => {
    const { engine, store } = buildFixture({
      row: {
        id: 'p1',
        title: 'Widget',
        get status(): string {
          throw new Error('column dropped');
        },
      },
    });

    const staged = await stage({ engine });

    expect(staged.status).toBe('resolve_error');

    const audit = await store.readAudit({});

    expect(audit.items.map((record) => record.phase)).toEqual(['resolve_error']);
  });

  // §4: a null row already fails closed at `where.ts:42` and is unchanged.
  it('leaves a null row on the existing fail-closed path', async () => {
    const { engine, store } = buildFixture({ row: null });

    expect((await stage({ engine })).status).toBe('rejected_where');

    const audit = await store.readAudit({});

    expect(audit.items.map((record) => record.phase)).toEqual(['rejected_where']);
  });

  // §4: extra keys are stripped and must not become a refusal.
  it('passes a row carrying a column the ontology does not name', async () => {
    const { engine } = buildFixture({
      row: { id: 'p1', title: 'Widget', status: 'active', internalNote: 'x' },
    });

    expect((await stage({ engine })).status).toBe('approval_pending');
  });

  it('refuses a row that is not an object at all', async () => {
    const { engine } = buildFixture({ row: 'a string' });

    expect((await stage({ engine })).status).toBe('target_nonconforming');
  });
});

describe('the same refusal on the execute re-evaluation (ONT-074)', () => {
  /** Stage against a conforming row, then let the datasource drift under it. */
  const stageThenDrift = async () => {
    const registry = createRegistry();
    let row: unknown = { id: 'p1', title: 'Widget', status: 'active' };

    const Product = registry.defineObject({
      name: 'Product',
      schema: productSchema,
      resolve: { get: async () => row as never },
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
      execute: async () => ({ couponId: 'c-p1' }),
    });

    const store = createMemoryStore();
    const engine = createEngine({ registry, store });

    const staged = await stage({ engine });
    if (staged.status !== 'approval_pending') {
      throw new Error(`expected approval_pending, got ${staged.status}`);
    }

    await engine.approve({ approvalId: staged.approvalId, approver: csManager });

    row = { id: 'p1', title: 'Widget' };

    return { engine, store, approvalId: staged.approvalId };
  };

  it('refuses at execute and nothing runs', async () => {
    const { engine, approvalId } = await stageThenDrift();

    const executed = await engine.execute({ approvalId });

    expect(executed).toMatchObject({ status: 'target_nonconforming', field: 'status' });
  });

  it('records the refusal and spends the approval, as condition_changed does', async () => {
    const { engine, store, approvalId } = await stageThenDrift();

    await engine.execute({ approvalId });

    const audit = await store.readAudit({});

    expect(audit.items.map((record) => record.phase)).toEqual([
      'staged',
      'approved',
      'target_nonconforming',
    ]);
    expect((await store.getApproval({ id: approvalId }))?.status).toBe('consumed');
  });

  // The refusal is a pre-execute abort that consumes, so `verifyAudit` has to
  // count it as accounted-for — otherwise every drifted-row refusal reads as a
  // chain integrity failure.
  it('leaves a chain that verifies', async () => {
    const { engine, store, approvalId } = await stageThenDrift();

    await engine.execute({ approvalId });

    const verdict = await verifyAudit({ store });

    expect(verdict.issues).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(approvalId).toBeTruthy();
  });
});

describe('the audit prior of a drifted row (ONT-074 section 4)', () => {
  /**
   * A row nonconforming in a field the clause does NOT read: the gate passes
   * (AC-3) and the write happens, so this is the one path where a nonconforming
   * row still reaches the recoverability record.
   */
  const executeOverDriftedRow = async ({
    redactAudit,
  }: {
    redactAudit?: (args: { actionName: string; input: unknown }) => unknown;
  } = {}) => {
    const registry = createRegistry();

    const Product = registry.defineObject({
      name: 'Product',
      schema: productSchema,
      resolve: { get: async () => ({ id: 'p1', status: 'active' }) as never },
    });

    registry.defineAction({
      name: 'issueCoupon',
      target: Product,
      targetIdFrom: 'productId',
      input: z.object({ productId: z.string(), amount: z.number() }),
      policy: { where: { field: 'status', op: 'neq', value: 'soldout' } },
      execute: async () => ({ couponId: 'c-p1' }),
    });

    const store = createMemoryStore();
    const engine = createEngine({ registry, store, ...(redactAudit ? { redactAudit } : {}) });

    await stage({ engine });

    const audit = await store.readAudit({});

    return audit.items.find((record) => record.phase === 'execution_started')?.prior;
  };

  it('records the row verbatim and says it is not what the object declares', async () => {
    const prior = await executeOverDriftedRow();

    expect(prior).toMatchObject({ state: 'value', value: { id: 'p1', status: 'active' } });
    expect(prior && 'nonconforming' in prior ? prior.nonconforming : undefined).toEqual([
      { path: ['title'], message: expect.any(String) },
    ]);
  });

  it('drops the finding when redaction withheld the row', async () => {
    const prior = await executeOverDriftedRow({ redactAudit: ({ input }) => input });

    expect(prior).toEqual({ state: 'withheld' });
  });

  it('says nothing about a conforming row', async () => {
    const registry = createRegistry();

    const Product = registry.defineObject({
      name: 'Product',
      schema: productSchema,
      resolve: { get: async () => ({ id: 'p1', title: 'Widget', status: 'active' }) as never },
    });

    registry.defineAction({
      name: 'issueCoupon',
      target: Product,
      targetIdFrom: 'productId',
      input: z.object({ productId: z.string(), amount: z.number() }),
      policy: { where: { field: 'status', op: 'neq', value: 'soldout' } },
      execute: async () => ({ couponId: 'c-p1' }),
    });

    const store = createMemoryStore();

    await stage({ engine: createEngine({ registry, store }) });

    const audit = await store.readAudit({});
    const prior = audit.items.find((record) => record.phase === 'execution_started')?.prior;

    expect(prior).toEqual({
      state: 'value',
      value: { id: 'p1', title: 'Widget', status: 'active' },
    });
  });
});
