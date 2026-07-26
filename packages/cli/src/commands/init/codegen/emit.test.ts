import { describe, expect, it } from 'vitest';

import type { IrAction, IrObject, ScannedSource } from '../ir';
import { emptySource } from '../ir';
import { allocateNames } from '../scan';
import { buildFileSet } from './index';
import {
  accessorName,
  buildResolveDiagnostic,
  emitObjectFile,
  wrapResolveError,
} from './emit-object';
import { emitActionFile } from './emit-action';

const product: IrObject = {
  name: 'Product',
  idField: 'id',
  provenance: 'Prisma model Product',
  relations: [{ field: 'items', target: 'OrderItem', cardinality: 'many' }],
  fields: [
    { name: 'id', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: true },
    { name: 'title', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: false },
    { name: 'price', kind: 'scalar', scalar: 'float', optional: false, list: false, isId: false },
    {
      name: 'status',
      kind: 'enum',
      enumValues: ['DRAFT', 'ACTIVE'],
      optional: false,
      list: false,
      isId: false,
    },
  ],
};

const orderItem: IrObject = {
  name: 'OrderItem',
  idField: 'id',
  relations: [],
  fields: [
    { name: 'id', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: true },
  ],
};

const coupon: IrAction = {
  name: 'grant_import_fs_coupon',
  source: 'openapi',
  rawName: "grant'); import(`fs`); /* coupon",
  method: 'POST',
  path: '/coupons',
  write: true,
  description: 'Hostile summary */ terminator',
  input: [{ name: 'customerId', kind: 'scalar', scalar: 'string', optional: false }],
};

const sourceOf = ({
  objects,
  actions,
}: {
  objects: IrObject[];
  actions: IrAction[];
}): ScannedSource => ({
  ...emptySource(),
  objects,
  actions,
});

describe('emitObjectFile', () => {
  it('emits a working resolve and a lazy prisma import (D6)', () => {
    const { content, filename } = emitObjectFile({ object: product });

    expect(filename).toBe('Product.mjs');
    expect(content).toContain('registry.defineObject({');
    expect(content).toContain('name: "Product"');
    expect(content).toContain('z.enum(["DRAFT", "ACTIVE"])');
    expect(content).toContain("await import('@prisma/client')");
    expect(content).toContain('prisma.product.findUnique');
    expect(content).toContain('prisma.product.findMany({ take: 50 })');
    // user-owned: ownership line present, do-not-edit ABSENT (AC-6)
    expect(content).toMatch(/orangerail sync/);
    expect(content).not.toMatch(/do[ -]?not[ -]?edit/i);
  });

  it('coerces a numeric primary key with Number(id) in resolve.get (ONT-022)', () => {
    // `ResolveGetArgs.id` is a string at the resolve boundary, but Prisma keys a
    // numeric `@id` column by number — a bare string is rejected with a raw
    // validation error. The get resolver must coerce a numeric key so that both
    // the MCP `<Object>_get` tool and the engine's target fetch resolve by id.
    const numericKeyed: IrObject = {
      name: 'Ticket',
      idField: 'id',
      relations: [],
      fields: [
        { name: 'id', kind: 'scalar', scalar: 'int', optional: false, list: false, isId: true },
      ],
    };

    const { content } = emitObjectFile({ object: numericKeyed });

    expect(content).toContain('findUnique({ where: { "id": Number(id) } })');
    expect(content).not.toContain('findUnique({ where: { "id": id } })');
  });

  it('leaves a string primary key un-coerced in resolve.get (ONT-022 regression)', () => {
    // The `product` fixture is string-keyed; coercion must NOT wrap it, or a
    // uuid/cuid key would be corrupted by Number(...).
    const { content } = emitObjectFile({ object: product });

    expect(content).toContain('findUnique({ where: { "id": id } })');
    expect(content).not.toContain('Number(id)');
  });

  it('wraps the resolve in an actionable no-client diagnostic (AC-3 / I4)', () => {
    const { content } = emitObjectFile({ object: product });

    // The resolve body is guarded and rethrows through the diagnostic wrapper.
    expect(content).toContain('} catch (error) {');
    expect(content).toContain('throw wrapPrismaError(error);');

    // The wrapper branches on both module-resolution error codes AND a
    // TypeError (resolved-but-not-generated client) and, when matched, throws a
    // diagnostic naming the object + the exact fix commands.
    expect(content).toContain('ERR_MODULE_NOT_FOUND');
    expect(content).toContain('MODULE_NOT_FOUND');
    expect(content).toContain('error instanceof TypeError');
    expect(content).toContain('object \\"Product\\"');
    expect(content).toContain('@prisma/client');
    expect(content).toContain('npx prisma generate');
    expect(content).toContain('DATABASE_URL');
    expect(content).toContain('Original error');
  });
});

