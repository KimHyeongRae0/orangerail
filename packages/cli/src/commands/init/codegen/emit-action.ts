import type { IrAction, IrPrismaAction } from '../ir';
import { ownershipLine, prismaClientBlock, prismaMember } from './emit-object';
import { escapeBlockComment, escapeStringLiteral, sanitizeIdentifier } from './escape';
import { actionFieldExpr } from './zod';

/**
 * Emit one user-owned `ontology/<action>.mjs` file for a scanned write action
 * (plan D5/D7). The emitter branches on `action.source`:
 *
 * - `openapi` — the action is a non-GET operation with no execution wired yet;
 *   it is declared `approval: 'required'` and its `execute` is the
 *   `notImplemented` stub (ONT-003 semantics: registers, exposes its schema,
 *   fails staging explicitly, is audited). This branch is byte-for-byte the
 *   pre-ONT-018 output — the `source`/`prisma` IR fields are never emitted
 *   (AC-6 byte-identity).
 * - `prisma` — the action is a synthesized CRUD write; its `execute` runs the
 *   real `prisma.<accessor>.<op>(...)` through the SAME lazy client plumbing the
 *   read tools use (plan D3), degrading with the same actionable diagnostic when
 *   no client/`DATABASE_URL` is wired. It still declares `approval: 'required'`
 *   (secure by default), and a `delete` carries a DESTRUCTIVE header line (D5).
 *
 * The registry `name:` is already the sanitized, MCP-safe identifier (plan D10
 * amendment); the hostile original is kept only as inert provenance comment data.
 */

const renderInput = ({ action }: { action: IrAction }): string => {
  if (action.input.length === 0) {
    return 'z.object({})';
  }

  const lines = action.input.map(
    (field) => `    ${escapeStringLiteral({ value: field.name })}: ${actionFieldExpr({ field })},`,
  );

  return ['z.object({', ...lines, '  })'].join('\n');
};

const renderOpenApiHeader = ({ action }: { action: IrAction }): string => {
  const lines = [
    '/**',
    ` * Orangerail action \`${escapeBlockComment({ value: action.name })}\` (from OpenAPI ${escapeBlockComment({ value: `${action.method} ${action.path}` })}).`,
  ];

  if (action.rawName !== undefined) {
    lines.push(` * Original operationId: ${escapeBlockComment({ value: action.rawName })}`);
  }

  if (action.description !== undefined) {
    lines.push(` * Summary: ${escapeBlockComment({ value: action.description }).slice(0, 200)}`);
  }

  lines.push(
    ' *',
    ` * ${ownershipLine}`,
    ' * Write operation: staged for human approval; wire up `execute` to enable it.',
    ' */',
  );

  return lines.join('\n');
};

const renderPrismaHeader = ({
  action,
  prisma,
  member,
}: {
  action: IrAction;
  prisma: IrPrismaAction;
  member: string;
}): string => {
  const lines = [
    '/**',
    ` * Orangerail action \`${escapeBlockComment({ value: action.name })}\` (Prisma ${prisma.op} on model \`${escapeBlockComment({ value: prisma.model })}\`).`,
    ' *',
    ` * ${ownershipLine}`,
    ` * Write operation: staged for human approval; on approval it runs \`${escapeBlockComment({ value: member })}.${prisma.op}(...)\` against your database.`,
  ];

  if (prisma.op === 'delete') {
    lines.push(
      ` * DESTRUCTIVE: permanently deletes a \`${escapeBlockComment({ value: prisma.model })}\` row on approval — an approver should confirm the identifier before authorizing.`,
    );
  }

  lines.push(' */');

  return lines.join('\n');
};

/** `"<name>": input["<name>"],` — an escaped computed key reading the input. */
const assignLine = ({ name, indent }: { name: string; indent: string }): string => {
  const key = escapeStringLiteral({ value: name });
  return `${indent}${key}: input[${key}],`;
};

/**
 * The `execute` body lines for a Prisma action — a real `prisma.<model>.<op>`
 * guarded by the shared `getPrisma`/`wrapPrismaError` plumbing (plan D3). Field
 * keys on both the `data`/`where` object literals and the `input[...]` reads go
 * through `escapeStringLiteral` (hostile field names stay inert, D10).
 *
 * The call is `return await`, deliberately (ONT-045). A bare `return
 * prisma.x.create(...)` inside `try` settles after the try block has already
 * been left, so the `catch` never runs: every generated write degraded with the
 * RAW Prisma text instead of orangerail's actionable diagnostic, and the whole
 * wrapper was dead code on this path. It surfaced as ONT-018's phase 2 asserting
 * a diagnostic that could not exist.
 */
