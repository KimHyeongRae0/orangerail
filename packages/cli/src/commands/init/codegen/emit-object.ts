import type { IrObject } from '../ir';
import { escapeBlockComment, escapeStringLiteral, sanitizeIdentifier } from './escape';
import { fieldExpr } from './zod';

/**
 * Emit one user-owned `ontology/<Object>.mjs` file for a scanned object (plan
 * D5/D6). The object registers into the shared registry and exposes a working
 * `resolve` (`get`/`list`) backed by a LAZILY imported `@prisma/client` (D6):
 * init/docs/studio all work without the client installed, and a missing client
 * surfaces only at tool-call time. When the client is not generated/installed
 * the resolve rethrows an ACTIONABLE diagnostic (names the object + the exact
 * fix) instead of leaking a raw module-resolution error (plan I4). Every
 * user-controlled string passes through the escape layer (D10). Output is
 * deterministic (source field order, no timestamps).
 */

/** The plain provenance / ownership comment carried by every user-owned file. */
export const ownershipLine =
  'This file is yours — re-scans never modify it; `orangerail sync` reports drift.';

const camelCase = ({ name }: { name: string }): string =>
  `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/**
 * The Prisma client accessor for a SOURCE model name — Prisma Client exposes
 * `model Foo` as `prisma.foo`, i.e. the schema's own name with its first
 * character lowercased and nothing else changed.
 *
 * It is derived from `sourceModel` (the schema name), NOT from the emitted JS
 * binding (ONT-041). `sanitizeIdentifier` exists to make a name safe as an
 * `export const` / filename stem, and it appends `_` for the emitter's own
 * `RESERVED_BINDINGS` — an emitter-internal fix that has no business reaching
 * the database: `model registry` is a legal Prisma model whose accessor is
 * `prisma.registry`, but routing it through the binding sink emitted
 * `prisma.registry_`, which is `undefined`, so every read and write threw. The
 * same held for a collision-renamed `User_2` emitting `prisma.user_2`.
 *
 * Shared by the read side (`emitObjectFile` resolve) and the write side
 * (`emitActionFile` execute) so both land on the SAME member, recomputed at
 * emit time — never embedded at synthesis.
 */
export const accessorName = ({ model }: { model: string }): string => camelCase({ name: model });

/**
 * The `prisma.<accessor>` member expression for a source model. Prisma's own
 * grammar restricts model names to `[A-Za-z_][A-Za-z0-9_]*`, so the dot form is
 * the normal output; a name that is somehow not a plain identifier falls back to
 * an escaped bracket index rather than emitting a syntax error (D10 discipline).
 */
export const prismaMember = ({ model }: { model: string }): string => {
  const accessor = accessorName({ model });

  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(accessor)
    ? `prisma.${accessor}`
    : `prisma[${escapeStringLiteral({ value: accessor })}]`;
};

/** The source model name behind a scanned object (its own name when unknown). */
export const objectSourceModel = ({ object }: { object: IrObject }): string =>
  object.sourceModel ?? object.name;

const renderSchema = ({ object }: { object: IrObject }): string => {
  const lines = object.fields.map(
    (field) => `    ${escapeStringLiteral({ value: field.name })}: ${fieldExpr({ field })},`,
  );

  return ['z.object({', ...lines, '  })'].join('\n');
};

/**
 * The static (runtime-detail-free) diagnostic text shown when an object's
 * resolve cannot load `@prisma/client`. It names the object, states the cause,
 * and gives the exact remediation commands plus the DATABASE_URL note. The
 * runtime module-resolution error message is appended as detail at throw time.
 */
export const buildResolveDiagnostic = ({ objectName }: { objectName: string }): string =>
  `Cannot resolve @prisma/client for object "${objectName}": the Prisma client is not generated or installed. ` +
  'Fix: run `npm install @prisma/client && npx prisma generate`, and make sure DATABASE_URL is set.';

/**
 * The diagnostic for a client that resolved but exposes no such model — the
 * `prisma.<accessor>` member is `undefined`, so reading an operation off it
 * throws a `TypeError` (ONT-041). This is NOT "the client is not generated or
 * installed": a client IS loaded, it simply does not carry this model, which
 * means it was generated from a different schema than the one init scanned.
 * Claiming "not generated or installed" here sent users to
 * `npm install @prisma/client && npx prisma generate` for a problem that
 * command cannot fix, so the two causes now get two messages.
 */
export const buildAccessorDiagnostic = ({
  objectName,
  accessor,
}: {
  objectName: string;
  accessor: string;
}): string =>
  `The Prisma client exposes no "${accessor}" model for object "${objectName}": the installed client was generated from a different schema. ` +
  `Fix: confirm the model still exists in your Prisma schema, then re-run \`npx prisma generate\`.`;