describe('wrapResolveError (I4 — resolve-time diagnostic logic)', () => {
  it('rethrows a module-resolution failure as the actionable diagnostic with the original detail', () => {
    const raw = Object.assign(new Error("Cannot find module '.prisma/client/default'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });

    const wrapped = wrapResolveError({ objectName: 'Post', error: raw }) as Error;

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).not.toBe(raw);
    for (const needle of ['Post', '@prisma/client', 'prisma generate', 'DATABASE_URL']) {
      expect(wrapped.message).toContain(needle);
    }
    // The raw module error is preserved as a detail, not the headline.
    expect(wrapped.message).toContain("Cannot find module '.prisma/client/default'");
  });

  it('also matches the CJS MODULE_NOT_FOUND code', () => {
    const raw = Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' });
    const wrapped = wrapResolveError({ objectName: 'Post', error: raw }) as Error;

    expect(wrapped.message).toContain(buildResolveDiagnostic({ objectName: 'Post' }));
  });

  it('rethrows a non-module error untouched (never masks a real runtime failure)', () => {
    const raw = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(wrapResolveError({ objectName: 'Post', error: raw })).toBe(raw);
  });

  it('maps a resolved-but-not-generated client (TypeError on the model accessor) to the diagnostic', () => {
    // `@prisma/client` resolves but was never generated for this model, so the
    // accessor is undefined and the resolve throws a TypeError reading the op
    // off it. That is the same actionable situation as a missing install — the
    // guarantee is "actionable diagnostic, never a raw crash" (ONT-008 AC-3).
    const raw = new TypeError("Cannot read properties of undefined (reading 'findMany')");

    const wrapped = wrapResolveError({ objectName: 'Post', error: raw }) as Error;

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).not.toBe(raw);
    for (const needle of ['Post', '@prisma/client', 'prisma generate', 'DATABASE_URL']) {
      expect(wrapped.message).toContain(needle);
    }
  });
});

describe('emitActionFile', () => {
  it('emits approval:required + notImplemented and keeps hostile raw as inert data', () => {
    const { content } = emitActionFile({ action: coupon });

    expect(content).toContain('name: "grant_import_fs_coupon"');
    expect(content).toMatch(/approval:\s*'required'/);
    expect(content).toContain('execute: notImplemented');
    // hostile original kept only in a comment, terminator neutralized
    expect(content).not.toContain('*/ end');
    expect(content.split('\n').filter((l) => l.includes('*/')).length).toBe(1); // only the JSDoc close
  });

  it('emits a legal JS binding when the MCP-safe name contains hyphens', () => {
    // Real-world case: GitHub-style operationIds like
    // `actions/create-workflow-dispatch` sanitize to a hyphenated MCP name,
    // which is charset-legal for tools but not a valid JS identifier.
    const dispatch: IrAction = {
      ...coupon,
      name: 'actions_create-workflow-dispatch',
      rawName: 'actions/create-workflow-dispatch',
    };

    const { content, filename } = emitActionFile({ action: dispatch });
    const exported = content.match(/export const (\S+) =/)?.[1];

    expect(exported).toBe('actions_create_workflow_dispatch');
    expect(exported).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    // The registry/MCP tool name keeps the hyphenated form (a legal MCP name),
    // but the filename stem is re-sanitized at the sink (ONT-015, AC-4) so it
    // agrees with the export binding by an identical rule.
    expect(content).toContain('name: "actions_create-workflow-dispatch"');
    expect(filename).toBe('actions_create_workflow_dispatch.mjs');
  });
});

