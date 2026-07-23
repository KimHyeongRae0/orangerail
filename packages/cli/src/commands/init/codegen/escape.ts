/**
 * The single escaping / sanitization layer for init codegen (plan D10). Every
 * user-controlled string (model / field / action names, descriptions, paths)
 * passes through exactly one of these helpers before it reaches generated
 * TypeScript/ESM, so hostile fixture names — quotes, backticks, comment
 * terminators, newlines, very long identifiers — can never break out of a
 * string literal or a comment and inject code (AC-9). This module owns its own
 * adversarial unit tests.
 */

/** Reserved words that must never be used as a bare generated identifier. */
const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'await',
  'async',
]);

/**
 * Module-scope identifiers the generated `ontology/*.mjs` files import or
 * declare themselves (ONT-015, M-RESERVEDBINDING). A scanned model / operation
 * whose sanitized identifier equals one of these would emit an
 * `export const <binding>` that re-declares an already-imported/declared name,
 * so the file throws `SyntaxError` at parse and `orangerail.config.mjs` fails to
 * load. Object files declare `z` (`import { z } from 'zod'`), `registry`,
 * `getPrisma`, and `wrapPrismaError`; action files declare `z`,
 * `notImplemented`, and `registry` — the closed union is these five. Kept
 * SEPARATE from `RESERVED` (which is JS grammar): this set is emitter-internal.
 * Both take the identical `_` suffix, and it is applied in `sanitizeIdentifier`
 * ONLY (the JS binding / filename), NOT in `sanitizeMcpName` — the MCP tool
 * `name:` may legally remain the literal string `registry`.
 */
const RESERVED_BINDINGS = new Set([
  'registry',
  'z',
  'notImplemented',
  'getPrisma',
  'wrapPrismaError',
]);

/** Control characters (C0 + DEL + C1) that must never survive into output. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Escape an arbitrary string for embedding as a JS string literal.
 * `JSON.stringify` neutralizes every control character, quote, and backslash
 * into a valid double-quoted literal, which is itself valid JS, so we return it
 * verbatim. The result can never terminate the surrounding literal or inject a
 * statement.
 */
export const escapeStringLiteral = ({ value }: { value: string }): string => JSON.stringify(value);

/**
 * Neutralize a string for embedding inside a block comment. The only sequence
 * that can close a block comment is a literal `*` followed by `/`; we break it
 * with a backslash (inert in a comment) and collapse control characters and
 * newlines to spaces so the comment stays one line. Backticks and quotes are
 * harmless inside a comment and pass through as inert text.
 */
export const escapeBlockComment = ({ value }: { value: string }): string =>
  value.replace(CONTROL, ' ').replace(/\*\//g, '*\\/');

/**
 * Sanitize an arbitrary string into a valid JS identifier matching
 * `/^[A-Za-z_$][\w$]*$/`. Invalid characters collapse to `_`; a leading digit
 * or empty result is prefixed; reserved words are suffixed. Deterministic (same
 * input -> same output), so generated code is byte-stable (AC-9).
 */
export const sanitizeIdentifier = ({ value }: { value: string }): string => {
  let out = value
    .replace(/[^A-Za-z0-9_$]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (out === '') {
    out = 'field';
  }

  if (/^[0-9]/.test(out)) {
    out = `_${out}`;
  }

  if (RESERVED.has(out) || RESERVED_BINDINGS.has(out)) {
    out = `${out}_`;
  }

  return out.slice(0, 64);
};

/**
 * Sanitize a string into the MCP tool-name charset `[a-zA-Z0-9_-]{1,64}`
 * (plan D10 amendment). The generated registry `name:` becomes an MCP tool name
 * verbatim (`packages/mcp/src/names.ts` validates it at server BUILD time), so a
 * hostile registry name would prevent `orangerail mcp` from booting on generated
 * output. The result is always a legal MCP tool name AND a legal JS identifier
 * (used both as `name:` and as the `export const` binding).
 */
export const sanitizeMcpName = ({ value }: { value: string }): string => {
  let out = value
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  if (out === '') {
    out = 'action';
  }

  if (/^[0-9]/.test(out)) {
    out = `a_${out}`;
  }

  if (RESERVED.has(out)) {
    out = `${out}_`;
  }

  return out.slice(0, 64);
};
