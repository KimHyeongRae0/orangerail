import type { IrAction } from '../ir';
import { ownershipLine } from './emit-object';
import { escapeBlockComment, escapeStringLiteral } from './escape';
import { actionFieldExpr } from './zod';

/**
 * Emit one user-owned `ontology/<action>.mjs` file for a scanned write
 * operation (plan D5/D7). Non-GET operations become actions declared
 * `approval: 'required'` under the default preset (the wizard GENERATES the
 * policy so the declaration surface never lies, §5.4); `execute` is the
 * `notImplemented` stub (ONT-003 semantics: registers, exposes its schema,
 * fails staging explicitly, is audited). The registry `name:` is already the
 * sanitized, MCP-safe identifier (plan D10 amendment); the hostile original is
 * kept only as inert provenance comment data.
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

const renderHeader = ({ action }: { action: IrAction }): string => {
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

/** Render the `.mjs` file for one scanned action. */
export const emitActionFile = ({
  action,
}: {
  action: IrAction;
}): { filename: string; content: string } => {
  const body = [
    "import { z } from 'zod';",
    "import { notImplemented } from 'orangerail-core';",
    '',
    "import { registry } from './_registry.mjs';",
    '',
    `export const ${action.name} = registry.defineAction({`,
    `  name: ${escapeStringLiteral({ value: action.name })},`,
    `  input: ${renderInput({ action })},`,
    "  policy: { approval: 'required' },",
    '  execute: notImplemented,',
    '});',
    '',
  ].join('\n');

  return { filename: `${action.name}.mjs`, content: `${renderHeader({ action })}\n${body}` };
};
