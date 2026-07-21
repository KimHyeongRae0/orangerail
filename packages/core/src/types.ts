import type { z } from 'zod';

/**
 * Resolved caller/approver identity. `null` (handled at the engine boundary)
 * means anonymous. `devMode` marks an identity synthesized by dev mode
 * (§4.6) — the engine stamps it onto every audit record it produces.
 */
export interface Identity {
  subject: string;
  roles: string[];
  devMode?: boolean;
}

/** Transport discriminator carried into {@link ResolveIdentity} (§4.6). */
export type Transport = 'stdio' | 'cli';

/** Read-exposure of an object type. `anonymous` opt-in per §4.6 deny-first. */
export type ReadAccess = 'authenticated' | 'anonymous';

/** Arguments to {@link ResolveContract.get}. */
export interface ResolveGetArgs {
  id: string;
}

/** Arguments to {@link ResolveContract.list} — cursor-based, opaque cursor. */
export interface ResolveListArgs {
  filter?: Record<string, unknown>;
  cursor?: string;
  limit?: number;
}

/** Result of {@link ResolveContract.list}. */
export interface ResolveListResult<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Backend-neutral read contract for an object type (§4/§3.5).
 * `get` returns `null` for not-found (distinct from an error — a throwing
 * adapter fails closed). `list` is optional; absent means no list tool.
 */
export interface ResolveContract<T> {
  get: (args: ResolveGetArgs) => Promise<T | null>;
  list?: (args: ResolveListArgs) => Promise<ResolveListResult<T>>;
}

/**
 * A registered object type. `HasResolve` is a type-level marker recording
 * whether a read `resolve` contract was supplied; a `where` policy requires a
 * target whose marker is `true` (compile error otherwise — §3.1 / AC-1).
 */
export interface ObjectDefinition<
  Name extends string = string,
  Schema extends z.ZodType = z.ZodType,
  HasResolve extends boolean = boolean,
> {
  readonly kind: 'object';
  readonly name: Name;
  readonly schema: Schema;
  readonly readAccess: ReadAccess;
  readonly resolve?: ResolveContract<z.infer<Schema>>;
  /** Type-only marker; never present at runtime (see {@link HasResolve}). */
  readonly __hasResolve?: HasResolve;
}

/** An object type that carries a read `resolve` contract. */
export type ObjectWithResolve = ObjectDefinition<string, z.ZodType, true>;

/** A registered link type between two object types (§3.1, AC-2). */
export interface LinkDefinition<Name extends string = string> {
  readonly kind: 'link';
  readonly name: Name;
  readonly from: ObjectDefinition;
  readonly to: ObjectDefinition;
  readonly cardinality: 'one' | 'many';
}

/** Comparison operators for a declarative `where` predicate (§3.3). */
export type WhereOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

/** Serializable declarative predicate — rendered into docs/MCP schema (§3.3). */
export interface DeclarativeWhere {
  field: string;
  op: WhereOp;
  value: unknown;
}

/** Functional predicate escape hatch — marked non-serializable for docs-gen. */
export type FunctionalWhere<Input extends z.ZodType = z.ZodType> = (ctx: {
  object: unknown;
  input: z.infer<Input>;
  identity: Identity;
}) => boolean;

/** A `where` clause: declarative (serializable) or functional (escape hatch). */
export type WhereClause<Input extends z.ZodType = z.ZodType> =
  DeclarativeWhere | FunctionalWhere<Input>;

/**
 * `where` is allowed only when the action's `target` object carries a
 * `resolve` contract; otherwise its type collapses to `never` and supplying it
 * is a compile error (§3.1 / AC-1). Absent target ⇒ no `where`.
 */
export type WhereField<Input extends z.ZodType, Target> = Target extends ObjectWithResolve
  ? WhereClause<Input>
  : never;

/**
 * Policy for an action requiring human approval. `roles` gate approver
 * authority (never staging). `expiresIn` is reserved, type-only, and ignored
 * at runtime (§3.6, documented "reserved, not yet implemented").
 */
export interface ApprovalPolicy<Input extends z.ZodType = z.ZodType, Target = unknown> {
  approval: 'required';
  roles?: string[];
  where?: WhereField<Input, Target>;
  expiresIn?: number;
}

/**
 * Policy for an auto-executing action. `roles` are forbidden here — roles are
 * approver authority, meaningless without approval, so specifying them is a
 * compile error (discriminated union, §3.1 / AC-3 / §4.6).
 */
export interface AutoPolicy<Input extends z.ZodType = z.ZodType, Target = unknown> {
  approval?: undefined;
  roles?: never;
  where?: WhereField<Input, Target>;
  expiresIn?: never;
}

/** The action policy discriminated union (§3.1). */
export type Policy<Input extends z.ZodType = z.ZodType, Target = unknown> =
  ApprovalPolicy<Input, Target> | AutoPolicy<Input, Target>;

/** Type-erased policy the runtime engine consumes. */
export interface RuntimePolicy {
  approval?: 'required';
  roles?: string[];
  where?: WhereClause;
  expiresIn?: number;
}

/**
 * A registered action type with its input-signature hash (§3.4). `targetIdFrom`
 * is stored resolved (explicit value or the `${camelCase(target.name)}Id`
 * default) whenever a target is present.
 */
export interface ActionDefinition<
  Name extends string = string,
  Input extends z.ZodType = z.ZodType,
> {
  readonly kind: 'action';
  readonly name: Name;
  readonly input: Input;
  readonly target?: ObjectDefinition;
  readonly targetIdFrom?: string;
  readonly policy?: RuntimePolicy;
  readonly execute: (args: {
    input: z.infer<Input>;
    identity: Identity;
  }) => Promise<unknown> | unknown;
  readonly signatureHash: string;
}

/** Type-erased action view the runtime engine consumes. */
export interface RuntimeAction {
  kind: 'action';
  name: string;
  input: z.ZodType;
  target?: ObjectDefinition;
  targetIdFrom?: string;
  policy?: RuntimePolicy;
  execute: (args: { input: unknown; identity: Identity }) => Promise<unknown> | unknown;
  signatureHash: string;
}
