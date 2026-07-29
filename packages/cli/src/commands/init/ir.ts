/**
 * The intermediate representation (IR) every scanner produces and codegen
 * consumes (plan D2). Scanners (Prisma, OpenAPI) map their source format into
 * this shared shape; codegen and the sync differ read the IR only, so adding a
 * future source is a new scanner module plus one registration line (AC-8) with
 * no changes to codegen or flow logic.
 */

/**
 * Zod-mappable scalar kinds. Distinct kinds are preserved even when two render
 * to the same zod expression, because the sync differ compares the zod type
 * name a field WOULD generate against the live registry (e.g. Decimal renders
 * `z.string()` while Float renders `z.number()`, so a Float -> Decimal change
 * is observable as a type-name drift).
 */
export type IrScalar =
  'string' | 'int' | 'float' | 'bigint' | 'decimal' | 'boolean' | 'datetime' | 'json' | 'bytes';

/** A scalar or enum field on a scanned object (relations are not fields). */
export interface IrField {
  name: string;
  kind: 'scalar' | 'enum';
  /** Present when `kind === 'scalar'`. */
  scalar?: IrScalar;
  /** Present when `kind === 'enum'`: the enum member names, in declared order. */
  enumValues?: string[];
  optional: boolean;
  list: boolean;
  isId: boolean;
  /** True when the field declares `@default(...)` (Prisma fills it if omitted). */
  hasDefault?: boolean;
  /** True when the field declares `@updatedAt` (Prisma-managed, never written). */
  updatedAt?: boolean;
}

/** A relation from one object to another (Prisma model reference). */
export interface IrRelation {
  /** The relation field name on the owning object. */
  field: string;
  /** The referenced object (model) name. */
  target: string;
  cardinality: 'one' | 'many';
}

/** A scanned object type (Prisma model). */
export interface IrObject {
  name: string;
  fields: IrField[];
  relations: IrRelation[];
  /** The id field name, when the model declares an `@id`. */
  idField?: string;
  /** Human-readable provenance kept as inert data (e.g. mapped table name). */
  provenance?: string;
}

/** An enum type scanned from the source (Prisma `enum` block). */
export interface IrEnum {
  name: string;
  values: string[];
}

/**
 * Declared value constraints an action input field carries into the emitted zod
 * (ONT-037). Each key is named after the zod method it renders to, so the
 * emitter is a table lookup and no mapping knowledge lives in two places;
 * `min`/`max` are a length bound on a string kind and a value bound on a numeric
 * kind, exactly the way zod's own `.min()`/`.max()` are overloaded.
 *
 * Only `IrActionField` carries these. The object side is scanned from Prisma,
 * whose schema language declares no value constraints, and keeping the bounds
 * off `IrField` also keeps them out of the sync differ's field probe (which
 * reads `IrObject.fields` only) — so an existing project sees no new drift.
 */
export interface IrValueConstraints {
  /** Inclusive lower bound — `.min(n)`. */
  min?: number;
  /** Inclusive upper bound — `.max(n)`. */
  max?: number;
  /** Exclusive lower bound — `.gt(n)` (numeric kinds only). */
  gt?: number;
  /** Exclusive upper bound — `.lt(n)` (numeric kinds only). */
  lt?: number;
  /** ECMA-262 pattern source — `.regex(new RegExp(...))` (string kind only). */
  regex?: string;
}

/** An input field on a scanned action (OpenAPI request body / path param). */
export interface IrActionField {
  name: string;
  kind: 'scalar' | 'enum';
  scalar?: IrScalar;
  enumValues?: string[];
  optional: boolean;
  /**
   * Value constraints the source declared, honored by the emitted zod (ONT-037).
   * Absent — not an empty object — when the source declared none, so a
   * constraint-free field stays byte-identical to the pre-ONT-037 emitter.
   */
  constraints?: IrValueConstraints;
}

/**
 * A synthesized Prisma write action's execution metadata (plan D1/D3). The
 * `model` is the scanned model name and is kept in lockstep with the owning
 * `IrObject.name` by the global allocator (`scan.ts` `allocateNames`) so the
 * emitter can recompute the client accessor from it at EMIT time, mirroring the
 * read side (`emit-object.ts` `accessorName`). The client accessor is never
 * embedded here — it is derived from `model` when the file is rendered, so a
 * collision-rename tracked onto `model` keeps read/write pointed at the same
 * `prisma.<accessor>` member (plan-review finding 2).
 */
export interface IrPrismaAction {
  /** The scanned model name (allocator-tracked; drives the emit-time accessor). */
  model: string;
  /** Which CRUD operation this action performs. */
  op: 'create' | 'update' | 'delete';
  /** The single `@id` field name, present for `update` / `delete` (the `where` key). */
  idField?: string;
}

/** A scanned action type (an OpenAPI write operation or a Prisma CRUD action). */
export interface IrAction {
  /** The MCP-safe, identifier-safe registry name (already sanitized). */
  name: string;
  /** The original operation identifier, kept as inert provenance data. */
  rawName?: string;
  /** Which scanner produced this action; selects the emitter branch (plan D4). */
  source: 'openapi' | 'prisma';
  /** OpenAPI HTTP method (openapi-source only). */
  method?: string;
  /** OpenAPI request path (openapi-source only). */
  path?: string;
  /** Prisma execution metadata (prisma-source only). */
  prisma?: IrPrismaAction;
  write: boolean;
  input: IrActionField[];
  /** Provenance description (operation summary), kept as inert data. */
  description?: string;
}

/** The full result of scanning one source file. */
export interface ScannedSource {
  objects: IrObject[];
  enums: IrEnum[];
  actions: IrAction[];
  /** Skip-with-warning diagnostics (unsupported constructs). */
  warnings: string[];
  /** Informational lines (e.g. GET operations skipped by design). */
  infos: string[];
}

/** An empty scanned source, used as a reduction seed. */
export const emptySource = (): ScannedSource => ({
  objects: [],
  enums: [],
  actions: [],
  warnings: [],
  infos: [],
});

/** Merge two scanned sources into one (objects/enums/actions concatenated). */
export const mergeSources = ({ a, b }: { a: ScannedSource; b: ScannedSource }): ScannedSource => ({
  objects: [...a.objects, ...b.objects],
  enums: [...a.enums, ...b.enums],
  actions: [...a.actions, ...b.actions],
  warnings: [...a.warnings, ...b.warnings],
  infos: [...a.infos, ...b.infos],
});
