import type { z } from 'zod';

import { shapeKeys } from '../introspect';
import { renderBigInts } from '../json';
import { computeSignatureHash } from '../signature';
import type {
  ActionDefinition,
  ActionOp,
  Identity,
  ObjectDefinition,
  Policy,
  RuntimePolicy,
} from '../types';

/** Input to {@link buildActionDefinition} / `defineAction` (§3.1). */
export interface DefineActionInput<
  Name extends string,
  Input extends z.ZodType,
  Target extends ObjectDefinition<string, z.ZodType, boolean> | undefined,
  P extends Policy<Input, Target> | undefined,
> {
  name: Name;
  input: Input;
  /**
   * The CRUD operation this action performs, as provenance (ONT-091). Optional,
   * never inferred, and deliberately outside the signature hash — see
   * {@link ActionOp} and `buildActionDefinition`.
   */
  op?: ActionOp;
  target?: Target;
  /** Defaults to `${camelCase(target.name)}Id`; must be a key of `input` (AC-1). */
  targetIdFrom?: keyof z.infer<Input> & string;
  policy?: P;
  execute: (args: { input: z.infer<Input>; identity: Identity }) => Promise<unknown> | unknown;
}

/**
 * Marker tagging an `execute` function as a not-yet-implemented stub (§3.7).
 * A globally-registered symbol so the tag survives module-instance boundaries
 * (a scanner in another package can produce the same marked function).
 */
const NOT_IMPLEMENTED = Symbol.for('orangerail.notImplemented');

/**
 * A placeholder `execute` for actions declared but not yet wired to a backend
 * (§5.1). `defineAction` still requires `execute`; scanners (ONT-006) emit
 * `execute: notImplemented`. The engine rejects it at staging BEFORE creating
 * an approval record and audits phase `not_implemented`; if it ever runs
 * directly it throws (fail-closed).
 */
export const notImplemented = Object.assign(
  async (): Promise<never> => {
    throw new Error('action is not implemented (notImplemented stub)');
  },
  { [NOT_IMPLEMENTED]: true as const },
);

/** Whether an action's `execute` is the {@link notImplemented} stub (§3.7). */
export const isNotImplemented = ({ execute }: { execute: unknown }): boolean =>
  typeof execute === 'function' &&
  (execute as unknown as Record<symbol, unknown>)[NOT_IMPLEMENTED] === true;

/**
 * Wrap an action's `execute` so the value it resolves to carries no `BigInt`
 * (ONT-068).
 *
 * This is the one place every action result passes through before the engine
 * has it, and the engine hands it straight to `appendAudit` — where the record
 * is hashed over its PERSISTED form, i.e. through `JSON.stringify`, which throws
 * on a `BigInt`. The append failure there is swallowed on purpose ("the side
 * effect must not be hidden"), so the cost of one `BigInt` in a returned row was
 * a write that happened, an audit chain that records only that it started, and
 * an `internal_error` telling the agent to retry it.
 *
 * Done here rather than in the emitter because the emitter cannot see the shape
 * it would have to render: a generated `delete` declares only the id in its
 * input, while the row Prisma hands back carries every column — including a
 * `BigInt` foreign key on a model whose own key is an `Int`. It also means a
 * hand-written action gets the same contract as a generated one.
 *
 * The {@link notImplemented} stub is returned UNWRAPPED. Its marker is read off
 * the function itself in three packages, and a wrapper would hide the stub from
 * the staging check that exists to reject it before an approval is ever created.
 */
const renderingExecute = <Args>({
  execute,
}: {
  execute: (args: Args) => Promise<unknown> | unknown;
}): ((args: Args) => Promise<unknown> | unknown) =>
  isNotImplemented({ execute })
    ? execute
    : async (args: Args): Promise<unknown> => renderBigInts({ value: await execute(args) });

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

  // `op` is NOT an argument here, and must never become one (ONT-091). The hash
  // covers `{ actionName, inputShape, policyDeclarative }` and is what staging
  // compares against at execution time, so folding provenance into it would
  // change the hash of every action the moment a project regenerates — failing
  // the signature check on approvals staged before the upgrade, for a field that
  // says nothing about what the action does when it runs.
  const signatureHash = computeSignatureHash({ actionName: def.name, input: def.input, policy });

  const base = {
    kind: 'action' as const,
    name: def.name,
    input: def.input,
    execute: renderingExecute({ execute: def.execute }),
    signatureHash,
  };

  // Spread only when declared, so an action that omits `op` keeps the exact key
  // set it had before this field existed — `canonicalJson` over a definition
  // sees no new `undefined` to render.
  const withOp = def.op ? { ...base, op: def.op } : base;

  const withTarget =
    def.target && targetIdFrom !== undefined
      ? { ...withOp, target: def.target, targetIdFrom }
      : withOp;

  const withPolicy = policy ? { ...withTarget, policy } : withTarget;

  return withPolicy as ActionDefinition<Name, Input>;
};
