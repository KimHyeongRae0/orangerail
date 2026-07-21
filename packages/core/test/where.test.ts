import { describe, expect, it } from 'vitest';

import { evaluateWhere, isSerializableWhere } from '../src/policy/where';
import type { Identity } from '../src/types';

const identity: Identity = { subject: 's', roles: [] };

const evalDeclarative = ({
  field,
  op,
  value,
  object,
}: {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
  value: unknown;
  object: unknown;
}): boolean => evaluateWhere({ where: { field, op, value }, object, input: {}, identity });

describe('declarative where operators (§3.3)', () => {
  it('eq / neq', () => {
    expect(
      evalDeclarative({
        field: 'status',
        op: 'neq',
        value: 'soldout',
        object: { status: 'active' },
      }),
    ).toBe(true);
    expect(
      evalDeclarative({
        field: 'status',
        op: 'neq',
        value: 'soldout',
        object: { status: 'soldout' },
      }),
    ).toBe(false);
    expect(
      evalDeclarative({ field: 'status', op: 'eq', value: 'active', object: { status: 'active' } }),
    ).toBe(true);
  });

  it('ordered ops on numbers', () => {
    expect(evalDeclarative({ field: 'n', op: 'gt', value: 5, object: { n: 6 } })).toBe(true);
    expect(evalDeclarative({ field: 'n', op: 'gte', value: 5, object: { n: 5 } })).toBe(true);
    expect(evalDeclarative({ field: 'n', op: 'lt', value: 5, object: { n: 6 } })).toBe(false);
    expect(evalDeclarative({ field: 'n', op: 'lte', value: 5, object: { n: 4 } })).toBe(true);
  });

  it('ordered ops fail closed for incomparable operands', () => {
    expect(evalDeclarative({ field: 'n', op: 'gt', value: 5, object: { n: 'six' } })).toBe(false);
  });

  it('in', () => {
    expect(
      evalDeclarative({ field: 'role', op: 'in', value: ['a', 'b'], object: { role: 'b' } }),
    ).toBe(true);
    expect(
      evalDeclarative({ field: 'role', op: 'in', value: ['a', 'b'], object: { role: 'c' } }),
    ).toBe(false);
  });

  it('fails closed when the target object is null/undefined', () => {
    expect(evalDeclarative({ field: 'status', op: 'neq', value: 'soldout', object: null })).toBe(
      false,
    );
  });
});

describe('functional where (escape hatch)', () => {
  it('delegates to the predicate and is not serializable', () => {
    const where = ({ object }: { object: unknown }): boolean =>
      (object as { status: string }).status !== 'soldout';

    expect(evaluateWhere({ where, object: { status: 'active' }, input: {}, identity })).toBe(true);
    expect(isSerializableWhere({ where })).toBe(false);
    expect(isSerializableWhere({ where: { field: 'status', op: 'eq', value: 'active' } })).toBe(
      true,
    );
  });
});
