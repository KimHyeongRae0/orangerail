import { getShape, isOptionalField, typeNameOf, type Registry } from 'orangerail-core';

import type { IrAction, IrObject, ScannedSource } from '../init/ir';
import { fieldNode } from '../init/codegen/zod';

/**
 * The pure sync differ (plan D11): scan-IR vs the live registry (the registry
 * is the source of truth). It never writes; it classifies. Field comparison
 * goes through core's own introspection (`getShape` / `typeNameOf` /
 * `isOptionalField`) on BOTH sides — the registry node and the node the re-scan
 * WOULD generate (via the shared `fieldNode` builder) — so a field is "drifted"
 * iff the two introspect differently. This makes a Prisma `Float -> Decimal`
 * (number vs string), an added/removed field, and an optionality flip all
 * observable without re-implementing zod comparison.
 */

/** A single field-level drift on an existing object. */
export interface FieldDrift {
  object: string;
  field: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
}

/** The full classification result. */
export interface SyncDiff {
  /** Scanned objects with no matching registry object — new-model proposals. */
  newObjects: IrObject[];
  /** Scanned actions with no matching registry action — proposals. */
  newActions: IrAction[];
  /** Field-level drift on objects present in both. */
  fieldDrifts: FieldDrift[];
  /** Registry objects absent from the scan — user-owned extensions (info only). */
  registryOnlyObjects: string[];
}

interface Probe {
  typeName: string;
  optional: boolean;
}

const probeRegistryFields = ({
  schema,
}: {
  schema: Parameters<typeof getShape>[0]['schema'];
}): Map<string, Probe> => {
  const shape = getShape({ schema });
  const out = new Map<string, Probe>();

  for (const key of Object.keys(shape)) {
    out.set(key, {
      typeName: typeNameOf({ node: shape[key] }),
      optional: isOptionalField({ node: shape[key] }),
    });
  }

  return out;
};

const probeScannedFields = ({ object }: { object: IrObject }): Map<string, Probe> => {
  const out = new Map<string, Probe>();

  for (const field of object.fields) {
    const node = fieldNode({ field });
    out.set(field.name, {
      typeName: typeNameOf({ node }),
      optional: isOptionalField({ node }),
    });
  }

  return out;
};

const diffObjectFields = ({
  object,
  registrySchema,
}: {
  object: IrObject;
  registrySchema: Parameters<typeof getShape>[0]['schema'];
}): FieldDrift[] => {
  const registryFields = probeRegistryFields({ schema: registrySchema });
  const scannedFields = probeScannedFields({ object });
  const drifts: FieldDrift[] = [];

  const keys = [...new Set([...registryFields.keys(), ...scannedFields.keys()])].sort();

  for (const key of keys) {
    const inRegistry = registryFields.get(key);
    const inScan = scannedFields.get(key);

    if (inRegistry === undefined && inScan !== undefined) {
      drifts.push({
        object: object.name,
        field: key,
        kind: 'added',
        detail: 'field added in source',
      });
      continue;
    }

    if (inRegistry !== undefined && inScan === undefined) {
      drifts.push({
        object: object.name,
        field: key,
        kind: 'removed',
        detail: 'field removed from source',
      });
      continue;
    }

    if (inRegistry !== undefined && inScan !== undefined) {
      if (inRegistry.typeName !== inScan.typeName || inRegistry.optional !== inScan.optional) {
        drifts.push({
          object: object.name,
          field: key,
          kind: 'changed',
          detail: `type/optionality changed (was ${inRegistry.typeName}${inRegistry.optional ? '?' : ''}, now ${inScan.typeName}${inScan.optional ? '?' : ''})`,
        });
      }
    }
  }

  return drifts;
};

/** Diff a re-scanned source against the live registry (pure, no I/O). */
export const diffSync = ({
  scanned,
  registry,
}: {
  scanned: ScannedSource;
  registry: Registry;
}): SyncDiff => {
  const registryObjects = new Map(registry.listObjects().map((o) => [o.name, o]));
  const registryActionNames = new Set(registry.listActions().map((a) => a.name));
  const scannedObjectNames = new Set(scanned.objects.map((o) => o.name));

  const newObjects: IrObject[] = [];
  const fieldDrifts: FieldDrift[] = [];

  for (const object of scanned.objects) {
    const registryObject = registryObjects.get(object.name);

    if (registryObject === undefined) {
      newObjects.push(object);
      continue;
    }

    fieldDrifts.push(...diffObjectFields({ object, registrySchema: registryObject.schema }));
  }

  const newActions = scanned.actions.filter((a) => !registryActionNames.has(a.name));

  const registryOnlyObjects = [...registryObjects.keys()]
    .filter((name) => !scannedObjectNames.has(name))
    .sort();

  return { newObjects, newActions, fieldDrifts, registryOnlyObjects };
};
