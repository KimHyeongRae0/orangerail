import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { verifyAudit } from '../src/audit/verify';
import { createEngine, maskAuditPrior, readActionPrior } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createMemoryStore } from '../src/store/memory';
import type { AuditPrior, AuditRecord, Store } from '../src/store/contract';
import type { Identity } from '../src/types';

const caller: Identity = { subject: 'agent-1', roles: ['viewer'] };
const approver: Identity = { subject: 'alice', roles: ['cs-manager'] };

type ProductRow = { id: string; sku: string; title: string; price_cents: number; stock: number };

const productSchema = z.object({
  id: z.string(),
  sku: z.string(),
  title: z.string(),
  price_cents: z.number(),
  stock: z.number(),
});

/**
 * The ticket's own evidence, reproduced: a Product table, an `updateProduct`
 * write, and `p3.stock` sitting at `0` before the call that sets it to `25`.
 * `reads` counts every `resolve.get` so the cost claims are measured rather than
 * asserted.
 */
const buildProductFixture = ({
  approval = false,
  where = false,
  failRead = false,
}: {
  approval?: boolean;
  where?: boolean;
  failRead?: boolean;
} = {}) => {
  const backend = new Map<string, ProductRow>();
  backend.set('p3', {
    id: 'p3',
    sku: 'SKU-CABLE',
    title: 'USB-C cable',
    price_cents: 1500,
    stock: 0,
  });

  const reads: string[] = [];
  const registry = createRegistry();

  const Product = registry.defineObject({
    name: 'Product',
    schema: productSchema,
    resolve: {
      get: async ({ id }) => {
        reads.push(id);

        if (failRead) {
          throw new Error('connection terminated unexpectedly');
        }

        return backend.get(id) ?? null;
      },
    },
  });

  registry.defineAction({
    name: 'updateProduct',
    target: Product,
    targetIdFrom: 'id',
    input: z.object({ id: z.string(), stock: z.number() }),
    policy: {
      ...(approval ? { approval: 'required' as const, roles: ['cs-manager'] } : {}),
      ...(where ? { where: { field: 'stock', op: 'gte', value: 0 } } : {}),
    },
    execute: async ({ input }) => {
      const row = backend.get(input.id);
      if (!row) {
        throw new Error('no such product');
      }

      const next = { ...row, stock: input.stock };
      backend.set(input.id, next);

      return next;
    },
  });

  // A create: no pre-existing instance, so no target — the shape codegen emits.
  registry.defineAction({
    name: 'createProduct',
    input: z.object({ sku: z.string() }),
    execute: async ({ input }) => ({ id: 'p9', sku: input.sku }),
  });

  const store = createMemoryStore();

  return { backend, reads, registry, store, Product };
};

const started = ({ records }: { records: AuditRecord[] }): AuditRecord => {
  const record = records.find((entry) => entry.phase === 'execution_started');
  if (!record) {
    throw new Error('no execution_started record');
  }

  return record;
};

const readRecords = async ({ store }: { store: Store }): Promise<AuditRecord[]> =>
  (await store.readAudit({})).items;

