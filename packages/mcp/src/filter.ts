import {
  baseNode,
  DECIMAL_INTEGER_SOURCE,
  enumValues,
  getShape,
  isDecimalInteger,
  isDecimalIntegerField,
  isOptionalField,
  typeNameOf,
} from 'orangerail-core';
import type { z } from 'zod';

import type { JsonSchemaProperty } from './schema';

/**
 * The `<Object>_list` filter grammar: what it is, how it is published, and how
 * it is enforced — in one module, because those three must not drift.
 *
 * Before this, `filter` was advertised as a bare `{ type: 'object' }` and passed
 * STRAIGHT THROUGH to the object's `resolve.list`, which for a generated Prisma
 * resolver is `findMany({ where: filter })`. That is not an untyped parameter,
 * it is a query language: a caller could filter across a relation
 * (`{ orders: { some: { secret: { startsWith: 'h' } } } }`) into an object type
 * the operator never exposed as a tool, and read a column out of it one prefix
 * at a time. The declared surface was not the surface.
 *
 * So the grammar here is CLOSED and it is CHECKED, and the schema published in
 * `tools/list` is exactly what the checker accepts — in both directions. A
 * caller that obeys the schema is never refused, and a caller that ignores it
 * never gets further than this module. The narrowness is the point: this is a
 * fixed set of predicates over the object's OWN declared scalar fields, not a
 * query language, and it must not grow into one.
 *
 * What is deliberately absent, and stays absent:
 *   - relation filters (`some` / `every` / `none`) — the reason this exists;
 *   - `AND` / `OR` / `NOT` — a flat filter is already a conjunction, and
 *     recursion is what makes a grammar unbounded to reason about;
 *   - any key that is not a field the object itself declares.
 *
 * What is present leaks nothing new: every operator below ranges over a column
 * `list` already returns in full, so `startsWith` on the object's own column is
 * a slower way to read what the caller could have read by paging.
 */

/** How a declared field may be compared. */
type FilterKind = 'string' | 'number' | 'bigint' | 'boolean' | 'enum';

/** One filterable field, as both the checker and the schema renderer see it. */
export interface FilterField {
  kind: FilterKind;
  /** The JSON type of a leaf value. */
  type: 'string' | 'number' | 'boolean';
  /** Permitted values, for `kind: 'enum'`. */
  values?: string[];
  /** The field accepts `null` (a nullable column), so "is null" is expressible. */
  nullable: boolean;
}

/** Every field of one object that may appear as a filter key. */
export type FilterSpec = Record<string, FilterField>;

/**
 * The operators each kind admits, sorted — the sort is what makes the rendered
 * schema byte-stable, and the same array drives the checker, so the published
 * key set and the accepted key set cannot disagree.
 *
 * Ordering comparisons are given to `string` on purpose: a scanned `DateTime`
 * column is emitted as `z.string()`, so without them a date range is
 * inexpressible — and an ISO-8601 string orders correctly either way.
 *
 * `bigint` gets the NUMBER operator set over string operands, and the omission
 * of `contains` / `startsWith` / `endsWith` is the point (ONT-068). Prisma's
 * `BigIntFilter` does not have them, so publishing them would be the `Bytes`
 * defect again: the gate accepts a filter the datasource then refuses, and the
 * refusal reaches the agent as an opaque `resolve_error` it cannot act on. The
 * operands are strings because that is how a 64-bit key crosses JSON at all; the
 * datasource still compares them numerically, since the column is numeric.
 */
const OPERATORS: Record<FilterKind, readonly string[]> = {
  string: ['contains', 'endsWith', 'equals', 'gt', 'gte', 'in', 'lt', 'lte', 'not', 'startsWith'],
  number: ['equals', 'gt', 'gte', 'in', 'lt', 'lte', 'not'],
  bigint: ['equals', 'gt', 'gte', 'in', 'lt', 'lte', 'not'],
  boolean: ['equals', 'not'],
  enum: ['equals', 'in', 'not'],
};

