import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  canonicalJson,
  inputShape,
  isOptionalField,
  shapeKeys,
  typeNameOf,
} from '../src/introspect';

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

describe('isOptionalField', () => {
  it('reports a required field as not optional', () => {
    expect(isOptionalField({ node: z.string() })).toBe(false);
  });

  it('reports an `.optional()` field as optional', () => {
    expect(isOptionalField({ node: z.string().optional() })).toBe(true);
  });

  it('reports a `.default()` field as optional (caller may omit it)', () => {
    expect(isOptionalField({ node: z.string().default('x') })).toBe(true);
  });

  it('reports a `.nullable()` field as NOT optional (accepts null, not undefined)', () => {
    expect(isOptionalField({ node: z.string().nullable() })).toBe(false);
  });

  it('treats a non-zod node as not optional', () => {
    expect(isOptionalField({ node: {} })).toBe(false);
    expect(isOptionalField({ node: null })).toBe(false);
    expect(isOptionalField({ node: 'string' })).toBe(false);
  });

  it('treats a node whose safeParse throws as not optional (fail-closed)', () => {
    const throwing = {
      safeParse: () => {
        throw new Error('async refinement cannot run synchronously');
      },
    };
    expect(isOptionalField({ node: throwing })).toBe(false);
  });
});
