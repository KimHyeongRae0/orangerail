import type { IrAction, IrActionField, IrField, IrObject } from '../../ir';
import { sanitizeMcpName } from '../../codegen/escape';

/**
 * Synthesize governed CRUD write actions from scanned Prisma models (plan
 * D1/D2). Each mutable model yields up to three `IrAction`s — `create<Model>`,
 * `update<Model>`, `delete<Model>` — whose `execute` the emitter renders as a
 * real `prisma.<accessor>.<op>(...)` reusing the ONT-008 client plumbing. This
 * module is a pure function of the classified IR: no schema re-parse, no
 * network, no timestamps/randomness (NOLLM-01), so the same models always
 * synthesize the same actions in the same order.
 *
 * Ordering is deterministic: models in `objects` (source) order, then
 * create -> update -> delete per model. Names are minted through the ONT-015
 * MCP-name sink; the global allocator (`scan.ts`) de-collides them afterwards.
 */

/** A field the write input may carry: a non-list scalar/enum that Prisma does not manage. */
const isWritable = ({ field }: { field: IrField }): boolean =>
  !field.list && field.updatedAt !== true;

/** Convert a scanned object field into an action input field with a chosen optionality. */
const toInputField = ({
  field,
  optional,
}: {
  field: IrField;
  optional: boolean;
}): IrActionField => ({
  name: field.name,
  kind: field.kind,
  ...(field.scalar === undefined ? {} : { scalar: field.scalar }),
  ...(field.enumValues === undefined ? {} : { enumValues: [...field.enumValues] }),
  optional,
});

/**
 * Build the CRUD actions for one model. `create` is always synthesized;
 * `update`/`delete` need a single `@id` to form a correct `where`, so a model
 * without one gets `create` only plus a surfaced warning (plan D2) — never a
 * broken body, never a silent drop.
 */
const actionsForModel = ({
  object,
  warnings,
}: {
  object: IrObject;
  warnings: string[];
}): IrAction[] => {
  const writable = object.fields.filter((field) => isWritable({ field }));

  const created: IrAction[] = [];

  // create: every writable field; optional iff Prisma-optional (`?`) or it has
  // a `@default` (Prisma fills it when omitted). Required-no-default columns
  // stay required so the agent must supply them.
  created.push({
    name: sanitizeMcpName({ value: `create${object.name}` }),
    source: 'prisma',
    prisma: { model: object.name, op: 'create' },
    write: true,
    input: writable.map((field) =>
      toInputField({ field, optional: field.optional || field.hasDefault === true }),
    ),
    description: `Create a ${object.name} row.`,
  });

  const idField = object.idField;

  if (idField === undefined) {
    warnings.push(
      `prisma: model '${object.name}' has no single @id — update/delete not generated (create only)`,
    );

    return created;
  }

  const idIrField = writable.find((field) => field.name === idField);

  // update: the identifier (required) + every other writable field forced
  // optional (partial update — Prisma leaves an omitted/undefined field alone).
  const updateInput: IrActionField[] = writable.map((field) =>
    toInputField({ field, optional: field.name !== idField }),
  );

  created.push({
    name: sanitizeMcpName({ value: `update${object.name}` }),
    source: 'prisma',
    prisma: { model: object.name, op: 'update', idField },
    write: true,
    input: updateInput,
    description: `Update a ${object.name} row by its ${idField}.`,
  });

  // delete: the identifier only (required).
  created.push({
    name: sanitizeMcpName({ value: `delete${object.name}` }),
    source: 'prisma',
    prisma: { model: object.name, op: 'delete', idField },
    write: true,
    input:
      idIrField === undefined
        ? [{ name: idField, kind: 'scalar', scalar: 'string', optional: false }]
        : [toInputField({ field: idIrField, optional: false })],
    description: `Delete a ${object.name} row by its ${idField}.`,
  });

  return created;
};

/** Synthesize the CRUD write actions for every scanned model (plan D1). */
export const synthesizePrismaActions = ({
  objects,
  warnings,
}: {
  objects: IrObject[];
  warnings: string[];
}): IrAction[] => objects.flatMap((object) => actionsForModel({ object, warnings }));
