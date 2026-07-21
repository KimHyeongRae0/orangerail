import type { Identity, WhereClause } from '../types';

/**
 * Ordered comparison for `gt`/`gte`/`lt`/`lte`. Returns a sign only when both
 * operands are the same orderable primitive (numbers or strings); otherwise
 * `null` (incomparable ⇒ the ordered op fails closed).
 */
const orderCompare = ({ actual, value }: { actual: unknown; value: unknown }): number | null => {
  if (typeof actual === 'number' && typeof value === 'number') {
    return actual === value ? 0 : actual > value ? 1 : -1;
  }

  if (typeof actual === 'string' && typeof value === 'string') {
    return actual === value ? 0 : actual > value ? 1 : -1;
  }

  return null;
};

/**
 * Evaluate a `where` clause against a resolved target object.
 *
 * A functional predicate is delegated verbatim. For a declarative predicate a
 * `null`/`undefined` object (target not found) fails closed — we cannot confirm
 * the condition holds, so the action is refused (§4.5 secure-by-default).
 */
export const evaluateWhere = ({
  where,
  object,
  input,
  identity,
}: {
  where: WhereClause;
  object: unknown;
  input: unknown;
  identity: Identity;
}): boolean => {
  if (typeof where === 'function') {
    return where({ object, input, identity });
  }

  if (object === null || object === undefined) {
    return false;
  }

  const actual = (object as Record<string, unknown>)[where.field];
  const { op, value } = where;

  switch (op) {
    case 'eq':
      return actual === value;
    case 'neq':
      return actual !== value;
    case 'in':
      return Array.isArray(value) && value.includes(actual);
    case 'gt': {
      const c = orderCompare({ actual, value });
      return c !== null && c > 0;
    }
    case 'gte': {
      const c = orderCompare({ actual, value });
      return c !== null && c >= 0;
    }
    case 'lt': {
      const c = orderCompare({ actual, value });
      return c !== null && c < 0;
    }
    case 'lte': {
      const c = orderCompare({ actual, value });
      return c !== null && c <= 0;
    }
    default:
      return false;
  }
};

/**
 * Whether a `where` clause is serializable into docs/MCP schema. Functional
 * predicates are not — docs-gen renders them as "custom condition" (§3.3).
 */
export const isSerializableWhere = ({ where }: { where: WhereClause }): boolean =>
  typeof where !== 'function';