/** The one operator whose value is a LIST of leaves rather than a leaf. */
const LIST_OPERATOR = 'in';

/**
 * Zod type names that map to a leaf JSON type we are willing to state.
 *
 * The zod type name `bigint` is absent, and now means something different from
 * what it meant before ONT-068. A scanned `BigInt` COLUMN no longer arrives as
 * `z.bigint()` — it is a decimal-string node, which {@link deriveFilterSpec}
 * recognizes below and gives its own operator set. What is left under the name
 * is a hand-written `z.bigint()` action-style field, which `JSON.parse` can
 * never satisfy, so it stays out: a filter key nothing could ever match is worse
 * published than absent.
 *
 * `z.number().int()` collapses to `number` here — `.int()` is a check, not a
 * distinct zod type. The schema is therefore one step wider than the column for
 * an `Int`, and a fractional operand reaches Prisma and is rejected there. That
 * is a value-range imprecision, not a boundary one: it admits no key, no field
 * and no row this module was not already willing to admit.
 */
const LEAF_TYPES: Record<string, FilterField['type']> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  // A JSON-RPC payload has no date type; an ISO-8601 string is what a caller
  // actually sends, and what Prisma accepts for a `DateTime` column.
  date: 'string',
};

/**
 * Read the filterable fields off an object's own zod schema.
 *
 * Keys are sorted, so two servers built from the same registry publish the same
 * bytes. Each field is unwrapped past `.optional()` / `.nullable()` /
 * `.default()` first — a Prisma-scanned object wraps every nullable column, and
 * without unwrapping most of a real object's fields would be untypable.
 *
 * A field whose kind has no leaf JSON type here — a `z.unknown()` JSON column, a
 * list column, a nested object — is left OUT, and being left out now means it is
 * not filterable at all. That is the intended direction: this module can only
 * vouch for what it can describe, and it refuses everything it cannot.
 *
 * A `BigInt` column is checked for BEFORE the leaf table, because by type name
 * it is a string and would otherwise be handed the substring operators its
 * column cannot answer. See {@link isDecimalIntegerField} for how the two are
 * told apart, and for the one column that is deliberately misread as this.
 */
export const deriveFilterSpec = ({ schema }: { schema: z.ZodType }): FilterSpec => {
  const shape = getShape({ schema });
  const spec: FilterSpec = {};

  for (const key of Object.keys(shape).sort()) {
    const declared = shape[key];
    const node = baseNode({ node: declared });
    const nullable = isOptionalField({ node: declared });
    const values = enumValues({ node });

    if (values !== undefined) {
      spec[key] = { kind: 'enum', type: 'string', values, nullable };
      continue;
    }

    if (isDecimalIntegerField({ node })) {
      spec[key] = { kind: 'bigint', type: 'string', nullable };
      continue;
    }

    const type = LEAF_TYPES[typeNameOf({ node })];

    if (type !== undefined) {
      spec[key] = { kind: type, type, nullable };
    }
  }

  return spec;
};

/**
 * The type facts of one leaf value, nullability aside — the form both the bare
 * value and every operand share.
 *
 * A `bigint` leaf publishes its `pattern`, and that is not decoration: this
 * module's whole claim is that the published schema and the checker agree in
 * BOTH directions, and `validateFilter` refuses `{ id: { gt: "abc" } }`. Stating
 * only `"string"` would leave a caller obeying the schema and being refused
 * anyway, which is the property `filter.ts` exists to keep.
 */
const leafType = ({ field }: { field: FilterField }): JsonSchemaProperty =>
  field.kind === 'bigint'
    ? { type: 'string', pattern: DECIMAL_INTEGER_SOURCE }
    : { type: field.type };

/** The JSON Schema for one leaf value of a field (the bare-equality form). */
const leafSchema = ({ field }: { field: FilterField }): JsonSchemaProperty => ({
  ...leafType({ field }),
  type: field.nullable ? [field.type, 'null'] : field.type,
  ...(field.values === undefined
    ? {}
    : { enum: field.nullable ? [...field.values, null] : field.values }),
});

