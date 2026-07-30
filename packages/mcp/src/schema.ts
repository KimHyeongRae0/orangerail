import {
  baseNode,
  enumValues,
  getShape,
  isNullableField,
  isOptionalField,
  typeNameOf,
} from 'orangerail-core';
import type { z } from 'zod';

/**
 * One property inside a tool's `inputSchema` (a minimal JSON Schema node).
 *
 * Widened past `{ type?: string }` for the `<Object>_list` filter (see
 * `filter.ts`), which needs a closed nested object, a per-field `anyOf`, enum
 * members, and a `["string","null"]` type union for a nullable column.
 */
export interface JsonSchemaProperty {
  type?: string | string[];
  /** Permitted values; `null` appears for a nullable enum column. */
  enum?: (string | null)[];
  /** Element schema, for `type: 'array'`. */
  items?: JsonSchemaProperty;
  /** Alternative shapes — a bare value, or an operator object. */
  anyOf?: JsonSchemaProperty[];
  /** A pointer into this document's `$defs` (`#/$defs/<name>`). */
  $ref?: string;
  /** Nested properties, for an object-typed property. */
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
}

/**
 * A minimal JSON Schema object for a tool's `inputSchema` (tools/list, §3.2).
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: boolean;
  /**
   * Shared subschemas a property may `$ref`. Present only on a `<Object>_list`
   * tool, and only when the object has a filterable scalar field — the list
   * filter states each operator grammar once per kind instead of once per
   * column (see `filter.ts`).
   */
  $defs?: Record<string, JsonSchemaProperty>;
}

/**
 * Zod type names that map to a JSON type we are willing to state, after the
 * `.optional()` / `.nullable()` / `.default()` wrappers have been stripped.
 *
 * `object` and `array` state the container and stop there: the inner shape
 * would need a second recursive schema builder tracking zod's internals, and
 * naming the container is already strictly more than saying nothing.
 *
 * `bigint` keeps its historical `integer` mapping, which is not quite true —
 * `JSON.parse` never yields a BigInt, so such a field is uncallable over this
 * transport whatever is advertised. Narrowing it to `{}` would make the schema
 * less informative without making the field any more callable, so it is left
 * alone and the refusal (`expects bigint`) carries the news.
 *
 * `date` is deliberately ABSENT, and differs from `filter.ts` on purpose: the
 * filter maps it to `string` because a scanned `DateTime` column is emitted as
 * `z.string()`, whereas a hand-written `z.date()` action field rejects the
 * string a JSON-RPC caller can send. Publishing `string` there would be the
 * exact lie this ticket exists to remove.
 */
const JSON_TYPES: Record<string, 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'> =
  {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    bigint: 'integer',
    object: 'object',
    array: 'array',
  };

/**
 * The published schema for ONE action input field.
 *
 * The wrappers are stripped before the type is read and the two facts they
 * carry are re-stated where JSON Schema puts them: nullability as a `"null"`
 * member of `type` here, optionality as absence from `required` in the caller.
 * Emptying the property was how BOTH facts used to be spelled, which is how an
 * optional column lost its type (ONT-061).
 *
 * A field this module cannot describe still publishes `{}` — the honest form of
 * "nothing to say" — but that is now the exception (a `z.unknown()` Json column)
 * rather than the rule.
 */
const propertyFor = ({ node }: { node: unknown }): JsonSchemaProperty => {
  const base = baseNode({ node });
  const nullable = isNullableField({ node });
  const values = enumValues({ node: base });

  if (values !== undefined) {
    return {
      type: nullable ? ['string', 'null'] : 'string',
      enum: nullable ? [...values, null] : values,
    };
  }

  const type = JSON_TYPES[typeNameOf({ node: base })];

  if (type === undefined) {
    return {};
  }

  return { type: nullable ? [type, 'null'] : type };
};

/**
 * Derive the JSON Schema an action tool publishes as its `inputSchema` (§3.2).
 *
 * Every fact here is read off the same zod node the engine parses with, so the
 * published contract cannot claim a bound the engine does not enforce (ONT-034)
 * and cannot withhold one it does. That second direction is the reason this was
 * rewritten: the previous version keyed off `inputShape`, whose type name for
 * `z.number().int().optional()` is `optional`, so every optional field fell off
 * the primitive table and published `{}`. A generated `update*` has exactly one
 * required field, so in practice EVERY generated update action advertised
 * itself as untyped — and an agent that guesses `"30"` for an untyped `stock`
 * has no way to learn otherwise from a schema that never said `number`.
 *
 * `additionalProperties` stays `true`, and that is a statement rather than an
 * oversight. `filter.ts` publishes `false` because ONT-053 built a checker that
 * refuses an undeclared key; an action input has no such checker, and a zod
 * object is non-strict by default, so an undeclared key is ACCEPTED (and
 * stripped). Publishing `false` would advertise a refusal that never happens —
 * the ONT-053 sin inverted, and in the more damaging direction, since a caller
 * would be stopped from sending something the server would have taken. Actions
 * are user-authored, and the transport has no standing to narrow their contract.
 */
