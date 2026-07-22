import { createRegistry, notImplemented, type Registry } from 'orangerail-core';
import { z } from 'zod';

/**
 * A full-feature registry mirroring the e2e fixture (plan §7): object with
 * resolve (get+list), object without resolve, a hostile-named resolve-less /
 * untargeted object, a link, and actions exercising approval+roles,
 * approval-without-roles + functional where, declarative where, auto, and
 * not-implemented. Built fresh per call so tests never share mutable state.
 */
export const buildFixtureRegistry = (): Registry => {
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
      where: ({ input }: { input: { percent: number } }) => input.percent <= 50,
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

  return registry;
};

/** A minimal registry with no links and no actions (degradation coverage). */
export const buildReadOnlyRegistry = (): Registry => {
  const registry = createRegistry();

  registry.defineObject({
    name: 'widget',
    schema: z.object({ id: z.string() }),
    resolve: { get: async ({ id }) => ({ id }) },
  });

  return registry;
};
