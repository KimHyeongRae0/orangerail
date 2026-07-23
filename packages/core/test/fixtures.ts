import { z } from 'zod';

import { createEngine } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createMemoryStore } from '../src/store/memory';
import type { AuditInput, AuditPhase, Store } from '../src/store/contract';
import type { Identity } from '../src/types';

/** Authenticated caller WITHOUT the approver role — may still stage (§4.5 step 0). */
export const agent: Identity = { subject: 'agent-1', roles: ['viewer'] };

/**
 * A SECOND authenticated identity (distinct subject) — used where a test needs
 * a non-dev approver that is not the requester (separation of duty, §3.4).
 */
export const agent2: Identity = { subject: 'agent-2', roles: ['viewer'] };

/** An approver holding the required `cs-manager` role. */
export const csManager: Identity = { subject: 'alice', roles: ['cs-manager'] };

/** A second `cs-manager` approver (approval-race tests). */
export const csManager2: Identity = { subject: 'carol', roles: ['cs-manager'] };

/** An authenticated approver WITHOUT the required role. */
export const wrongApprover: Identity = { subject: 'bob', roles: ['ops'] };

/** A dev-mode identity — holds all roles implicitly, stamps `devMode`. */
export const devIdentity: Identity = { subject: 'local-dev', roles: [], devMode: true };

export type ProductRow = { id: string; title: string; status: 'draft' | 'active' | 'soldout' };

export const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'active', 'soldout']),
});

export const couponInput = z.object({ productId: z.string(), amount: z.number() });

/**
 * The flagship fixture: Product (mutable in-memory backend) + issueCoupon
 * (approval required, roles ['cs-manager'], where status neq 'soldout').
 */
export const buildCouponFixture = () => {
  const backend = new Map<string, ProductRow>();
  backend.set('p1', { id: 'p1', title: 'Widget', status: 'active' });

  const registry = createRegistry();

  const Product = registry.defineObject({
    name: 'Product',
    schema: productSchema,
    resolve: {
      get: async ({ id }) => backend.get(id) ?? null,
    },
  });

  registry.defineAction({
    name: 'issueCoupon',
    target: Product,
    targetIdFrom: 'productId',
    input: couponInput,
    policy: {
      approval: 'required',
      roles: ['cs-manager'],
      where: { field: 'status', op: 'neq', value: 'soldout' },
    },
    execute: async ({ input }) => ({ couponId: `c-${input.productId}`, amount: input.amount }),
  });

  const store = createMemoryStore();
  const engine = createEngine({ registry, store });

  return { backend, registry, store, engine, Product };
};

/**
 * An approval-required action with NO `roles` — any authenticated identity may
 * approve (§4.6). No `where`, so no target is required.
 */
export const buildNoRolesFixture = () => {
  const registry = createRegistry();

  registry.defineAction({
    name: 'noteAction',
    input: z.object({ note: z.string() }),
    policy: { approval: 'required' },
    execute: async ({ input }) => ({ noted: input.note }),
  });

  const store = createMemoryStore();
  const engine = createEngine({ registry, store });

  return { registry, store, engine };
};

/** Wrap a store so `appendAudit` throws for a specific phase (fail-closed tests). */
export const wrapStoreThrowingOn = ({
  base,
  phases,
}: {
  base: Store;
  phases: AuditPhase[];
}): Store => ({
  ...base,
  appendAudit: async ({ record }: { record: AuditInput }) => {
    if (phases.includes(record.phase)) {
      throw new Error(`audit append blocked for phase ${record.phase}`);
    }

    return base.appendAudit({ record });
  },
});
