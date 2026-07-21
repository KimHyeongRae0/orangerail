import { inputShape } from 'orangerail-core';
import type { z } from 'zod';

/**
 * A minimal JSON Schema object for a tool's `inputSchema` (tools/list, §3.2).
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type?: string }>;
  required?: string[];
  additionalProperties: boolean;
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
 */
export const deriveInputSchema = ({ schema }: { schema: z.ZodType }): JsonSchema => {
  const shape = inputShape({ schema });
  const properties: Record<string, { type?: string }> = {};

  for (const [key, typeName] of Object.entries(shape)) {
    const jsonType = PRIMITIVE_TO_JSON[typeName];
    properties[key] = jsonType === undefined ? {} : { type: jsonType };
  }

  return { type: 'object', properties, additionalProperties: true };
};
