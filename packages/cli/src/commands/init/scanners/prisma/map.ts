import type { IrEnum, IrField, IrObject, IrRelation, IrScalar, ScannedSource } from '../../ir';
import { emptySource } from '../../ir';
import { synthesizePrismaActions } from './actions';
import type { ParsedSchema, RawField, RawModel } from './parse';

/**
 * Map a raw parsed Prisma schema into the shared IR (plan D3). Field type
 * classification uses the set of declared model and enum names: a field typed
 * as another model is a relation (not a zod field); a field typed as a declared
 * enum is an enum field; a field typed as a supported scalar is a scalar field.
 * `Unsupported(...)` fields and unrecognized types are skipped with a warning —
 * the model survives (AC-9 skip-with-warning discipline). `@map` / `@@map`
 * names are intentionally NOT used: names follow the model/field identifiers,
 * mirroring Prisma Client.
 */

/** Supported Prisma scalar type -> IR scalar kind. */
const SCALAR_MAP: Record<string, IrScalar> = {
  String: 'string',
  Int: 'int',
  Float: 'float',
  BigInt: 'bigint',
  Decimal: 'decimal',
  Boolean: 'boolean',
  DateTime: 'datetime',
  Json: 'json',
  Bytes: 'bytes',
};

/**
 * A field name that a JS object literal cannot carry as a plain key. Emitting
 * `{ "__proto__": … }` sets the object's prototype instead of declaring the key,
 * so such a field would silently disappear from the generated zod object, from
 * the write action's input, and from the Prisma `data:` payload — the column
 * would never be written and nothing would say so (ONT-042 E).
 */
const UNSAFE_KEY = '__proto__';

const hasAttribute = ({ attributes, attr }: { attributes: string; attr: string }): boolean =>
  new RegExp(`(^|\\s)@${attr}\\b`).test(attributes);

const mapModel = ({
  model,
  modelNames,
  enumNames,
  warnings,
}: {
  model: RawModel;
  modelNames: Set<string>;
  enumNames: Set<string>;
  warnings: string[];
}): IrObject => {
  const fields: IrField[] = [];
  const relations: IrRelation[] = [];
  let idField: string | undefined;

  const classify = ({ field }: { field: RawField }): void => {
    if (field.unsupported) {
      warnings.push(
        `prisma: skipping unsupported field ${model.name}.${field.name} (Unsupported(...)) — the model is still generated`,
      );
      return;
    }

    if (field.name === UNSAFE_KEY) {
      warnings.push(
        `prisma: skipping field ${model.name}.${field.name} — a "${UNSAFE_KEY}" key sets a generated object literal's prototype instead of declaring the field, so it would vanish from the schema AND from the write payload; rename the column (\`@map("${UNSAFE_KEY}")\` keeps the database name) or add it by hand`,
      );
      return;
    }

    const isId = hasAttribute({ attributes: field.attributes, attr: 'id' });
    const hasDefault = hasAttribute({ attributes: field.attributes, attr: 'default' });
    const updatedAt = hasAttribute({ attributes: field.attributes, attr: 'updatedAt' });

    if (modelNames.has(field.type)) {
      relations.push({
        field: field.name,
        target: field.type,
        cardinality: field.list ? 'many' : 'one',
      });
      return;
    }

    if (enumNames.has(field.type)) {
      fields.push({
        name: field.name,
        kind: 'enum',
        enumValues: [],
        optional: field.optional,
        list: field.list,
        isId,
        hasDefault,
        updatedAt,
      });
      return;
    }

    const scalar = SCALAR_MAP[field.type];
    if (scalar === undefined) {
      warnings.push(
        `prisma: skipping field ${model.name}.${field.name} with unsupported type "${field.type}" — the model is still generated`,
      );
      return;
    }

    if (isId) {
      idField = field.name;
    }

    fields.push({
      name: field.name,
      kind: 'scalar',
      scalar,
      optional: field.optional,
      list: field.list,
      isId,
      hasDefault,
      updatedAt,
    });
  };

  for (const field of model.fields) {
    classify({ field });
  }

  return {
    name: model.name,
    fields,
    relations,
    ...(idField === undefined ? {} : { idField }),
    // Pinned here, at the only place that still knows the schema verbatim: the
    // emitted `name` may later be MCP-sanitized or collision-renamed, but the
    // Prisma client accessor must keep following the schema (ONT-041).
    sourceModel: model.name,
    provenance: `Prisma model ${model.name}`,
  };
};

/**
 * Attach enum member names to enum fields (the enum block declares the values;
 * the field only names the enum). Field enums are matched by the object model's
 * field type recorded during classification — resolved here from the enum table.
 */
const resolveEnumFields = ({
  objects,
  rawByModel,
  enumsByName,
}: {
  objects: IrObject[];
  rawByModel: Map<string, RawModel>;
  enumsByName: Map<string, string[]>;
}): void => {
  for (const object of objects) {
    const raw = rawByModel.get(object.name);
    if (raw === undefined) {
      continue;
    }

    for (const field of object.fields) {
      if (field.kind !== 'enum') {
        continue;
      }

      const rawField = raw.fields.find((f) => f.name === field.name);
      const values = rawField === undefined ? undefined : enumsByName.get(rawField.type);

      if (values !== undefined) {
        field.enumValues = [...values];
      }
    }
  }
};

/** Map a parsed schema into a scanned source (objects, enums, warnings). */
export const mapPrismaToIr = ({ parsed }: { parsed: ParsedSchema }): ScannedSource => {
  const source = emptySource();

  const modelNames = new Set(parsed.models.map((m) => m.name));
  const enumNames = new Set(parsed.enums.map((e) => e.name));
  const enumsByName = new Map(parsed.enums.map((e) => [e.name, e.values]));
  const rawByModel = new Map(parsed.models.map((m) => [m.name, m]));

  for (const model of parsed.models) {
    source.objects.push(mapModel({ model, modelNames, enumNames, warnings: source.warnings }));
  }

  resolveEnumFields({ objects: source.objects, rawByModel, enumsByName });

  // Governed CRUD write actions are synthesized AFTER enum resolution so an
  // enum field's write input carries its member list (plan D1). Warnings from
  // no-@id models flow into the same skip-with-warning channel.
  source.actions.push(
    ...synthesizePrismaActions({ objects: source.objects, warnings: source.warnings }),
  );

  const enums: IrEnum[] = parsed.enums.map((e) => ({ name: e.name, values: [...e.values] }));
  source.enums.push(...enums);

  if (parsed.invalidBlocks.length > 0) {
    // Prisma rejects these names itself, so the skip is right — but skipping in
    // silence left the user with a model count that did not match their schema.
    source.warnings.push(
      `prisma: skipping ${parsed.invalidBlocks.length} block(s) whose name is not a valid Prisma identifier (${parsed.invalidBlocks.join(', ')}) — a block name must match [A-Za-z_][A-Za-z0-9_]*; rename it (\`@@map\` keeps the table name) and re-run`,
    );
  }

  if (parsed.views.length > 0) {
    // One aggregated skip-with-warning line: views are read models, a natural
    // future object source, but not scanned in v0 — the skip stays visible
    // (never silent) so the user knows those read models were dropped.
    source.warnings.push(
      `prisma: skipping ${parsed.views.length} view block(s) (${parsed.views.join(', ')}) — Prisma views are not scanned in v0`,
    );
  }

  return source;
};
