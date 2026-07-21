import type { z } from 'zod';

import { shapeKeys } from '../introspect';
import { computeSignatureHash } from '../signature';
import type { ActionDefinition, Identity, ObjectDefinition, Policy, RuntimePolicy } from '../types';

/** Input to {@link buildActionDefinition} / `defineAction` (§3.1). */
export interface DefineActionInput<
  Name extends string,
  Input extends z.ZodType,
  Target extends ObjectDefinition<string, z.ZodType, boolean> | undefined,
  P extends Policy<Input, Target> | undefined,
> {
  name: Name;
  input: Input;
  target?: Target;
  /** Defaults to `${camelCase(target.name)}Id`; must be a key of `input` (AC-1). */
  targetIdFrom?: keyof z.infer<Input> & string;
  policy?: P;
  execute: (args: { input: z.infer<Input>; identity: Identity }) => Promise<unknown> | unknown;
}

/** `Product` -> `productId`. */
const defaultTargetIdFrom = ({ name }: { name: string }): string =>
  `${name.charAt(0).toLowerCase()}${name.slice(1)}Id`;

/**
 * Build an action-type definition: resolve the effective `targetIdFrom`,
 * validate at define time that it names a key of the input schema (throws
 * otherwise — AC-1 runtime half), and compute the input-signature hash (§3.4).
 */
export const buildActionDefinition = <
  Name extends string,
  Input extends z.ZodType,
  Target extends ObjectDefinition<string, z.ZodType, boolean> | undefined = undefined,
  P extends Policy<Input, Target> | undefined = undefined,
>(
  def: DefineActionInput<Name, Input, Target, P>,
): ActionDefinition<Name, Input> => {
  const policy = def.policy as RuntimePolicy | undefined;

  let targetIdFrom: string | undefined;

  if (def.target) {
    targetIdFrom = def.targetIdFrom ?? defaultTargetIdFrom({ name: def.target.name });

    const keys = shapeKeys({ schema: def.input });
    if (!keys.includes(targetIdFrom)) {
      throw new Error(
        `defineAction("${def.name}"): targetIdFrom "${targetIdFrom}" is not a key of the input schema (keys: ${keys.join(', ') || '<none>'})`,
      );
    }
  }

  const signatureHash = computeSignatureHash({ actionName: def.name, input: def.input, policy });

  const base = {
    kind: 'action' as const,
    name: def.name,
    input: def.input,
    execute: def.execute,
    signatureHash,
  };

  const withTarget =
    def.target && targetIdFrom !== undefined ? { ...base, target: def.target, targetIdFrom } : base;

  const withPolicy = policy ? { ...withTarget, policy } : withTarget;

  return withPolicy as ActionDefinition<Name, Input>;
};