const renderPrismaExecute = ({
  prisma,
  member,
  action,
}: {
  prisma: IrPrismaAction;
  member: string;
  action: IrAction;
}): string[] => {
  const callLines: string[] = [];

  if (prisma.op === 'create') {
    callLines.push(
      `      return await ${member}.create({`,
      '        data: {',
      ...action.input.map((field) => assignLine({ name: field.name, indent: '          ' })),
      '        },',
      '      });',
    );
  } else if (prisma.op === 'update') {
    const idKey = escapeStringLiteral({ value: prisma.idField ?? '' });
    const dataFields = action.input.filter((field) => field.name !== prisma.idField);

    callLines.push(
      `      return await ${member}.update({`,
      `        where: { ${idKey}: input[${idKey}] },`,
      '        data: {',
      ...dataFields.map((field) => assignLine({ name: field.name, indent: '          ' })),
      '        },',
      '      });',
    );
  } else {
    const idKey = escapeStringLiteral({ value: prisma.idField ?? '' });
    callLines.push(
      `      return await ${member}.delete({ where: { ${idKey}: input[${idKey}] } });`,
    );
  }

  return [
    '  execute: async ({ input }) => {',
    '    try {',
    '      const prisma = await getPrisma();',
    ...callLines,
    '    } catch (error) {',
    '      throw wrapPrismaError(error);',
    '    }',
    '  },',
  ];
};

/** Render an OpenAPI-source action file — the pre-ONT-018 stub, byte-identical (AC-6). */
const emitOpenApiActionFile = ({
  action,
  binding,
}: {
  action: IrAction;
  binding: string;
}): { filename: string; content: string } => {
  const body = [
    "import { z } from 'zod';",
    "import { notImplemented } from 'orangerail-core';",
    '',
    "import { registry } from './_registry.mjs';",
    '',
    `export const ${binding} = registry.defineAction({`,
    `  name: ${escapeStringLiteral({ value: action.name })},`,
    `  input: ${renderInput({ action })},`,
    "  policy: { approval: 'required' },",
    '  execute: notImplemented,',
    '});',
    '',
  ].join('\n');

  return { filename: `${binding}.mjs`, content: `${renderOpenApiHeader({ action })}\n${body}` };
};

/** Render a Prisma-source action file — a real, governed `execute` (plan D3). */
const emitPrismaActionFile = ({
  action,
  binding,
}: {
  action: IrAction;
  binding: string;
}): { filename: string; content: string } => {
  // Recompute the client member at EMIT time from the SOURCE model name,
  // mirroring the read side exactly — never from the emitted JS binding — so a
  // reserved-binding or collision rename can never move the database accessor
  // off the model Prisma actually exposes (ONT-041).
  const prisma = action.prisma as IrPrismaAction;
  const sourceModel = prisma.sourceModel ?? prisma.model;
  const member = prismaMember({ model: sourceModel });

  // An `update`/`delete` acts on an EXISTING row keyed by `idField`, which is a
  // key of this action's input — so it carries a `target` (the object it
  // governs) with `targetIdFrom` pointing at that key. This connects the action
  // to its object in the studio map (a self-loop on the target) and lets a
  // future `where` policy gate on the row. A `create` has no pre-existing target
  // instance, so it stays target-less (a free-standing action) — declaring a
  // target there would demand a targetIdFrom that its input cannot supply.
  const objectBinding = sanitizeIdentifier({ value: prisma.model });
  const isTargeted =
    (prisma.op === 'update' || prisma.op === 'delete') && prisma.idField !== undefined;

  const body = [
    "import { z } from 'zod';",
    '',
    "import { registry } from './_registry.mjs';",
    ...(isTargeted ? [`import { ${objectBinding} } from './${objectBinding}.mjs';`] : []),
    '',
    prismaClientBlock({ diagnosticName: prisma.model, sourceModel }),
    '',
    `export const ${binding} = registry.defineAction({`,
    `  name: ${escapeStringLiteral({ value: action.name })},`,
    `  input: ${renderInput({ action })},`,
    "  policy: { approval: 'required' },",
    ...(isTargeted
      ? [
          `  target: ${objectBinding},`,
          `  targetIdFrom: ${escapeStringLiteral({ value: prisma.idField as string })},`,
        ]
      : []),
    ...renderPrismaExecute({ prisma, member, action }),
    '});',
    '',
  ].join('\n');

  return {
    filename: `${binding}.mjs`,
    content: `${renderPrismaHeader({ action, prisma, member })}\n${body}`,
  };
};

/** Render the `.mjs` file for one scanned action (plan D4 branch). */
export const emitActionFile = ({
  action,
}: {
  action: IrAction;
}): { filename: string; content: string } => {
  // The MCP-safe registry name may contain hyphens (e.g. GitHub-style
  // `actions/create-workflow-dispatch` operationIds), which are not legal in
  // a JS binding — the export identifier needs its own sanitization pass.
  // Belt-and-suspenders (ONT-015, L-ACTIONFILENAME): the filename stem is
  // derived from the same `sanitizeIdentifier` binding as the `export const`,
  // so the stem and the binding agree by an identical rule.
  const binding = sanitizeIdentifier({ value: action.name });

  return action.source === 'prisma'
    ? emitPrismaActionFile({ action, binding })
    : emitOpenApiActionFile({ action, binding });
};
