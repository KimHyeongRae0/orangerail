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

  if (RESERVED.has(out)) {
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