export const deriveInputSchema = ({ schema }: { schema: z.ZodType }): JsonSchema => {
  const shape = getShape({ schema });
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  // Sorted, as `inputShape` sorted: two servers built from the same registry
  // must publish identical bytes.
  for (const key of Object.keys(shape).sort()) {
    const node = shape[key];

    properties[key] = propertyFor({ node });

    if (!isOptionalField({ node })) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: true,
  };
};

/** A zod issue, believed only as far as each field is individually checked. */
interface IssueLike {
  path?: unknown;
  code?: unknown;
  expected?: unknown;
  keys?: unknown;
  options?: unknown;
  values?: unknown;
}

/**
 * What a violation is called when the schema itself does not name an expected
 * type. Short phrases rather than zod's own sentences, for the reason given on
 * {@link describeInputIssues}.
 */
const CODE_PHRASES: Record<string, string> = {
  too_small: 'is outside the accepted range',
  too_big: 'is outside the accepted range',
  not_multiple_of: 'is outside the accepted range',
  invalid_string: 'does not match the accepted format',
  invalid_format: 'does not match the accepted format',
  invalid_date: 'is not a valid date',
};

/** The field a path points at; the empty path is the input object itself. */
const pathOf = ({ path }: { path: unknown }): string =>
  Array.isArray(path) && path.length > 0 ? path.map((part) => String(part)).join('.') : 'input';

/** The schema's OWN permitted values, under either zod version's spelling. */
const optionsOf = ({ issue }: { issue: IssueLike }): string[] | undefined => {
  const raw = issue.values ?? issue.options;
  const members = Array.isArray(raw)
    ? raw.filter((member): member is string => typeof member === 'string')
    : [];

  return members.length === 0 ? undefined : members;
};

const describeIssue = ({ issue }: { issue: IssueLike }): string[] => {
  const where = pathOf({ path: issue.path });

  // The only code whose subject is not the path: the parent is at `path` and
  // the offenders are listed separately, so each gets its own sentence — the
  // same way `validateFilter` names an undeclared filter key.
  if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
    return issue.keys.map((key) => `"${String(key)}" is not a field of this action`);
  }

  if (typeof issue.expected === 'string') {
    return [`"${where}" expects ${issue.expected}`];
  }

  const options = optionsOf({ issue });

  if (options !== undefined) {
    return [`"${where}" expects one of ${options.join(', ')}`];
  }

  const phrase = typeof issue.code === 'string' ? CODE_PHRASES[issue.code] : undefined;

  return [`"${where}" ${phrase ?? 'is invalid'}`];
};

/**
 * Translate the engine's zod issue list into the ONT-053 `issues` shape — one
 * string per violation, naming the field and what it wanted.
 *
 * The rejection used to be `Input failed schema validation.` and nothing else,
 * which against a type-erased schema is an unsolvable puzzle: an agent told
 * only that its call was wrong escalated through six spellings of the same
 * string, never sent a number, and reported a confident wrong diagnosis to its
 * operator (ONT-061). A refusal that does not say what it refused is not much
 * better than a hang.
 *
 * What crosses the boundary is bounded by provenance, not by a filter: the path
 * is a key the CALLER sent or a field `tools/list` already publishes, and the
 * expected type and enum members are facts the same `tools/list` states. Zod's
 * own `message` is NOT forwarded — in v3 it spells out the received value for
 * an enum, and echoing an input that may itself be a probe back into the
 * agent's context and the operator's log is exactly what `filter.ts` refuses to
 * do. The transport writes its own sentence from the code, as `diagnostic.ts`
 * does for a datasource failure.
 *
 * Narrows defensively: `issues` reaches here typed `unknown`, and anything
 * unrecognized yields `[]` so the caller can fall back rather than turn a
 * refusal into an internal error.
 */
export const describeInputIssues = ({ issues }: { issues: unknown }): string[] => {
  if (!Array.isArray(issues)) {
    return [];
  }

  return issues.flatMap((issue) =>
    typeof issue === 'object' && issue !== null ? describeIssue({ issue: issue as IssueLike }) : [],
  );
};
