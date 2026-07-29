import { z } from 'zod';

import type { IrActionField, IrField, IrScalar, IrValueConstraints } from '../ir';
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

/** Numeric-bound keys, in the order they are chained onto the base expression. */
const BOUND_METHODS = ['min', 'gt', 'max', 'lt'] as const;

/**
 * Render the declared value constraints (ONT-037) as a chain of zod modifiers.
 * The key names ARE the method names and the order is fixed, so the same IR
 * always emits the same bytes and a constraint-free field emits nothing at all.
 * A `regex` source goes through the one escaping layer (D10) and is rebuilt with
 * `new RegExp(...)` rather than a `/…/` literal, which no amount of user input
 * can terminate early.
 */
const constraintSuffix = ({
  constraints,
}: {
  constraints: IrValueConstraints | undefined;
}): string => {
  if (constraints === undefined) {
    return '';
  }

  const parts = BOUND_METHODS.filter((method) => constraints[method] !== undefined).map(
    (method) => `.${method}(${constraints[method] as number})`,
  );

  if (constraints.regex !== undefined) {
    parts.push(`.regex(new RegExp(${escapeStringLiteral({ value: constraints.regex })}))`);
  }

  return parts.join('');
};

/** The full zod expression string for a scanned action input field. */
export const actionFieldExpr = ({ field }: { field: IrActionField }): string => {
  const base = baseOf({ field });

  // `.optional()` stays outermost: the bounds constrain the value, not whether
  // the caller has to supply one.
  const expr = `${base.expr}${constraintSuffix({ constraints: field.constraints })}`;

  return field.optional ? `${expr}.optional()` : expr;
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