/**
 * True when `@prisma/client` did not resolve at all (ESM or CJS
 * module-not-found) — the one situation the "not generated or installed"
 * diagnostic actually describes.
 */
const isClientMissing = ({ error }: { error: unknown }): boolean => {
  const code = (error as { code?: unknown } | null | undefined)?.code;

  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
};

/**
 * Map a resolve-time error into what the resolve should throw. A missing client
 * (module-not-found) becomes the install/generate diagnostic; a `TypeError` —
 * the shape of reading an operation off an `undefined` model accessor — becomes
 * the SCHEMA-MISMATCH diagnostic instead, because the client did load. Any other
 * error is returned untouched so real runtime failures (a live query error, a
 * connection refusal) are never masked. This is the exact logic mirrored inline
 * into generated object/action files; it is exported for direct unit testing.
 */
export const wrapResolveError = ({
  objectName,
  accessor,
  error,
}: {
  objectName: string;
  accessor: string;
  error: unknown;
}): unknown => {
  const missing = isClientMissing({ error });

  if (!missing && !(error instanceof TypeError)) {
    return error;
  }

  const original = (error as { message?: unknown } | null | undefined)?.message;
  const detail =
    typeof original === 'string' && original !== '' ? ` Original error: ${original}` : '';

  const diagnostic = missing
    ? buildResolveDiagnostic({ objectName })
    : buildAccessorDiagnostic({ objectName, accessor });

  return new Error(`${diagnostic}${detail}`);
};

const renderResolve = ({ object }: { object: IrObject }): string => {
  if (object.idField === undefined) {
    return '';
  }

  const member = prismaMember({ model: objectSourceModel({ object }) });
  const idKey = escapeStringLiteral({ value: object.idField });

  // Ids arrive at the resolve boundary as strings (ResolveGetArgs.id), but Prisma
  // keys a numeric `@id` by number and a string key otherwise. Coerce at the one
  // place that knows the scanned key's scalar — this fixes both id-resolution
  // callers (the MCP `<Object>_get` tool and the engine's `where` target fetch).
  const idScalar = object.fields.find((field) => field.name === object.idField)?.scalar;
  const numericKey = idScalar === 'int' || idScalar === 'float';

  // `get`: coerce a numeric key with `Number(id)` and fail a non-numeric id to a
  // clean not-found (`null`) rather than handing Prisma a `NaN` and leaking a raw
  // validation error; a string key passes through untouched.
  const getLines = numericKey
    ? [
        '    get: async ({ id }) => {',
        '      try {',
        '        const prisma = await getPrisma();',
        '        const key = Number(id);',
        '        if (Number.isNaN(key)) {',
        '          return null;',
        '        }',
        `        return ${member}.findUnique({ where: { ${idKey}: key } });`,
        '      } catch (error) {',
        '        throw wrapPrismaError(error);',
        '      }',
        '    },',
      ]
    : [
        '    get: async ({ id }) => {',
        '      try {',
        '        const prisma = await getPrisma();',
        `        return ${member}.findUnique({ where: { ${idKey}: id } });`,
        '      } catch (error) {',
        '        throw wrapPrismaError(error);',
        '      }',
        '    },',
      ];

  // `list`: honor the advertised `filter`/`limit`/`cursor` and return a
  // `nextCursor` so a table larger than one page stays reachable — the bare
  // `take: 50` silently dropped every row past the first 50 with no way to page.
  // Cursor pagination keys on the id (ordered ascending); the opaque cursor is a
  // string, coerced to the key's scalar just like `get`.
  const cursorExpr = numericKey ? 'Number(cursor)' : 'cursor';
  const listLines = [
    '    list: async ({ filter, cursor, limit } = {}) => {',
    '      try {',
    '        const prisma = await getPrisma();',
    "        const take = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50;",
    `        const rows = await ${member}.findMany({`,
    '          ...(filter ? { where: filter } : {}),',
    `          orderBy: { ${idKey}: 'asc' },`,
    '          take: take + 1,',
    `          ...(cursor === undefined ? {} : { cursor: { ${idKey}: ${cursorExpr} }, skip: 1 }),`,
    '        });',
    '        const hasMore = rows.length > take;',
    '        const items = hasMore ? rows.slice(0, take) : rows;',
    `        return hasMore ? { items, nextCursor: String(items[items.length - 1][${idKey}]) } : { items };`,
    '      } catch (error) {',
    '        throw wrapPrismaError(error);',
    '      }',
    '    },',
  ];

  return ['  resolve: {', ...getLines, ...listLines, '  },'].join('\n');
};