describe('emitActionFile — Prisma-source actions (real execute, plan D3)', () => {
  const createNote: IrAction = {
    name: 'createNote',
    source: 'prisma',
    prisma: { model: 'Note', op: 'create' },
    write: true,
    input: [
      { name: 'title', kind: 'scalar', scalar: 'string', optional: false },
      { name: 'done', kind: 'scalar', scalar: 'boolean', optional: true },
    ],
  };

  const updateNote: IrAction = {
    name: 'updateNote',
    source: 'prisma',
    prisma: { model: 'Note', op: 'update', idField: 'id' },
    write: true,
    input: [
      { name: 'id', kind: 'scalar', scalar: 'int', optional: false },
      { name: 'title', kind: 'scalar', scalar: 'string', optional: true },
    ],
  };

  const deleteNote: IrAction = {
    name: 'deleteNote',
    source: 'prisma',
    prisma: { model: 'Note', op: 'delete', idField: 'id' },
    write: true,
    input: [{ name: 'id', kind: 'scalar', scalar: 'int', optional: false }],
  };

  it('emits a real prisma.<accessor>.create with a data body, not the stub', () => {
    const { content } = emitActionFile({ action: createNote });

    expect(content).toContain('prisma.note.create');
    expect(content).toContain('data: {');
    expect(content).toContain('"title": input["title"]');
    expect(content).toContain('"done": input["done"]');
    expect(content).not.toContain('notImplemented');
    // secure by default is preserved for the Prisma branch too.
    expect(content).toMatch(/approval:\s*'required'/);
    // the shared lazy-client plumbing is inlined (D3 reuse).
    expect(content).toContain("await import('@prisma/client')");
    expect(content).toContain('throw wrapPrismaError(error);');
  });

  it('emits update as where(id) + a partial data body over the non-id fields', () => {
    const { content } = emitActionFile({ action: updateNote });

    expect(content).toContain('prisma.note.update');
    expect(content).toContain('where: { "id": input["id"] }');
    expect(content).toContain('"title": input["title"]');
    // the id is the where key, never a data field.
    expect(content).not.toContain('"id": input["id"],');
  });

  it('emits delete as a where(id)-only call and marks it DESTRUCTIVE (AC-5)', () => {
    const { content } = emitActionFile({ action: deleteNote });

    expect(content).toContain('prisma.note.delete({ where: { "id": input["id"] } })');
    expect(content).toMatch(/DESTRUCTIVE/);
    expect(content).not.toContain('notImplemented');
  });

  it('gives update/delete a target + targetIdFrom so the map connects them (ONT-022)', () => {
    // update/delete act on an existing row keyed by `idField`, so they carry a
    // `target` (imported from the object file) with `targetIdFrom` pointing at
    // the input key. This connects the action to its object in the studio map
    // (a self-loop on the target) and lets a future `where` gate on the row.
    for (const action of [updateNote, deleteNote]) {
      const { content } = emitActionFile({ action });

      expect(content).toContain("import { Note } from './Note.mjs';");
      expect(content).toContain('target: Note,');
      expect(content).toContain('targetIdFrom: "id",');
    }
  });

  it('leaves create target-less — a create has no pre-existing target row (ONT-022)', () => {
    // Declaring a target on create would demand a targetIdFrom key its input
    // cannot supply (defineAction would throw at load), and there is no row to
    // point at yet — so a create stays a free-standing action in the map.
    const { content } = emitActionFile({ action: createNote });

    expect(content).not.toContain('target:');
    expect(content).not.toContain('targetIdFrom:');
    expect(content).not.toContain("from './Note.mjs'");
  });

  it('is byte-stable across two emits (NOLLM-01: no Date.now / Math.random)', () => {
    expect(emitActionFile({ action: createNote }).content).toBe(
      emitActionFile({ action: createNote }).content,
    );
  });

  it('sinks a hostile field name through escapeStringLiteral on both key and read', () => {
    const hostile: IrAction = {
      name: 'createEvil',
      source: 'prisma',
      prisma: { model: 'Evil', op: 'create' },
      write: true,
      input: [
        { name: 'a"]; process.exit(1); ["b', kind: 'scalar', scalar: 'string', optional: false },
      ],
    };

    const { content } = emitActionFile({ action: hostile });

    // The payload only ever appears as a JSON-stringified literal (its `"` are
    // backslash-escaped, so it can neither close the data key nor the input
    // index and inject a statement). It is used TWICE — the data key and the
    // input[...] read — and never as a bare, unescaped token.
    const escaped = JSON.stringify('a"]; process.exit(1); ["b');
    // present as the escaped literal (input schema key, data key, input read),
    // never as a bare unescaped token that could break out and inject.
    expect(content).toContain(`${escaped}: input[${escaped}]`);
    expect(content).not.toContain('a"]; process.exit(1); ["b');
  });
});

