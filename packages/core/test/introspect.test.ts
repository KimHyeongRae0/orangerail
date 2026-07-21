import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { canonicalJson, inputShape, shapeKeys, typeNameOf } from '../src/introspect';

describe('zod introspection (version-tolerant)', () => {
  const schema = z.object({
    productId: z.string(),
    amount: z.number(),
    active: z.boolean(),
    status: z.enum(['a', 'b']),
  });

  it('returns a sorted primitive-type map for the top-level shape', () => {
    expect(inputShape({ schema })).toEqual({
      active: 'boolean',
      amount: 'number',
      productId: 'string',
      status: 'enum',
    });
  });

  it('returns sorted shape keys', () => {
    expect(shapeKeys({ schema })).toEqual(['active', 'amount', 'productId', 'status']);
  });

  it('normalizes zod node type names', () => {
    expect(typeNameOf({ node: z.string() })).toBe('string');
    expect(typeNameOf({ node: z.number() })).toBe('number');
  });

  it('yields an empty shape for a non-object schema', () => {
    expect(shapeKeys({ schema: z.string() })).toEqual([]);
  });
});

describe('canonicalJson', () => {
  it('produces key-order-independent output', () => {
    const a = canonicalJson({ value: { b: 1, a: { d: 2, c: 3 } } });
    const b = canonicalJson({ value: { a: { c: 3, d: 2 }, b: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(canonicalJson({ value: [3, 1, 2] })).toBe('[3,1,2]');
  });
});