describe('audit prior state — the un-gated update is now recoverable (§3.11 / ONT-057)', () => {
  it('records the row as it stood before the write, so the change can be described and undone', async () => {
    const { store, registry, backend, reads } = buildProductFixture();
    const engine = createEngine({ registry, store });

    const result = await engine.stage({
      actionName: 'updateProduct',
      input: { id: 'p3', stock: 25 },
      caller,
    });
    expect(result.status).toBe('executed');

    const records = await readRecords({ store });
    const prior = started({ records }).prior;

    expect(prior).toEqual({
      state: 'value',
      value: { id: 'p3', sku: 'SKU-CABLE', title: 'USB-C cable', price_cents: 1500, stock: 0 },
    });

    // The recoverability claim, exercised: the chain alone is enough to restore
    // the row, with no access to anything but the audit log.
    const before = (prior as { state: 'value'; value: ProductRow }).value;
    backend.set(before.id, before);
    expect(backend.get('p3')?.stock).toBe(0);

    // Cost: exactly one extra read for an un-gated action, which is the case
    // this ticket exists for.
    expect(reads).toEqual(['p3']);
  });

  it('pairs with the terminal record on correlationId, so before/after is one join', async () => {
    const { store, registry } = buildProductFixture();
    const engine = createEngine({ registry, store });

    await engine.stage({ actionName: 'updateProduct', input: { id: 'p3', stock: 25 }, caller });

    const records = await readRecords({ store });
    const start = started({ records });
    const terminal = records.find((entry) => entry.phase === 'succeeded');

    expect(start.correlationId).toBeDefined();
    expect(terminal?.correlationId).toBe(start.correlationId);
    expect((terminal?.result as ProductRow).stock).toBe(25);
    // Deliberately NOT on the terminal record: that append is best-effort, and
    // losing the prior value in a crash is the case recovery is for.
    expect(terminal?.prior).toBeUndefined();
  });

  it('reuses the read the where gate performed, so a gated action pays nothing extra', async () => {
    const { store, registry, reads } = buildProductFixture({ approval: true, where: true });
    const engine = createEngine({ registry, store });

    const staged = await engine.stage({
      actionName: 'updateProduct',
      input: { id: 'p3', stock: 25 },
      caller,
    });
    if (staged.status !== 'approval_pending') {
      throw new Error('stage did not queue an approval');
    }

    const readsAfterStaging = reads.length;

    await engine.approve({ approvalId: staged.approvalId, approver });
    const executed = await engine.execute({ approvalId: staged.approvalId });
    expect(executed.status).toBe('executed');

    const records = await readRecords({ store });
    expect(started({ records }).prior).toEqual({
      state: 'value',
      value: { id: 'p3', sku: 'SKU-CABLE', title: 'USB-C cable', price_cents: 1500, stock: 0 },
    });

    // One read at re-evaluation time, shared by the gate and the record. The
    // recorded prior IS the row the gate approved.
    expect(reads.length - readsAfterStaging).toBe(1);
  });

  it('distinguishes "no prior row" from "could not read" from "nothing to read"', async () => {
    const { store, registry } = buildProductFixture();
    const engine = createEngine({ registry, store });

    // A create declares no target: nothing to read, and the record says so.
    await engine.stage({ actionName: 'createProduct', input: { sku: 'SKU-NEW' }, caller });

    // A target that exists but holds no such row: the read succeeded, the row did not.
    await engine.stage({ actionName: 'updateProduct', input: { id: 'ghost', stock: 1 }, caller });

    const records = await readRecords({ store });
    const priors = records
      .filter((entry) => entry.phase === 'execution_started')
      .map((entry) => entry.prior);

    expect(priors[0]).toEqual({ state: 'unavailable', reason: 'no_target' });
    expect(priors[1]).toEqual({ state: 'none' });
  });

  it('records "no_id" rather than reading a row the input never named', async () => {
    const { registry, reads } = buildProductFixture();
    const action = registry.getAction({ name: 'updateProduct' });
    if (!action) {
      throw new Error('action missing');
    }

    const prior = await readActionPrior({ action, input: { stock: 5 } });

    expect(prior).toEqual({ state: 'unavailable', reason: 'no_id' });
    expect(reads).toEqual([]);
  });

  it('lets the write succeed when the prior read throws, and says why the value is missing', async () => {
    const { store, registry, backend } = buildProductFixture({ failRead: true });
    const engine = createEngine({ registry, store });

    const result = await engine.stage({
      actionName: 'updateProduct',
      input: { id: 'p3', stock: 25 },
      caller,
    });

    // Constraint: a failed prior read must NOT become a failed write.
    expect(result.status).toBe('executed');
    expect(backend.get('p3')?.stock).toBe(25);

    const records = await readRecords({ store });
    expect(started({ records }).prior).toEqual({
      state: 'unreadable',
      error: 'connection terminated unexpectedly',
    });
  });
});

