import type { z } from 'zod';

import type { ObjectDefinition, ReadAccess, ResolveContract } from '../types';

/** Input to {@link buildObjectDefinition} / `defineObject` (§3.1). */
export interface DefineObjectInput<
  Name extends string = string,
  Schema extends z.ZodType = z.ZodType,
> {
  name: Name;
  schema: Schema;
  /** Read exposure; defaults to `'authenticated'` (deny-first, §4.6). */
  readAccess?: ReadAccess;
  resolve?: ResolveContract<z.infer<Schema>>;
}

/**
 * Build an object-type definition. The presence of `resolve` in the argument
 * is captured (via a `const` type parameter) into the definition's
 * `HasResolve` marker so a `where` policy can require a resolvable target at
 * compile time (AC-1). The concrete input type also gives `resolve.get` proper
 * contextual typing.
 */
export const buildObjectDefinition = <
  Name extends string,
  Schema extends z.ZodType,
  const Def extends DefineObjectInput<Name, Schema>,
>(
  def: Def,
): ObjectDefinition<Name, Schema, Def extends { resolve: object } ? true : false> => {
  const base = {
    kind: 'object' as const,
    name: def.name,
    schema: def.schema,
    readAccess: def.readAccess ?? 'authenticated',
  };

  const withResolve = def.resolve === undefined ? base : { ...base, resolve: def.resolve };

  return withResolve as unknown as ObjectDefinition<
    Name,
    Schema,
    Def extends { resolve: object } ? true : false
  >;
};