/** The bounded operator object for one kind, over a given leaf. */
const operatorSchema = ({
  kind,
  leaf,
}: {
  kind: FilterKind;
  leaf: JsonSchemaProperty;
}): JsonSchemaProperty => {
  const properties: Record<string, JsonSchemaProperty> = {};

  for (const operator of OPERATORS[kind]) {
    properties[operator] =
      operator === LIST_OPERATOR ? { type: 'array', items: leaf } : { ...leaf };
  }

  return { type: 'object', properties, additionalProperties: false };
};

/** The `$defs` key holding the shared operator object for a scalar kind. */
const defNameFor = ({ kind }: { kind: FilterKind }): string => `${kind}Operators`;

/**
 * The `filter` property of a `<Object>_list` tool, plus the `$defs` the tool's
 * `inputSchema` must carry for it.
 *
 * CLOSED (`additionalProperties: false`), and closed truthfully: {@link
 * validateFilter} enforces exactly this shape at the transport boundary, so the
 * schema is a statement about what the server does rather than a hint. An object
 * with no describable fields publishes an empty, still-closed schema — nothing
 * is filterable, and saying so is the honest form of "this module cannot vouch
 * for a single key here".
 *
 * The operator object is hoisted into `$defs` PER KIND and referenced, rather
 * than written out per field. Inlined, a five-column object cost about 1.9 kB of
 * `tools/list` and the same ten operator entries were repeated once per string
 * column; shared, the grammar is stated once per kind that the object actually
 * uses. That is a pure size change — every field still resolves to exactly the
 * schema it had, and `$ref` into the same document is core JSON Schema.
 *
 * An enum field does NOT share: its operands are constrained to that field's own
 * members, so it is written out in place.
 */
export const deriveFilterSchema = ({
  spec,
}: {
  spec: FilterSpec;
}): { filter: JsonSchemaProperty; defs: Record<string, JsonSchemaProperty> } => {
  const properties: Record<string, JsonSchemaProperty> = {};
  const defs: Record<string, JsonSchemaProperty> = {};

  for (const key of Object.keys(spec)) {
    const field = spec[key]!;
    const leaf = leafSchema({ field });

    if (field.kind === 'enum') {
      properties[key] = { anyOf: [leaf, operatorSchema({ kind: 'enum', leaf })] };
      continue;
    }

    // The shared operator object ranges over the NON-nullable leaf: `null` is
    // meaningful as a whole value ("is null") and meaningless as an operand, so
    // keeping it off the operators is what lets a nullable and a non-nullable
    // column of the same kind share one definition.
    const name = defNameFor({ kind: field.kind });

    defs[name] ??= operatorSchema({ kind: field.kind, leaf: leafType({ field }) });
    properties[key] = { anyOf: [leaf, { $ref: `#/$defs/${name}` }] };
  }

  return {
    filter: { type: 'object', properties, additionalProperties: false },
    // Sorted: `$defs` is emitted in insertion order otherwise, which is field
    // order, which would make the payload depend on the schema's key order.
    defs: Object.fromEntries(
      Object.keys(defs)
        .sort()
        .map((name) => [name, defs[name]!]),
    ),
  };
};

/** True for a JSON object literal — not an array, not `null`. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether one value is admissible for a field.
 *
 * `null` is admissible as a WHOLE value on a nullable column — that is how "is
 * null" is written — and never as an operand: `{ gt: null }` has no meaning, and
 * excluding it is also what lets the published operator object be shared between
 * a nullable and a non-nullable column of the same kind.
 */
const leafFits = ({
  field,
  value,
  operand = false,
}: {
  field: FilterField;
  value: unknown;
  operand?: boolean;
}): boolean => {
  if (value === null) {
    return field.nullable && !operand;
  }

  if (field.values !== undefined) {
    return typeof value === 'string' && field.values.includes(value);
  }

  // A `BigInt` operand is a string, but not any string. `{ id: { gt: "abc" } }`
  // is a driver error waiting to happen, and a driver error on a READ is redacted
  // to an opaque `resolve_error` — the gate says what is wrong while it still can.
  if (field.kind === 'bigint') {
    return isDecimalInteger({ value });
  }

  switch (field.type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
  }
};

