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
