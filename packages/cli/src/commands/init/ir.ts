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

/** An input field on a scanned action (OpenAPI request body / path param). */
export interface IrActionField {
  name: string;
  kind: 'scalar' | 'enum';
  scalar?: IrScalar;
  enumValues?: string[];
  optional: boolean;
}

/** A scanned action type (OpenAPI write operation). */
export interface IrAction {
  /** The MCP-safe, identifier-safe registry name (already sanitized). */
  name: string;
  /** The original operation identifier, kept as inert provenance data. */
  rawName?: string;
  method: string;
  path: string;
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
