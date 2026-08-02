/**
 * Orangerail action `applyDiscount` — a rule the scanner cannot derive.
 *
 * "Never discount a product that is sold out" is not in the Prisma schema, so `init` emits
 * no `where` clause of its own. It is written here by hand, which is the documented shape:
 * the config self-discovers every `ontology/*.mjs`, so dropping this file in registers it.
 *
 * There is deliberately no `approval` on this action. The `where` guard is the only thing
 * between the agent and the row, which is what lets the write run with nobody present —
 * and what makes it worth knowing whether the guard can be satisfied by a field the row
 * does not carry.
 */
import { z } from 'zod';

import { registry } from './_registry.mjs';
import { Product } from './Product.mjs';

const getPrisma = (() => {
  let client;

  return async () => {
    if (client === undefined) {
      const { PrismaClient } = await import('@prisma/client');

      client = new PrismaClient();
    }

    return client;
  };
})();

export const applyDiscount = registry.defineAction({
  name: 'applyDiscount',
  input: z.object({ productId: z.string(), percentOff: z.number().int() }),
  policy: { where: { field: 'status', op: 'neq', value: 'soldout' } },
  target: Product,
  targetIdFrom: 'productId',
  execute: async ({ input }) => {
    const prisma = await getPrisma();
    const product = await prisma.product.findUnique({ where: { id: input.productId } });
    const priceCents = Math.round((product.priceCents * (100 - input.percentOff)) / 100);

    await prisma.product.update({ where: { id: input.productId }, data: { priceCents } });

    return { productId: input.productId, priceCents };
  },
});