/** What a leaf of this field has to look like, in one phrase. */
const shapeOf = ({ field }: { field: FilterField }): string =>
  field.values !== undefined
    ? `one of ${field.values.join(', ')}`
    : field.kind === 'bigint'
      ? 'a decimal integer as a string'
      : field.type;

/** How a rejected value is described — the expected shape, never the value sent. */
const expected = ({ field, operand = false }: { field: FilterField; operand?: boolean }): string =>
  `${shapeOf({ field })}${field.nullable && !operand ? ' or null' : ''}`;

/** Check one field's value: a bare leaf, or an object of bounded operators. */
const checkValue = ({
  key,
  field,
  value,
}: {
  key: string;
  field: FilterField;
  value: unknown;
}): string[] => {
  if (!isPlainObject(value)) {
    return leafFits({ field, value })
      ? []
      : [`"${key}" expects ${expected({ field })} or an operator object`];
  }

  const allowed = OPERATORS[field.kind];
  const issues: string[] = [];

  for (const operator of Object.keys(value)) {
    if (!allowed.includes(operator)) {
      issues.push(
        `"${key}.${operator}" is not a supported operator (allowed: ${allowed.join(', ')})`,
      );
      continue;
    }

    const supplied = value[operator];

    if (operator === LIST_OPERATOR) {
      if (
        !Array.isArray(supplied) ||
        !supplied.every((item) => leafFits({ field, value: item, operand: true }))
      ) {
        issues.push(`"${key}.in" expects an array of ${expected({ field, operand: true })}`);
      }
      continue;
    }

    if (!leafFits({ field, value: supplied, operand: true })) {
      issues.push(`"${key}.${operator}" expects ${expected({ field, operand: true })}`);
    }
  }

  return issues;
};

/** Combinators a caller is most likely to reach for; named so the refusal is useful. */
const COMBINATORS = new Set(['AND', 'OR', 'NOT']);

/**
 * Check a caller's `filter` against the object's own declared fields, returning
 * one issue per violation and an empty array when it is admissible.
 *
 * This is the gate, not a hint. It runs in the MCP server before the filter
 * reaches `object.resolve.list`, so it covers a hand-written resolver exactly as
 * it covers a generated Prisma one — a `where` that never leaves this process
 * cannot traverse into an object type the operator did not expose.
 *
 * Issues name KEYS and expected shapes, never the values the caller sent: the
 * message travels back to the agent and into the operator's log, and neither is
 * a place to copy an input that may itself be a probe.
 */
export const validateFilter = ({
  filter,
  spec,
}: {
  filter: unknown;
  spec: FilterSpec;
}): string[] => {
  if (!isPlainObject(filter)) {
    return ['filter must be an object of field predicates'];
  }

  const fields = Object.keys(spec);
  const issues: string[] = [];

  for (const key of Object.keys(filter)) {
    // `Object.hasOwn`, not `spec[key] === undefined`. `JSON.parse` gives
    // `{"__proto__": …}` an OWN `__proto__` key, and a plain-object lookup for it
    // returns `Object.prototype` — truthy — so the membership test would pass and
    // the code below would then read `kind` off `Object.prototype` and throw. An
    // unroutable key must produce the ordinary refusal, not an internal error.
    if (!Object.hasOwn(spec, key)) {
      issues.push(
        COMBINATORS.has(key)
          ? `"${key}" is not supported — a filter is a flat conjunction of field predicates`
          : `"${key}" is not a filterable field of this object${fields.length === 0 ? '' : ` (fields: ${fields.join(', ')})`}`,
      );
      continue;
    }

    issues.push(...checkValue({ key, field: spec[key]!, value: filter[key] }));
  }

  return issues;
};