/**
 * The lazy, memoized `@prisma/client` accessor plus the actionable
 * error-wrapper shared by a generated file's Prisma call sites (plan D6/I4).
 * `wrapPrismaError` mirrors `wrapResolveError`: a client that never resolved
 * (module-not-found) is rethrown as the install/generate diagnostic, while a
 * `TypeError` — the shape of reading an operation off an `undefined` model
 * accessor — is rethrown as the SCHEMA-MISMATCH diagnostic, because a client
 * that loaded but carries no such model is not fixed by installing or
 * generating one (ONT-041). Any other error passes through untouched. Shared
 * verbatim by object resolve files and Prisma action files so both degrade
 * identically (plan D3, exported for `emit-action.ts`).
 */
export const prismaClientBlock = ({
  diagnosticName,
  sourceModel,
}: {
  diagnosticName: string;
  sourceModel: string;
}): string => {
  const missingClient = escapeStringLiteral({
    value: buildResolveDiagnostic({ objectName: diagnosticName }),
  });
  const missingAccessor = escapeStringLiteral({
    value: buildAccessorDiagnostic({
      objectName: diagnosticName,
      accessor: accessorName({ model: sourceModel }),
    }),
  });

  return [
    'const getPrisma = (() => {',
    '  let client;',
    '  return async () => {',
    '    if (client === undefined) {',
    "      const { PrismaClient } = await import('@prisma/client');",
    '      client = new PrismaClient();',
    '    }',
    '    return client;',
    '  };',
    '})();',
    '',
    'const wrapPrismaError = (error) => {',
    '  const code = error === null || error === undefined ? undefined : error.code;',
    "  const missing = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';",
    '  if (!missing && !(error instanceof TypeError)) {',
    '    return error;',
    '  }',
    '',
    "  const original = error && typeof error.message === 'string' ? error.message : '';",
    `  const detail = original === '' ? '' : ' Original error: ' + original;`,
    `  return new Error((missing ? ${missingClient} : ${missingAccessor}) + detail);`,
    '};',
  ].join('\n');
};

/** Render the `.mjs` file for one scanned object. */
export const emitObjectFile = ({
  object,
}: {
  object: IrObject;
}): { filename: string; content: string } => {
  const binding = sanitizeIdentifier({ value: object.name });
  const provenance = object.provenance ?? `object ${object.name}`;
  const resolve = renderResolve({ object });

  const header = [
    '/**',
    ` * Orangerail object \`${escapeBlockComment({ value: object.name })}\` (${escapeBlockComment({ value: provenance })}).`,
    ' *',
    ` * ${ownershipLine}`,
    ' */',
  ].join('\n');

  const body = [
    "import { z } from 'zod';",
    '',
    "import { registry } from './_registry.mjs';",
    ...(resolve === ''
      ? []
      : [
          '',
          prismaClientBlock({
            diagnosticName: object.name,
            sourceModel: objectSourceModel({ object }),
          }),
        ]),
    '',
    `export const ${binding} = registry.defineObject({`,
    `  name: ${escapeStringLiteral({ value: object.name })},`,
    `  schema: ${renderSchema({ object })},`,
    ...(resolve === '' ? [] : [resolve]),
    '});',
    '',
  ].join('\n');

  return { filename: `${binding}.mjs`, content: `${header}\n${body}` };
};
