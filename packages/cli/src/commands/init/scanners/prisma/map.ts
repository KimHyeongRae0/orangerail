import type { IrEnum, IrField, IrObject, IrRelation, IrScalar, ScannedSource } from '../../ir';
import { emptySource } from '../../ir';
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

    const isId = hasAttribute({ attributes: field.attributes, attr: 'id' });

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

  const enums: IrEnum[] = parsed.enums.map((e) => ({ name: e.name, values: [...e.values] }));
  source.enums.push(...enums);

  return source;
};
