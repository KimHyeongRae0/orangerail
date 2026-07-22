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

/** True when an error is a module-resolution failure (ESM or CJS variant). */
const isModuleResolutionError = ({ error }: { error: unknown }): boolean => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
};

/**
 * Map a resolve-time error into what the resolve should throw: a
 * module-resolution failure becomes the actionable diagnostic (cause + fix +
 * the original message as detail); any other error is returned untouched so
 * real runtime failures are never masked. This is the exact logic mirrored
 * inline into generated object files; it is exported for direct unit testing.
 */
export const wrapResolveError = ({
  objectName,
  error,
}: {
  objectName: string;
  error: unknown;
}): unknown => {
  if (!isModuleResolutionError({ error })) {
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

  const accessor = camelCase({ name: sanitizeIdentifier({ value: object.name }) });
  const idKey = escapeStringLiteral({ value: object.idField });

  return [
    '  resolve: {',
    '    get: async ({ id }) => {',
    '      try {',
    '        const prisma = await getPrisma();',
    `        return prisma.${accessor}.findUnique({ where: { ${idKey}: id } });`,
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
 * error-wrapper shared by an object's resolve (plan D6/I4). `wrapPrismaError`
 * mirrors `wrapResolveError`: a module-resolution failure is rethrown as the
 * actionable diagnostic; any other error passes through untouched.
 */
const prismaAccessor = ({ object }: { object: IrObject }): string => {
  const diagnostic = escapeStringLiteral({
    value: buildResolveDiagnostic({ objectName: object.name }),
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
    "  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {",
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
    ...(resolve === '' ? [] : ['', prismaAccessor({ object })]),
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
