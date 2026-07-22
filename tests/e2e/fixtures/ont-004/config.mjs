/**
 * ONT-004 e2e fixture — full-feature ontology for docs-gen (plan §7).
 *
 * Covers every rendering path: object with resolve (get+list), object
 * without resolve, a hostile-named object (resolve-less and untargeted so
 * no MCP tool name is ever derived from it — plan §4), a link, and actions
 * exercising approval+roles, approval-without-roles, auto, not-implemented,
 * declarative where, and functional where.
 *
 * The preset is env-driven (ORANGERAIL_E2E_PRESET) so the driver can generate
 * and serve under 'readonly' without a second fixture.
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

const internalNote = registry.defineObject({
  name: 'internal_note',
  schema: z.object({ id: z.string(), body: z.string() }),
});

registry.defineObject({
  name: 'weird "spec|al" `object`',
  schema: z.object({ id: z.string() }),
});

registry.defineLink({
  name: 'product_notes',
  from: product,
  to: internalNote,
  cardinality: 'many',
});

registry.defineAction({
  name: 'publish_product',
  target: product,
  input: z.object({ productId: z.string(), note: z.string() }),
  policy: {
    approval: 'required',
    roles: ['editor'],
    where: { field: 'status', op: 'eq', value: 'draft' },
  },
  execute: async ({ input }) => ({ published: input.productId }),
});

registry.defineAction({
  name: 'discount_product',
  target: product,
  input: z.object({ productId: z.string(), percent: z.number() }),
  policy: {
    approval: 'required',
    where: ({ input }) => input.percent <= 50,
  },
  execute: async ({ input }) => ({ discounted: input.productId }),
});

registry.defineAction({
  name: 'touch_counter',
  input: z.object({ label: z.string() }),
  execute: async ({ input }) => ({ touched: input.label }),
});

registry.defineAction({
  name: 'sync_catalog',
  input: z.object({ source: z.string() }),
  execute: notImplemented,
});

const preset = process.env.ORANGERAIL_E2E_PRESET;

export default {
  registry,
  store: createMemoryStore(),
  ...(preset ? { preset } : {}),
};
