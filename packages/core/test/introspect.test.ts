import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  baseNode,
  canonicalJson,
  enumValues,
  inputShape,
  isNullableField,
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

describe('baseNode — past the wrappers a scanned field carries (ONT-053)', () => {
  it('unwraps optional, nullable and default down to the decorated node', () => {
    expect(typeNameOf({ node: baseNode({ node: z.string().optional() }) })).toBe('string');
    expect(typeNameOf({ node: baseNode({ node: z.number().nullable() }) })).toBe('number');
    expect(typeNameOf({ node: baseNode({ node: z.boolean().default(false) }) })).toBe('boolean');
  });

  it('unwraps a stack of wrappers', () => {
    // Every nullable Prisma column is emitted `.optional()`, and a hand-written
    // ontology may add more; one layer of unwrapping would not be enough.
    expect(typeNameOf({ node: baseNode({ node: z.string().nullable().optional() }) })).toBe(
      'string',
    );
  });

  it('returns an unwrapped node untouched', () => {
    const node = z.string();

    expect(baseNode({ node })).toBe(node);
  });

  it('returns non-zod input rather than throwing', () => {
    expect(baseNode({ node: undefined })).toBeUndefined();
    expect(baseNode({ node: 'not a node' })).toBe('not a node');
  });
});

describe('enumValues (ONT-053)', () => {
  it('reads a string enum in declared order', () => {
    expect(enumValues({ node: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']) })).toEqual([
      'DRAFT',
      'ACTIVE',
      'ARCHIVED',
    ]);
  });

  it('reads a native string enum', () => {
    expect(enumValues({ node: z.nativeEnum({ A: 'a', B: 'b' }) })).toEqual(['a', 'b']);
  });

  it('is undefined for anything that is not an enum', () => {
    expect(enumValues({ node: z.string() })).toBeUndefined();
    expect(enumValues({ node: z.number() })).toBeUndefined();
    expect(enumValues({ node: undefined })).toBeUndefined();
  });

  it('does not see through a wrapper — the caller unwraps first', () => {
    const optional = z.enum(['A', 'B']).optional();

    expect(enumValues({ node: optional })).toBeUndefined();
    expect(enumValues({ node: baseNode({ node: optional }) })).toEqual(['A', 'B']);
  });

  it('drops non-string members rather than coercing them', () => {
    // A JSON Schema `enum` built from these would otherwise advertise "1" as a
    // legal value for a field that only accepts the number 1.
    expect(enumValues({ node: z.nativeEnum({ A: 1, B: 2 }) })).toBeUndefined();
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

describe('isNullableField', () => {
  it('reports a `.nullable()` field as nullable', () => {
    expect(isNullableField({ node: z.string().nullable() })).toBe(true);
  });

  it('reports an `.optional()` field as NOT nullable — the two are different facts', () => {
    expect(isNullableField({ node: z.string().optional() })).toBe(false);
    expect(isOptionalField({ node: z.string().optional() })).toBe(true);
  });

  it('reports a `.nullish()` field as both', () => {
    expect(isNullableField({ node: z.string().nullish() })).toBe(true);
    expect(isOptionalField({ node: z.string().nullish() })).toBe(true);
  });

  it('reports a bare field as neither', () => {
    expect(isNullableField({ node: z.string() })).toBe(false);
  });

  it('fails closed on a non-zod node and on one whose safeParse throws', () => {
    const throwing = {
      safeParse: () => {
        throw new Error('async refinement cannot run synchronously');
      },
    };

    expect(isNullableField({ node: {} })).toBe(false);
    expect(isNullableField({ node: null })).toBe(false);
    expect(isNullableField({ node: throwing })).toBe(false);
  });
});
