import { z } from 'zod';

import type { IrActionField, IrField, IrScalar } from '../ir';
import { escapeStringLiteral } from './escape';

/**
 * The single source of truth mapping an IR scalar to (a) the zod EXPRESSION the
 * emitter renders into generated code and (b) the actual zod NODE the sync
 * differ builds to compare against the live registry. Keeping both derived from
 * one table guarantees the emitted schema and the differ's expectation stay in
 * lockstep — a field is "drifted" iff the node the re-scan would generate
 * introspects differently from the registry's node (plan D6/D11).
 *
 * Distinct scalars intentionally render distinguishable nodes where drift must
 * be observable: `decimal` -> `z.string()` while `float` -> `z.number()`, so a
 * Prisma `Float -> Decimal` change surfaces as a type-name drift.
 */
const SCALARS: Record<IrScalar, { expr: string; build: () => z.ZodType }> = {
  string: { expr: 'z.string()', build: () => z.string() },
  int: { expr: 'z.number().int()', build: () => z.number().int() },
  float: { expr: 'z.number()', build: () => z.number() },
  bigint: { expr: 'z.bigint()', build: () => z.bigint() },
  decimal: { expr: 'z.string()', build: () => z.string() },
  boolean: { expr: 'z.boolean()', build: () => z.boolean() },
  datetime: { expr: 'z.string()', build: () => z.string() },
  json: { expr: 'z.unknown()', build: () => z.unknown() },
  bytes: { expr: 'z.string()', build: () => z.string() },
};

const enumExpr = ({ values }: { values: string[] }): string => {
  if (values.length === 0) {
    return 'z.string()';
  }

  return `z.enum([${values.map((v) => escapeStringLiteral({ value: v })).join(', ')}])`;
};

const enumNode = ({ values }: { values: string[] }): z.ZodType => {
  if (values.length === 0) {
    return z.string();
  }

  return z.enum(values as [string, ...string[]]);
};

/** The base (pre-modifier) expression + node for a scalar/enum field. */
const baseOf = ({
  field,
}: {
  field: IrField | IrActionField;
}): { expr: string; build: () => z.ZodType } => {
  if (field.kind === 'enum') {
    const values = field.enumValues ?? [];

    return { expr: enumExpr({ values }), build: () => enumNode({ values }) };
  }

  return SCALARS[field.scalar ?? 'string'];
};

/** The full zod expression string for a scanned object field (emitter side). */
export const fieldExpr = ({ field }: { field: IrField }): string => {
  const base = baseOf({ field });

  let expr = base.expr;

  if (field.list) {
    expr = `z.array(${expr})`;
  }

  if (field.optional) {
    expr = `${expr}.optional()`;
  }

  return expr;
};

/** The full zod expression string for a scanned action input field. */
export const actionFieldExpr = ({ field }: { field: IrActionField }): string => {
  const base = baseOf({ field });

  return field.optional ? `${base.expr}.optional()` : base.expr;
};

/** The actual zod node a scanned object field maps to (differ side). */
export const fieldNode = ({ field }: { field: IrField }): z.ZodType => {
  const base = baseOf({ field });

  let node = base.build();

  if (field.list) {
    node = z.array(node);
  }

  if (field.optional) {
    node = node.optional();
  }

  return node;
};
