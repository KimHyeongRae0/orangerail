import { readPublicDiagnostic } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { IrAction, IrObject, ScannedSource } from '../ir';
import { emptySource } from '../ir';
import { allocateNames } from '../scan';
import { buildFileSet } from './index';
import {
  accessorName,
  buildResolveDiagnostic,
  emitObjectFile,
  prismaClientBlock,
  wrapResolveError,
} from './emit-object';
import { emitActionFile } from './emit-action';
import { type PrismaAdapter, type PrismaConstruction, SUPPORTED_ADAPTERS } from './prisma-runtime';

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
    expect(content).toContain('prisma.product.findMany({');
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

    // numeric key: coerced via Number(id), keyed by the coerced value.
    expect(content).toContain('const key = Number(id);');
    expect(content).toContain('findUnique({ where: { "id": key } })');
    // ONT-024: a non-numeric id fails to a clean not-found, not a raw Prisma NaN.
    expect(content).toContain('if (Number.isNaN(key)) {');
    expect(content).toContain('return null;');
  });

  it('leaves a string primary key un-coerced in resolve.get (ONT-022 regression)', () => {
    // The `product` fixture is string-keyed; coercion must NOT wrap it, or a
    // uuid/cuid key would be corrupted by Number(...).
    const { content } = emitObjectFile({ object: product });

    expect(content).toContain('findUnique({ where: { "id": id } })');
    expect(content).not.toContain('Number(id)');
    expect(content).not.toContain('Number.isNaN'); // no NaN guard for string keys
  });

  it('list honors filter / limit / cursor and returns a nextCursor (ONT-024)', () => {
    // The `<Object>_list` tool advertises filter/limit/cursor and the server
    // forwards them; the generated resolver must actually apply them and page,
    // or a table larger than 50 rows is silently truncated with no escape.
    const { content } = emitObjectFile({ object: product });

    expect(content).toContain('list: async ({ filter, cursor, limit } = {}) => {');
    expect(content).toContain("typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50");
    expect(content).toContain('...(filter ? { where: filter } : {})');
    expect(content).toContain('orderBy: { "id": \'asc\' }');
    expect(content).toContain('take: take + 1');
    expect(content).toContain('cursor: { "id": cursor }'); // string key: no coercion
    expect(content).toContain('nextCursor: String(items[items.length - 1]["id"])');
    expect(content).not.toContain('findMany({ take: 50 })'); // the old ignore-everything form is gone
  });

  it('coerces the list cursor for a numeric key (ONT-024)', () => {
    const numericKeyed: IrObject = {
      name: 'Ticket',
      idField: 'id',
      relations: [],
      fields: [
        { name: 'id', kind: 'scalar', scalar: 'int', optional: false, list: false, isId: true },
      ],
    };

    const { content } = emitObjectFile({ object: numericKeyed });

    expect(content).toContain('cursor: { "id": Number(cursor) }');
  });

  it('wraps the resolve in an actionable no-client diagnostic (AC-3 / I4)', () => {
    const { content } = emitObjectFile({ object: product });

    // The resolve body is guarded and rethrows through the diagnostic wrapper.
    expect(content).toContain('} catch (error) {');
    expect(content).toContain('throw wrapPrismaError(error);');

    // The wrapper branches on both module-resolution error codes AND a
    // TypeError, and picks the diagnostic that matches the cause (ONT-041):
    // module-not-found = the client is not installed/generated; a TypeError =
    // the client loaded but exposes no such model (schema mismatch).
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

    const wrapped = wrapResolveError({ objectName: 'Post', accessor: 'post', error: raw }) as Error;

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
    const wrapped = wrapResolveError({ objectName: 'Post', accessor: 'post', error: raw }) as Error;

    expect(wrapped.message).toContain(buildResolveDiagnostic({ objectName: 'Post' }));
  });

  it('rethrows a non-module error untouched (never masks a real runtime failure)', () => {
    const raw = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(wrapResolveError({ objectName: 'Post', accessor: 'post', error: raw })).toBe(raw);
  });

  it('maps a missing model accessor (TypeError) to a SCHEMA-MISMATCH diagnostic, not "not installed" (ONT-041)', () => {
    // The client loaded — it simply carries no such model, so the accessor is
    // undefined and reading an op off it throws a TypeError. Telling the user
    // to `npm install @prisma/client && npx prisma generate` is a dead end for
    // a client that is already installed: it must say the client and the schema
    // disagree, and name the accessor it looked for.
    const raw = new TypeError("Cannot read properties of undefined (reading 'findMany')");

    const wrapped = wrapResolveError({ objectName: 'Post', accessor: 'post', error: raw }) as Error;

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).not.toBe(raw);
    expect(wrapped.message).toContain('Post');
    expect(wrapped.message).toContain('"post"');
    expect(wrapped.message).toContain('generated from a different schema');
    // the misdiagnosis is gone.
    expect(wrapped.message).not.toContain('not generated or installed');
    expect(wrapped.message).not.toContain('npm install @prisma/client');
  });
});

