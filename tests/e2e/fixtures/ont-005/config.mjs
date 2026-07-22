/**
 * ONT-005 e2e fixture — a full-feature ontology for the studio map mode
 * (plan section 7). It exercises every studio rendering path:
 *
 *   - an object with a resolve contract (get + list),
 *   - an object with a get-only resolve contract,
 *   - a resolve-less object,
 *   - an isolated object (no links, no actions) to prove the isolated group,
 *   - a hostile-named object whose name is an HTML/script payload that core
 *     validation accepts, to prove inert text rendering (AC-8),
 *   - two links of different cardinality,
 *   - a governed action (approval required + role),
 *   - a governed action with a declarative where clause,
 *   - an ungoverned (auto) action,
 *   - a target-less, not-implemented action (renders in the isolated group).
 *
 * The e2e copies this file into a scratch run directory and edits the copy to
 * prove live reload, so this source fixture stays pristine.
 */
import { createMemoryStore, createRegistry, notImplemented } from 'orangerail-core';
import { z } from 'zod';

const registry = createRegistry();

const product = registry.defineObject({
  name: 'product',
  schema: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    price: z.number().optional(),
  }),
  resolve: {
    get: async ({ id }) => ({ id, title: 'Sample', status: 'draft' }),
    list: async () => ({ items: [] }),
  },
});

const customer = registry.defineObject({
  name: 'customer',
  schema: z.object({ id: z.string(), email: z.string() }),
  resolve: {
    get: async ({ id }) => ({ id, email: 'sample@example.com' }),
  },
});

const internalNote = registry.defineObject({
  name: 'internal_note',
  schema: z.object({ id: z.string(), body: z.string() }),
});

registry.defineObject({
  name: 'audit_log',
  schema: z.object({ id: z.string(), message: z.string() }),
});

registry.defineObject({
  name: '<img src=x onerror="window.__ont_xss=1">',
  schema: z.object({ id: z.string() }),
});

registry.defineLink({
  name: 'product_notes',
  from: product,
  to: internalNote,
  cardinality: 'many',
});

registry.defineLink({
  name: 'product_customer',
  from: product,
  to: customer,
  cardinality: 'one',
});

registry.defineAction({
  name: 'publish_product',
  target: product,
  input: z.object({ productId: z.string(), note: z.string() }),
  policy: {
    approval: 'required',
    roles: ['editor'],
  },
  execute: async ({ input }) => ({ published: input.productId }),
});

registry.defineAction({
  name: 'discount_product',
  target: product,
  input: z.object({ productId: z.string(), percent: z.number() }),
  policy: {
    approval: 'required',
    where: { field: 'status', op: 'eq', value: 'draft' },
  },
  execute: async ({ input }) => ({ discounted: input.productId }),
});

registry.defineAction({
  name: 'touch_customer',
  target: customer,
  input: z.object({ customerId: z.string() }),
  execute: async ({ input }) => ({ touched: input.customerId }),
});

registry.defineAction({
  name: 'sync_catalog',
  input: z.object({ source: z.string() }),
  execute: notImplemented,
});

export default {
  registry,
  store: createMemoryStore(),
};
