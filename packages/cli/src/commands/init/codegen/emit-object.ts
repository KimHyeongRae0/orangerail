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
 * The Prisma client accessor for a scanned name — `camelCase(sanitizeIdentifier)`
 * of the (post-allocation) model/object name. Shared by the read side
 * (`emitObjectFile` resolve) and the write side (`emitActionFile` execute) so
 * both derive the SAME `prisma.<accessor>` member from the SAME post-allocation
 * name, even when the global allocator renamed a colliding model
 * (plan-review finding 2). Recomputed at emit time — never embedded at synthesis.
 */
export const accessorName = ({ name }: { name: string }): string =>
  camelCase({ name: sanitizeIdentifier({ value: name }) });

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
 * True when an error means the Prisma client is not usable for this model:
 * either `@prisma/client` did not resolve at all (ESM/CJS module-not-found), or
 * it resolved but the model accessor is `undefined` because the client was
 * never generated (or was generated from a different schema) — that latter case
 * surfaces as a `TypeError` when the resolve reads `.findUnique`/`.create` off
 * `undefined`. Both are the same actionable situation ("not generated or
 * installed"), so both map to the diagnostic rather than a raw crash.
 */
const isClientUnavailable = ({ error }: { error: unknown }): boolean => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return (
    code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || error instanceof TypeError
  );
};

/**
 * Map a resolve-time error into what the resolve should throw: a client that is
 * unavailable for this model (not installed, or not generated) becomes the
 * actionable diagnostic (cause + fix + the original message as detail); any
 * other error is returned untouched so real runtime failures (a live query
 * error, a connection refusal) are never masked. This is the exact logic
 * mirrored inline into generated object/action files; it is exported for direct
 * unit testing.
 */
export const wrapResolveError = ({
  objectName,
  error,
}: {
  objectName: string;
  error: unknown;
}): unknown => {
  if (!isClientUnavailable({ error })) {
    return error;
  }

  const original = (error as { message?: unknown } | null | undefined)?.message;
  const detail =
    typeof original === 'string' && original !== '' ? ` Original error: ${original}` : '';

  return new Error(`${buildResolveDiagnostic({ objectName })}${detail}`);
};

const renderResolve = ({ object }: { object: IrObject }): string => {
  if (object.idField === undefined) {
    return '';
  }

  const accessor = accessorName({ name: object.name });
  const idKey = escapeStringLiteral({ value: object.idField });

  // The `resolve.get` contract hands `id` in as a string (ResolveGetArgs.id:
  // string — the resolve boundary is string-typed). Prisma, however, keys a
  // numeric `@id` column by number, so a string primary key is rejected with a
  // raw validation error. Coerce here, at the one place that knows the scanned
  // key's scalar: numeric keys (int/float) go through `Number(...)`, everything
  // else stays a string. This fixes both callers that resolve by id — the MCP
  // `<Object>_get` tool and the engine's `where`-policy target fetch.
  const idScalar = object.fields.find((field) => field.name === object.idField)?.scalar;
  const idExpr = idScalar === 'int' || idScalar === 'float' ? 'Number(id)' : 'id';

  return [
    '  resolve: {',
    '    get: async ({ id }) => {',
    '      try {',
    '        const prisma = await getPrisma();',
    `        return prisma.${accessor}.findUnique({ where: { ${idKey}: ${idExpr} } });`,
    '      } catch (error) {',
    '        throw wrapPrismaError(error);',
    '      }',
    '    },',
    '    list: async () => {',
    '      try {',
    '        const prisma = await getPrisma();',
    `        return { items: await prisma.${accessor}.findMany({ take: 50 }) };`,
    '      } catch (error) {',
    '        throw wrapPrismaError(error);',
    '      }',
    '    },',
    '  },',
  ].join('\n');
};

/**
 * The lazy, memoized `@prisma/client` accessor plus the actionable
 * error-wrapper shared by a generated file's Prisma call sites (plan D6/I4).
 * `wrapPrismaError` mirrors `wrapResolveError`: a client that is unavailable for
 * this model — not installed (module-not-found) OR resolved-but-not-generated
 * (a `TypeError` from reading an operation off the `undefined` model accessor)
 * — is rethrown as the actionable diagnostic; any other error passes through
 * untouched. Shared verbatim by object resolve files and Prisma action files so
 * both degrade identically (plan D3, exported for `emit-action.ts`).
 */
export const prismaClientBlock = ({ diagnosticName }: { diagnosticName: string }): string => {
  const diagnostic = escapeStringLiteral({
    value: buildResolveDiagnostic({ objectName: diagnosticName }),
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
    "  const unavailable = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || error instanceof TypeError;",
    '  if (!unavailable) {',
    '    return error;',
    '  }',
    '',
    "  const original = error && typeof error.message === 'string' ? error.message : '';",
    `  const detail = original === '' ? '' : ' Original error: ' + original;`,
    `  return new Error(${diagnostic} + detail);`,
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
    ...(resolve === '' ? [] : ['', prismaClientBlock({ diagnosticName: object.name })]),
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