describe('wrapResolveError — public diagnostic marking (ONT-045)', () => {
  it('marks a missing client so the MCP transport can name the fix', () => {
    const raw = Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' });
    const wrapped = wrapResolveError({ objectName: 'Post', accessor: 'post', error: raw });

    expect(readPublicDiagnostic({ error: wrapped })).toEqual({
      code: 'datasource_client_missing',
      subject: 'Post',
    });
  });

  it('marks a schema mismatch with its own distinct code', () => {
    const raw = new TypeError("Cannot read properties of undefined (reading 'findMany')");
    const wrapped = wrapResolveError({ objectName: 'Post', accessor: 'post', error: raw });

    expect(readPublicDiagnostic({ error: wrapped })).toEqual({
      code: 'datasource_model_missing',
      subject: 'Post',
    });
  });

  it('marks a Prisma initialization failure WITHOUT rewriting its message', () => {
    // The unset-DATABASE_URL case. Prisma's text is the operator's evidence and
    // stays intact for the host log; the mark is what the agent gets rendered
    // from, and it is orangerail's own sentence.
    const raw = new Error('Environment variable not found: DATABASE_URL.');
    raw.name = 'PrismaClientInitializationError';

    const wrapped = wrapResolveError({ objectName: 'Note', accessor: 'note', error: raw });

    expect(wrapped).toBe(raw);
    expect((wrapped as Error).message).toBe('Environment variable not found: DATABASE_URL.');
    expect(readPublicDiagnostic({ error: wrapped })).toEqual({
      code: 'datasource_not_configured',
    });
  });

  it('leaves a genuine query failure unmarked, so it stays fully redacted', () => {
    const raw = new Error('Unique constraint failed on the fields: (`email`)');

    const wrapped = wrapResolveError({ objectName: 'User', accessor: 'user', error: raw });

    expect(wrapped).toBe(raw);
    expect(readPublicDiagnostic({ error: wrapped })).toBeUndefined();
  });

  it('emits the same marking inline into the generated file', () => {
    const { content } = emitObjectFile({ object: product });

    // The generated file must be able to mark without importing orangerail —
    // it is a user-owned .mjs whose only imports are zod, the registry, and the
    // Prisma client. The global symbol registry is what makes that possible.
    expect(content).toContain("Symbol.for('orangerail.publicDiagnostic')");
    expect(content).toContain("'datasource_client_missing'");
    expect(content).toContain("'datasource_model_missing'");
    expect(content).toContain("'datasource_not_configured'");
    expect(content).toContain("error.name === 'PrismaClientInitializationError'");
    // enumerable: false — the mark must never show up in a JSON dump or a spread.
    expect(content).toContain('enumerable: false');
  });

  it('awaits inside the try, so the diagnostic wrapper is actually reachable', async () => {
    // The bug this pins (ONT-045): `try { return prisma.x.op(...) } catch {}` in
    // an async function settles the promise AFTER the try block is left, so the
    // catch never runs and the raw driver error escapes unwrapped. Every
    // generated write and every `get` resolve had it, which made the whole
    // `wrapPrismaError` layer dead code on those paths. Asserting on the emitted
    // TEXT would pass on a `return await` that was never exercised, so this
    // executes the emitted body against a rejecting client instead.
    const objectFile = emitObjectFile({ object: product }).content;
    const actionFile = emitActionFile({
      action: {
        name: 'createProduct',
        method: 'POST',
        path: '/products',
        source: 'prisma',
        prisma: { model: 'Product', sourceModel: 'Product', op: 'create' },
        write: true,
        input: [{ name: 'sku', kind: 'scalar', scalar: 'string', optional: false }],
      },
    }).content;

    const rejection = new TypeError("Cannot read properties of undefined (reading 'create')");

    for (const [label, source] of [
      ['object get', objectFile],
      ['action execute', actionFile],
    ] as const) {
      // Re-run the emitted body with a client that rejects, replacing only the
      // lazy client factory. Everything else — the try/catch, the await, the
      // wrapper — is the emitted text verbatim.
      const body = source
        .slice(source.indexOf('const getPrisma'))
        .replace(
          /const getPrisma = \(\(\) => \{[\s\S]*?\}\)\(\);/,
          'const getPrisma = async () => new Proxy({}, { get: () => new Proxy({}, { get: () => () => Promise.reject(REJECTION) }) });',
        )
        .replace(/export const \w+ = registry\.define\w+\(\{/, 'const definition = ({')
        .replace(/\}\);\s*$/, '});');

      const factory = new Function('REJECTION', 'z', `${body}\nreturn definition;`) as (
        rejection: unknown,
        zod: unknown,
      ) => Record<string, unknown>;
      const definition = factory(rejection, z);

      const run =
        label === 'object get'
          ? () =>
              (definition['resolve'] as { get: (a: { id: string }) => Promise<unknown> }).get({
                id: '1',
              })
          : () =>
              (definition['execute'] as (a: { input: unknown }) => Promise<unknown>)({
                input: { sku: 's' },
              });

      const caught = await run().then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(caught, `${label}: the rejection must reach the catch`).toBeInstanceOf(Error);
      expect(readPublicDiagnostic({ error: caught }), label).toEqual({
        code: 'datasource_model_missing',
        subject: 'Product',
      });
    }
  });

  it('the emitted wrapper behaves exactly like the exported one', async () => {
    // The generated JS is a hand-written mirror of `wrapResolveError`. Evaluate
    // it and drive both through the same inputs, so the mirror cannot drift.
    const block = prismaClientBlock({ diagnosticName: 'Post', sourceModel: 'Post' });
    const factory = new Function(`${block}\nreturn wrapPrismaError;`) as () => (
      error: unknown,
    ) => unknown;
    const emitted = factory();

    const initError = new Error('Environment variable not found: DATABASE_URL.');
    initError.name = 'PrismaClientInitializationError';

    const cases: unknown[] = [
      Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }),
      Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' }),
      new TypeError("Cannot read properties of undefined (reading 'findMany')"),
      initError,
      new Error('Unique constraint failed on the fields: (`email`)'),
    ];

    for (const error of cases) {
      expect(readPublicDiagnostic({ error: emitted(error) })).toEqual(
        readPublicDiagnostic({
          error: wrapResolveError({ objectName: 'Post', accessor: 'post', error }),
        }),
      );
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

  it('renders declared value constraints into the input schema (ONT-037)', () => {
    const createProduct: IrAction = {
      name: 'createProduct',
      source: 'openapi',
      method: 'POST',
      path: '/products',
      write: true,
      input: [
        {
          name: 'name',
          kind: 'scalar',
          scalar: 'string',
          optional: false,
          constraints: { min: 1, regex: '^["a-z]+$' },
        },
        {
          name: 'priceCents',
          kind: 'scalar',
          scalar: 'int',
          optional: false,
          constraints: { min: 0 },
        },
        {
          name: 'discountPct',
          kind: 'scalar',
          scalar: 'float',
          optional: true,
          constraints: { min: 0, max: 100 },
        },
      ],
    };

    const { content } = emitActionFile({ action: createProduct });

    expect(content).toContain('"name": z.string().min(1).regex(new RegExp("^[\\"a-z]+$")),');
    expect(content).toContain('"priceCents": z.number().int().min(0),');
    // `.optional()` stays the outermost modifier.
    expect(content).toContain('"discountPct": z.number().min(0).max(100).optional(),');
  });

  it('emits a constraint-free action byte-identically to the pre-ONT-037 output', () => {
    const { content } = emitActionFile({ action: coupon });

    expect(content).toContain('"customerId": z.string(),');
    expect(content).not.toContain('.min(');
    expect(content).not.toContain('new RegExp(');
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

    const readAccessor = accessorName({ model: renamedObject.sourceModel ?? renamedObject.name });
    const writeAccessor = accessorName({
      model: renamedAction.prisma!.sourceModel ?? renamedAction.prisma!.model,
    });
    expect(writeAccessor).toBe(readAccessor);

    // and the emitted files agree at the byte level on the client member.
    const objectFile = emitObjectFile({ object: renamedObject });
    const actionFile = emitActionFile({ action: renamedAction });
    expect(objectFile.content).toContain(`prisma.${readAccessor}.findUnique`);
    expect(actionFile.content).toContain(`prisma.${writeAccessor}.create`);
  });
});

describe('the Prisma accessor comes from the SCHEMA, not the JS binding (ONT-041 defect D)', () => {
  const modelNamed = ({ name }: { name: string }): IrObject => ({
    name,
    sourceModel: name,
    idField: 'id',
    relations: [],
    fields: [
      { name: 'id', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: true },
    ],
  });

  it('emits prisma.registry for `model registry`, not the reserved-binding prisma.registry_', () => {
    // `registry` is a legal Prisma model whose client accessor is
    // `prisma.registry`. `sanitizeIdentifier` appends `_` for it because the
    // generated module already declares a `registry` binding — an
    // emitter-internal fix that must never reach the database. Routed through
    // it, every read and write hit `prisma.registry_`, which is `undefined`.
    const object = modelNamed({ name: 'registry' });

    const objectFile = emitObjectFile({ object });
    const actionFile = emitActionFile({
      action: {
        name: 'createregistry',
        source: 'prisma',
        prisma: { model: 'registry', sourceModel: 'registry', op: 'create' },
        write: true,
        input: [{ name: 'id', kind: 'scalar', scalar: 'string', optional: false }],
      },
    });

    expect(objectFile.content).toContain('prisma.registry.findUnique');
    expect(actionFile.content).toContain('prisma.registry.create');
    for (const content of [objectFile.content, actionFile.content]) {
      expect(content).not.toContain('prisma.registry_');
    }
    // the binding fix is still applied where it belongs — the JS export.
    expect(objectFile.content).toContain('export const registry_ =');
    expect(objectFile.filename).toBe('registry_.mjs');
  });

  it('keeps the accessor on the source model after a collision rename', () => {
    // Two `User` models across a monorepo: the second is emitted as `User_2`,
    // but both are backed by `prisma.user` — the rename is a filename fix, not
    // a schema change, so `prisma.user_2` was a guaranteed TypeError.
    const object: IrObject = { ...modelNamed({ name: 'User_2' }), sourceModel: 'User' };

    const objectFile = emitObjectFile({ object });
    const actionFile = emitActionFile({
      action: {
        name: 'createUser_2',
        source: 'prisma',
        prisma: { model: 'User_2', sourceModel: 'User', op: 'create' },
        write: true,
        input: [{ name: 'id', kind: 'scalar', scalar: 'string', optional: false }],
      },
    });

    expect(objectFile.content).toContain('prisma.user.findUnique');
    expect(actionFile.content).toContain('prisma.user.create');
    for (const content of [objectFile.content, actionFile.content]) {
      expect(content).not.toContain('prisma.user_2');
    }
    // the action still imports the object FILE that was actually written.
    expect(objectFile.filename).toBe('User_2.mjs');
  });

  it('does not tell the user to install a client that is already installed', () => {
    // A missing accessor is a schema mismatch, not a missing client — the old
    // wrapper sent every such TypeError to `npm install @prisma/client &&
    // npx prisma generate`, which cannot fix it.
    const { content } = emitObjectFile({ object: modelNamed({ name: 'Post' }) });

    expect(content).toContain('generated from a different schema');
    expect(content).toContain('no \\"post\\" model');
    // and the genuine not-installed diagnostic is still there for its own cause.
    expect(content).toContain('not generated or installed');
    expect(content).toContain("const missing = code === 'ERR_MODULE_NOT_FOUND'");
  });

  it('falls back to the object name when no source model is recorded', () => {
    const withoutSource: IrObject = { ...modelNamed({ name: 'Ticket' }) };
    delete withoutSource.sourceModel;

    expect(emitObjectFile({ object: withoutSource }).content).toContain('prisma.ticket.findUnique');
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

describe('emitted Prisma client construction (ONT-049)', () => {
  // These pin the SHAPE of the constructor call, which is the thing that broke.
  // Prisma 7 rejects `new PrismaClient()` outright, so whichever of these two
  // lines the emitter writes silently decides whether a whole generation of
  // users can run its output at all.

  const prismaAction: IrAction = {
    name: 'createProduct',
    source: 'prisma',
    prisma: { model: 'Product', sourceModel: 'Product', op: 'create' },
    write: true,
    input: [{ name: 'title', kind: 'scalar', scalar: 'string', optional: false }],
  };

  const adapterNamed = ({ module }: { module: string }): PrismaAdapter =>
    SUPPORTED_ADAPTERS.find((adapter) => adapter.module === module) as PrismaAdapter;

  const pg: PrismaConstruction = {
    kind: 'adapter',
    adapter: adapterNamed({ module: '@prisma/adapter-pg' }),
    urlEnv: 'DATABASE_URL',
  };

  it('defaults to the pre-7 bare constructor, byte for byte', () => {
    const content = emitObjectFile({ object: product }).content;

    expect(content).toContain("const { PrismaClient } = await import('@prisma/client');");
    expect(content).toContain('client = new PrismaClient();');
    expect(content).not.toContain('adapter');
  });

  it('emits the identical bare construction into a Prisma action file', () => {
    const content = emitActionFile({ action: prismaAction }).content;

    expect(content).toContain('client = new PrismaClient();');
  });

  it('passes a driver adapter when the target repo is on Prisma 7', () => {
    const content = emitObjectFile({ object: product, construction: pg }).content;

    expect(content).toContain('client = new PrismaClient({ adapter: new PrismaPg(url) });');
    expect(content).toContain('const { PrismaPg } = await import("@prisma/adapter-pg");');
    expect(content).not.toContain('new PrismaClient();');
  });

  it("reads the project's own URL variable and refuses an unset one", () => {
    const content = emitObjectFile({
      object: product,
      construction: { ...pg, urlEnv: 'PG_URL' },
    }).content;

    expect(content).toContain('const url = process.env.PG_URL;');
    // The guard fires before any driver is touched, so an unset variable reads
    // as orangerail's own sentence rather than an opaque connection failure.
    expect(content).toContain("if (url === undefined || url === '') {");
    expect(content).toContain('orangerail: PG_URL is not set.');
  });

  it('names the adapter package in the module-not-found diagnostic', () => {
    // Both imports can be the one that failed. Sending a Prisma 7 user to
    // `prisma generate` for a missing @prisma/adapter-pg is advice that cannot
    // work, so the adapter build names both packages in its fix.
    const content = emitObjectFile({ object: product, construction: pg }).content;

    expect(content).toContain('Cannot resolve @prisma/client or @prisma/adapter-pg');
    expect(content).toContain('npm install @prisma/client @prisma/adapter-pg');
  });

  it('wraps the URL for an adapter whose constructor takes an object', () => {
    const content = emitObjectFile({
      object: product,
      construction: {
        kind: 'adapter',
        adapter: adapterNamed({ module: '@prisma/adapter-better-sqlite3' }),
        urlEnv: 'DATABASE_URL',
      },
    }).content;

    expect(content).toContain(
      'client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });',
    );
  });

  it('threads the construction through the whole file set, objects and actions alike', () => {
    const source = sourceOf({ objects: [product], actions: [prismaAction] });

    const files = buildFileSet({ source, preset: 'approval-for-writes', construction: pg });
    const prismaFiles = files.filter((file) => file.content.includes('const getPrisma'));

    expect(prismaFiles.length).toBeGreaterThanOrEqual(2);
    for (const file of prismaFiles) {
      expect(file.content).toContain('adapter: new PrismaPg(url)');
    }
  });

  it('stays byte-deterministic under an adapter construction', () => {
    const source = sourceOf({ objects: [product], actions: [prismaAction] });

    expect(buildFileSet({ source, preset: 'sandbox', construction: pg })).toEqual(
      buildFileSet({ source, preset: 'sandbox', construction: pg }),
    );
  });
});