describe('read/write accessor parity across an allocator collision-rename (finding 2)', () => {
  it('keeps the write execute on the SAME prisma.<accessor> as the read resolve', () => {
    // Two objects whose sanitized identifiers collide: the second is renamed by
    // the allocator. Its Prisma create action must recompute its accessor from
    // the POST-allocation model name, matching what the object's resolve emits.
    const first: IrObject = {
      name: 'Note',
      idField: 'id',
      relations: [],
      fields: [
        { name: 'id', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: true },
      ],
    };
    // `Note_` sanitizes to `Note` (trailing underscore stripped) — collides.
    const second: IrObject = {
      name: 'Note_',
      idField: 'id',
      relations: [],
      fields: [
        { name: 'id', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: true },
      ],
    };
    const secondCreate: IrAction = {
      name: 'createNote_',
      source: 'prisma',
      prisma: { model: 'Note_', op: 'create' },
      write: true,
      input: [{ name: 'id', kind: 'scalar', scalar: 'string', optional: false }],
    };

    const allocated = allocateNames({
      source: { ...emptySource(), objects: [first, second], actions: [secondCreate] },
    });

    const renamedObject = allocated.objects[1]!;
    const renamedAction = allocated.actions[0]!;

    // the object WAS renamed (collision resolved).
    expect(renamedObject.name).not.toBe('Note_');
    // the action's model reference tracked the rename.
    expect(renamedAction.prisma?.model).toBe(renamedObject.name);

    const readAccessor = accessorName({ name: renamedObject.name });
    const writeAccessor = accessorName({ name: renamedAction.prisma!.model });
    expect(writeAccessor).toBe(readAccessor);

    // and the emitted files agree at the byte level on the client member.
    const objectFile = emitObjectFile({ object: renamedObject });
    const actionFile = emitActionFile({ action: renamedAction });
    expect(objectFile.content).toContain(`prisma.${readAccessor}.findUnique`);
    expect(actionFile.content).toContain(`prisma.${writeAccessor}.create`);
  });
});

describe('buildFileSet', () => {
  it('is byte-deterministic across two renders (AC-9)', () => {
    const source = sourceOf({ objects: [product, orderItem], actions: [coupon] });

    const a = buildFileSet({ source, preset: 'approval-for-writes' });
    const b = buildFileSet({ source, preset: 'approval-for-writes' });

    expect(a).toEqual(b);
  });

  it('emits config + registry + one link + object + action files', () => {
    const source = sourceOf({ objects: [product, orderItem], actions: [coupon] });
    const paths = buildFileSet({ source, preset: 'approval-for-writes' })
      .map((f) => f.path)
      .sort();

    expect(paths).toContain('orangerail.config.mjs');
    expect(paths).toContain('ontology/_registry.mjs');
    expect(paths).toContain('ontology/_links.mjs');
    expect(paths).toContain('ontology/Product.mjs');
    expect(paths).toContain('ontology/grant_import_fs_coupon.mjs');
  });
});
