import { inputShape } from 'orangerail-core';
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

const PRIMITIVE_TO_JSON: Record<string, string> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  bigint: 'integer',
};

/**
 * Derive a conservative JSON Schema for an action input from core's zod
 * introspection (§3.2, zod-v3 fallback branch). The installed zod (v3 classic)
 * exposes no `z.toJSONSchema`, so we build a best-effort object schema from the
 * top-level shape: known primitives get a `type`, everything else is left
 * unconstrained. This schema is advisory only — the engine re-validates every
 * staged call with the authoritative zod `safeParse`, so a loose listed schema
 * can never admit an invalid execution. `required` is intentionally omitted
 * (permissive) since v3 optionality is not reliably introspectable here.
 *
 * The READ path does not work this way, and the difference is deliberate: an
 * action's authoritative check is the engine's zod parse, so a loose advertised
 * schema costs nothing, whereas a list `filter` had no check anywhere. See
 * `filter.ts`.
 */
export const deriveInputSchema = ({ schema }: { schema: z.ZodType }): JsonSchema => {
  const shape = inputShape({ schema });
  const properties: Record<string, JsonSchemaProperty> = {};

  for (const [key, typeName] of Object.entries(shape)) {
    const jsonType = PRIMITIVE_TO_JSON[typeName];
    properties[key] = jsonType === undefined ? {} : { type: jsonType };
  }

  return { type: 'object', properties, additionalProperties: true };
};
