import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRegistry } from '../src/registry';

describe('defineAction — targetIdFrom (AC-1 runtime half)', () => {
  it('defaults targetIdFrom to `${camelCase(target.name)}Id`', () => {
    const registry = createRegistry();
    const Product = registry.defineObject({
      name: 'Product',
      schema: z.object({ id: z.string() }),
      resolve: { get: async () => null },
    });

    const action = registry.defineAction({
      name: 'touch',
      target: Product,
      input: z.object({ productId: z.string() }),
      execute: async () => undefined,
    });

    expect(action.targetIdFrom).toBe('productId');
  });

  it('throws at define time when the resolved targetIdFrom is not a key of the input schema', () => {
    const registry = createRegistry();
    const Order = registry.defineObject({
      name: 'Order',
      schema: z.object({ id: z.string() }),
      resolve: { get: async () => null },
    });

    // Default would be `orderId`, which is absent from the input schema.
    expect(() =>
      registry.defineAction({
        name: 'badBinding',
        target: Order,
        input: z.object({ somethingElse: z.string() }),
        execute: async () => undefined,
      }),
    ).toThrow(/targetIdFrom "orderId" is not a key/);
  });

  it('defineLink registers a typed link (AC-2)', () => {
    const registry = createRegistry();
    const Order = registry.defineObject({ name: 'Order', schema: z.object({ id: z.string() }) });
    const Product = registry.defineObject({
      name: 'Product',
      schema: z.object({ id: z.string() }),
    });

    const link = registry.defineLink({
      from: Order,
      to: Product,
      name: 'contains',
      cardinality: 'many',
    });

    expect(link).toMatchObject({ kind: 'link', name: 'contains', cardinality: 'many' });
    expect(registry.listLinks()).toHaveLength(1);
  });
});