describe('audit prior state — redaction (§3.9 / ONT-057)', () => {
  /** A row carrying a column no input ever mentions — the leak this guards. */
  const buildSecretFixture = () => {
    const registry = createRegistry();

    const User = registry.defineObject({
      name: 'User',
      schema: z.object({ id: z.string(), email: z.string(), password_hash: z.string() }),
      resolve: {
        get: async ({ id }) => ({ id, email: 'a@example.com', password_hash: 'HASH-DO-NOT-LOG' }),
      },
    });

    registry.defineAction({
      name: 'updateUser',
      target: User,
      targetIdFrom: 'id',
      input: z.object({ id: z.string(), email: z.string() }),
      execute: async ({ input }) => ({ id: input.id, email: input.email }),
    });

    return { registry, store: createMemoryStore() };
  };

  it('withholds the row when redactAudit is configured and no redactPrior is', async () => {
    const { registry, store } = buildSecretFixture();
    const engine = createEngine({
      registry,
      store,
      redactAudit: ({ input }) => ({ ...(input as object), email: '***' }),
    });

    await engine.stage({
      actionName: 'updateUser',
      input: { id: 'u1', email: 'b@example.com' },
      caller,
    });

    const records = await readRecords({ store });
    expect(started({ records }).prior).toEqual({ state: 'withheld' });

    // The whole point: the column the input-shaped redactor knows nothing about
    // is nowhere in the audit log.
    expect(JSON.stringify(records)).not.toContain('HASH-DO-NOT-LOG');
  });

  it('masks the row with redactPrior when one is supplied', async () => {
    const { registry, store } = buildSecretFixture();
    const engine = createEngine({
      registry,
      store,
      redactAudit: ({ input }) => input,
      redactPrior: ({ prior }) => ({ ...(prior as object), password_hash: '***' }),
    });

    await engine.stage({
      actionName: 'updateUser',
      input: { id: 'u1', email: 'b@example.com' },
      caller,
    });

    const records = await readRecords({ store });
    expect(started({ records }).prior).toEqual({
      state: 'value',
      value: { id: 'u1', email: 'a@example.com', password_hash: '***' },
    });
    expect(JSON.stringify(records)).not.toContain('HASH-DO-NOT-LOG');
  });

  it('records the row verbatim when the project configured no redaction at all', async () => {
    const { registry, store } = buildSecretFixture();
    const engine = createEngine({ registry, store });

    await engine.stage({
      actionName: 'updateUser',
      input: { id: 'u1', email: 'b@example.com' },
      caller,
    });

    const records = await readRecords({ store });
    expect(
      (started({ records }).prior as { state: 'value'; value: { password_hash: string } }).value
        .password_hash,
    ).toBe('HASH-DO-NOT-LOG');
  });

  it('treats a redactPrior returning undefined as "withhold", never as an empty value', () => {
    const masked = maskAuditPrior({
      actionName: 'updateUser',
      prior: { state: 'value', value: { secret: 1 } },
      redactPrior: () => undefined,
    });

    expect(masked).toEqual({ state: 'withheld' });
  });

  it('leaves the non-value states alone, including the operator-facing read error', () => {
    const states: AuditPrior[] = [
      { state: 'none' },
      { state: 'unreadable', error: 'connection terminated unexpectedly' },
      { state: 'unavailable', reason: 'no_target' },
    ];

    for (const prior of states) {
      expect(maskAuditPrior({ actionName: 'a', prior, redactAudit: () => '[redacted]' })).toEqual(
        prior,
      );
    }
  });

  it('fails closed when redaction throws — no record, no write', async () => {
    const { registry, store } = buildSecretFixture();
    const engine = createEngine({
      registry,
      store,
      redactPrior: () => {
        throw new Error('redactor exploded');
      },
    });

    const result = await engine.stage({
      actionName: 'updateUser',
      input: { id: 'u1', email: 'b@example.com' },
      caller,
    });

    expect(result.status).toBe('audit_blocked');
    expect(await readRecords({ store })).toHaveLength(0);
  });
});

describe('audit prior state — chain compatibility (§3.5 / ONT-057)', () => {
  it('leaves records without a prior hashing exactly as before, and verifying clean', async () => {
    const store = createMemoryStore();

    // A 0.1.0-era record: no correlationId, no prior. Hand-appended so the shape
    // is the pre-upgrade one rather than whatever the current engine writes.
    await store.appendAudit({
      record: { phase: 'succeeded', actionName: 'legacy', timestamp: new Date().toISOString() },
    });

    const records = await readRecords({ store });
    expect(Object.keys(records[0] as object)).not.toContain('prior');
    expect((await verifyAudit({ store })).ok).toBe(true);
  });

  it('verifies a chain full of prior-carrying records', async () => {
    const { store, registry } = buildProductFixture();
    const engine = createEngine({ registry, store });

    await engine.stage({ actionName: 'updateProduct', input: { id: 'p3', stock: 25 }, caller });

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(true);
    expect(verdict.issues).toEqual([]);
  });

  it('brings the prior value under the chain hash — editing it is tampering', async () => {
    const { store, registry } = buildProductFixture();
    const engine = createEngine({ registry, store });

    await engine.stage({ actionName: 'updateProduct', input: { id: 'p3', stock: 25 }, caller });

    // Rewrite history to make the update look like it changed nothing.
    const records = await readRecords({ store });
    const target = started({ records });
    (target.prior as { state: 'value'; value: ProductRow }).value.stock = 25;

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.includes('tampered record'))).toBe(true);
  });
});
