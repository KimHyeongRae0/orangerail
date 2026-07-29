import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { verifyAudit } from '../src/audit/verify';
import { createEngine } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createMemoryStore } from '../src/store/memory';
import type { AuditRecord } from '../src/store/contract';
import { agent, csManager, wrapStoreThrowingOn } from './fixtures';

/**
 * A realistic driver message: names the client call, an absolute source path,
 * and the constraint. This is exactly the text a transport must not forward
 * (§3.10) and exactly the text an operator must still be able to read.
 */
const DRIVER_ERROR =
  'Invalid `prisma.order.update()` invocation in /srv/app/src/db/orders.ts:42:18 ' +
  'Foreign key constraint failed on the field: `Order_customerId_fkey (index)`';

/** An auto (ungated) action whose execute throws the driver error. */
const buildFailingAuto = () => {
  const registry = createRegistry();

  registry.defineAction({
    name: 'updateOrder',
    input: z.object({ orderId: z.string() }),
    execute: async () => {
      throw new Error(DRIVER_ERROR);
    },
  });

  return registry;
};

const readAll = async ({
  store,
}: {
  store: ReturnType<typeof createMemoryStore>;
}): Promise<AuditRecord[]> => (await store.readAudit({})).items;

describe('failure detail carries an audit lookup key (§3.10)', () => {
  it('returns the full error plus the correlationId that keys the auto-action audit records', async () => {
    const store = createMemoryStore();
    const engine = createEngine({ registry: buildFailingAuto(), store });

    const result = await engine.stage({
      actionName: 'updateOrder',
      input: { orderId: 'o1' },
      caller: agent,
    });

    if (result.status !== 'failed') {
      throw new Error(`expected failed, got ${result.status}`);
    }

    // Operator-facing: the engine keeps the text verbatim. Redaction is the
    // transport's job, so core must NOT pre-truncate it.
    expect(result.error).toBe(DRIVER_ERROR);
    expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/);

    // The id the caller is handed actually finds the record holding the text.
    const records = await readAll({ store });
    const failed = records.find((record) => record.phase === 'failed');
    const started = records.find((record) => record.phase === 'execution_started');

    expect(failed?.correlationId).toBe(result.correlationId);
    expect(started?.correlationId).toBe(result.correlationId);
    expect(failed?.error).toBe(DRIVER_ERROR);
  });

  it('uses the approvalId as the correlation key on the approval path', async () => {
    const registry = createRegistry();
    registry.defineAction({
      name: 'updateOrder',
      input: z.object({ orderId: z.string() }),
      policy: { approval: 'required', roles: ['cs-manager'] },
      execute: async () => {
        throw new Error(DRIVER_ERROR);
      },
    });

    const store = createMemoryStore();
    const engine = createEngine({ registry, store });

    const staged = await engine.stage({
      actionName: 'updateOrder',
      input: { orderId: 'o1' },
      caller: agent,
    });
    if (staged.status !== 'approval_pending') {
      throw new Error('staging failed');
    }

    await engine.approve({ approvalId: staged.approvalId, approver: csManager });
    const executed = await engine.execute({ approvalId: staged.approvalId });

    if (executed.status !== 'failed') {
      throw new Error(`expected failed, got ${executed.status}`);
    }

    expect(executed.correlationId).toBe(staged.approvalId);

    // The approval path keys its records on approvalId and mints no
    // correlationId, so those records hash exactly as they did before (§3.2).
    const failed = (await readAll({ store })).find((record) => record.phase === 'failed');
    expect(failed?.approvalId).toBe(staged.approvalId);
    expect(failed?.correlationId).toBeUndefined();
  });

  it('correlates a staging-time resolve_error without breaking audit verification', async () => {
    const registry = createRegistry();

    const Order = registry.defineObject({
      name: 'Order',
      schema: z.object({ id: z.string(), status: z.string() }),
      resolve: {
        get: async () => {
          throw new Error(DRIVER_ERROR);
        },
      },
    });

    registry.defineAction({
      name: 'updateOrder',
      target: Order,
      targetIdFrom: 'orderId',
      input: z.object({ orderId: z.string() }),
      policy: { approval: 'required', where: { field: 'status', op: 'eq', value: 'open' } },
      execute: async () => ({ ok: true }),
    });

    const store = createMemoryStore();
    const engine = createEngine({ registry, store });

    const result = await engine.stage({
      actionName: 'updateOrder',
      input: { orderId: 'o1' },
      caller: agent,
    });

    if (result.status !== 'resolve_error') {
      throw new Error(`expected resolve_error, got ${result.status}`);
    }

    const record = (await readAll({ store })).find((r) => r.phase === 'resolve_error');
    expect(record?.correlationId).toBe(result.correlationId);
    expect(record?.error).toBe(DRIVER_ERROR);

    // A correlated terminal record with no `execution_started` must not be read
    // as an unfinished execution — verify keys that pairing on
    // execution_started/succeeded/failed only.
    expect((await verifyAudit({ store })).ok).toBe(true);
  });

  it('correlates an audit_blocked refusal even though no audit record exists', async () => {
    const store = wrapStoreThrowingOn({
      base: createMemoryStore(),
      phases: ['execution_started'],
    });
    const engine = createEngine({ registry: buildFailingAuto(), store });

    const result = await engine.stage({
      actionName: 'updateOrder',
      input: { orderId: 'o1' },
      caller: agent,
    });

    if (result.status !== 'audit_blocked') {
      throw new Error(`expected audit_blocked, got ${result.status}`);
    }

    expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.error).toContain('audit append blocked');
    expect(await readAll({ store })).toHaveLength(0);
  });
});
