import type { z } from 'zod';

/**
 * Zod introspection isolated in one module (§3.6 / risk §5). Zod internals
 * differ between v3 and v4, so every access is version-tolerant: we read from
 * the public `.shape` where possible and fall back through `_def`/`def`. This
 * module is unit-tested against the supported shapes.
 */

/** Read a possibly-present `_def` (v3) or `def` (v4) container off a zod node. */
const readDef = ({ node }: { node: unknown }): Record<string, unknown> | undefined => {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }

  const withDef = node as { _def?: unknown; def?: unknown };
  const def = withDef._def ?? withDef.def;

  return typeof def === 'object' && def !== null ? (def as Record<string, unknown>) : undefined;
};

/**
 * Return the top-level property shape of a zod object schema as a plain record
 * of `key -> zod node`. Non-object schemas yield an empty record.
 */
export const getShape = ({ schema }: { schema: z.ZodType }): Record<string, unknown> => {
  const node = schema as unknown as {
    shape?: Record<string, unknown>;
    _def?: { shape?: () => Record<string, unknown> };
  };

  if (node.shape && typeof node.shape === 'object') {
    return node.shape;
  }

  const defShape = node._def?.shape;

  return typeof defShape === 'function' ? defShape() : {};
};

/**
 * Normalized primitive-type name for a zod node — `ZodString` (v3 `typeName`)
 * and `string` (v4 `type`) both collapse to `string`. Unknown nodes yield
 * `unknown`; this is intentionally shallow (the execute wrapper re-parses
 * against the current schema to catch deep drift — §3.4 step 3).
 */
export const typeNameOf = ({ node }: { node: unknown }): string => {
  const def = readDef({ node });
  const raw = def?.['typeName'] ?? def?.['type'] ?? 'unknown';

  return String(raw).replace(/^Zod/, '').toLowerCase();
};

/**
 * How many wrapper layers {@link baseNode} will strip before giving up. A zod
 * chain of `.optional().nullable()` is two; a hand-written schema will not go
 * far past that, and the cap means a malformed node whose `innerType` points
 * back at itself cannot spin forever.
 */
const MAX_UNWRAP_DEPTH = 8;

/** Wrappers that decorate a field without changing what value it accepts. */
const WRAPPER_TYPES = new Set(['optional', 'nullable', 'default']);

/**
 * Strip the `.optional()` / `.nullable()` / `.default()` wrappers off a
 * field-level zod node and return the node they decorate.
 *
 * {@link typeNameOf} is deliberately shallow, so it reports `optional` for
 * `z.string().optional()` — true, and useless to a caller that wants to know
 * the field holds a string. Everything generated from a Prisma schema wraps
 * every nullable column, so without this the majority of a scanned object's
 * fields are untypable. Returns the node itself when it carries no wrapper.
 */
export const baseNode = ({ node }: { node: unknown }): unknown => {
  let current = node;

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    if (!WRAPPER_TYPES.has(typeNameOf({ node: current }))) {
      return current;
    }

    const inner = readDef({ node: current })?.['innerType'];

    if (inner === undefined) {
      return current;
    }

    current = inner;
  }

  return current;
};

/**
 * The string members of a zod enum node, in DECLARED order, or `undefined` for
 * any node that is not an enum.
 *
 * Declared order (not sorted) because the order is part of what the source
 * said, and it is stable across runs — zod v3 keeps the `z.enum([...])` array
 * and zod v4 keeps its `entries` object in the same insertion order — so
 * nothing that renders this can lose byte-determinism by using it.
 *
 * Non-string members (a numeric `nativeEnum`) are dropped rather than coerced:
 * a caller renders these as a JSON Schema `enum`, and listing `1` as the string
 * `"1"` would advertise a value the schema does not accept.
 */
export const enumValues = ({ node }: { node: unknown }): string[] | undefined => {
  if (typeNameOf({ node }) !== 'enum' && typeNameOf({ node }) !== 'nativeenum') {
    return undefined;
  }

  const def = readDef({ node });
  // v3 `ZodEnum` keeps an array of members; v3 `ZodNativeEnum` and v4 `ZodEnum`
  // keep an object (`values` / `entries`) whose VALUES are the members.
  const raw = def?.['values'] ?? def?.['entries'];

  const members = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null
      ? Object.values(raw as Record<string, unknown>)
      : [];

  const strings = members.filter((member): member is string => typeof member === 'string');

  return strings.length === 0 ? undefined : strings;
};

/**
 * Sorted `property-name -> primitive-type-name` map of a zod object schema's
 * top-level shape — the `inputShape` component of the action signature hash.
 */
export const inputShape = ({ schema }: { schema: z.ZodType }): Record<string, string> => {
  const shape = getShape({ schema });
  const out: Record<string, string> = {};

  for (const key of Object.keys(shape).sort()) {
    out[key] = typeNameOf({ node: shape[key] });
  }

  return out;
};

/** Sorted list of a zod object schema's top-level property names. */
export const shapeKeys = ({ schema }: { schema: z.ZodType }): string[] =>
  Object.keys(getShape({ schema })).sort();

const sortValue = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue({ value: item }));
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(obj).sort()) {
      out[key] = sortValue({ value: obj[key] });
    }

    return out;
  }

  return value;
};

/** Deterministic JSON with recursively sorted object keys (hash-stable). */
export const canonicalJson = ({ value }: { value: unknown }): string =>
  JSON.stringify(sortValue({ value }));

/**
 * Whether a field-level zod node accepts one specific probe value, asked
 * through the PUBLIC `safeParse` rather than through `_def` (stable across zod
 * v3 and v4, and it answers for a wrapper chain of any depth without knowing
 * how the chain is spelled).
 *
 * Fails closed in every ambiguous case: a non-zod node, a node without
 * `safeParse`, and an async refinement (whose `safeParse` throws synchronously)
 * all report "does not accept". Every caller uses the answer to WIDEN what it
 * publishes about a field, so a false negative costs a marker while a false
 * positive would advertise a value the parser rejects.
 *
 * Exported to the PACKAGE, not to the world: `json.ts` classifies a
 * decimal-integer field with the same probe, and a second copy of these
 * fail-closed rules is a second place they can drift.
 */
export const admits = ({ node, value }: { node: unknown; value: unknown }): boolean => {
  if (typeof node !== 'object' || node === null) {
    return false;
  }

  const candidate = node as { safeParse?: (value: unknown) => { success?: unknown } };
  if (typeof candidate.safeParse !== 'function') {
    return false;
  }

  try {
    return candidate.safeParse(value).success === true;
  } catch {
    return false;
  }
};

/**
 * Whether a field-level zod node is optional from the caller's perspective —
 * `true` iff the node accepts `undefined`. A `.default()` field reports optional
 * on purpose: the caller may omit it (§3.8).
 */
export const isOptionalField = ({ node }: { node: unknown }): boolean =>
  admits({ node, value: undefined });

/**
 * Whether a field-level zod node accepts `null` — a DIFFERENT question from
 * {@link isOptionalField}, and kept separate because a published JSON Schema
 * states the two facts in different places: optionality by omission from
 * `required`, nullability by a `"null"` member in `type`.
 *
 * Collapsing them is how a schema ends up claiming a field admits `null` when
 * the parser will reject it, or erasing the type of a field that is merely
 * optional (ONT-061).
 */
export const isNullableField = ({ node }: { node: unknown }): boolean =>
  admits({ node, value: null });
