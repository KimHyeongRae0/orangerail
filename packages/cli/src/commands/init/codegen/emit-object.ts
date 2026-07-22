import type { IrObject } from '../ir';
import { escapeBlockComment, escapeStringLiteral, sanitizeIdentifier } from './escape';
import { fieldExpr } from './zod';

/**
 * Emit one user-owned `ontology/<Object>.mjs` file for a scanned object (plan
 * D5/D6). The object registers into the shared registry and exposes a working
 * `resolve` (`get`/`list`) backed by a LAZILY imported `@prisma/client` (D6):
 * init/docs/studio all work without the client installed, and a missing client
 * surfaces only at tool-call time. Every user-controlled string passes through
 * the escape layer (D10). Output is deterministic (source field order, no
 * timestamps).
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

const renderResolve = ({ object }: { object: IrObject }): string => {
  if (object.idField === undefined) {
    return '';
  }

  const accessor = camelCase({ name: sanitizeIdentifier({ value: object.name }) });
  const idKey = escapeStringLiteral({ value: object.idField });

  return [
    '  resolve: {',
    '    get: async ({ id }) => {',
    '      const prisma = await getPrisma();',
    `      return prisma.${accessor}.findUnique({ where: { ${idKey}: id } });`,
    '    },',
    '    list: async () => {',
    '      const prisma = await getPrisma();',
    `      return { items: await prisma.${accessor}.findMany({ take: 50 }) };`,
    '    },',
    '  },',
  ].join('\n');
};

/** The lazy, memoized `@prisma/client` accessor shared by an object's resolve. */
const PRISMA_ACCESSOR = [
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
].join('\n');

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
    ...(resolve === '' ? [] : ['', PRISMA_ACCESSOR]),
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
