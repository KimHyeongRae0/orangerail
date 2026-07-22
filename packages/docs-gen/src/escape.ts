/**
 * The single home for ALL escaping in docs-gen (plan §3.1 — the anti-ontograph
 * decision: ontograph's Mermaid path had zero label escaping and shipped a live
 * breakage bug). Every string that leaves the generator toward markdown or
 * Mermaid passes through exactly one of these functions, so hostile
 * user-supplied names can never inject structure (AC-7).
 */

/**
 * Escape a value for a markdown table cell. Pipes would start a new column and
 * newlines would break the row, so both are neutralized; a backslash is escaped
 * first so the escapes it introduces are not themselves doubled. Backticks are
 * backslash-escaped (a raw one opens a code span) and HTML angle brackets are
 * entity-escaped (AC-7 lists HTML explicitly).
 */
export const escapeTableCell = ({ value }: { value: string }): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');

/**
 * Escape a value for inline markdown body text — headings and list lines. A
 * raw newline inside a user-supplied name would terminate the current line and
 * let the remainder inject arbitrary markdown structure (headings,
 * instructions) into the agent-consumed document, and raw HTML is AC-7's
 * explicit concern. Quotes stay untouched (rendered conditions carry them
 * verbatim).
 */
export const escapeInline = ({ value }: { value: string }): string =>
  value.replace(/`/g, '\\`').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ');

/**
 * Escape a display name for a Mermaid quoted label (`id["<here>"]`). Mermaid
 * accepts `#NNN;`/`#name;` numeric-or-named entity codes inside labels; we map
 * the structurally dangerous characters to entities so the label always parses
 * and the raw hostile sequence never reaches the diagram source. Newlines
 * collapse to a space (a raw newline ends the label).
 */
export const escapeMermaidLabel = ({ value }: { value: string }): string =>
  value
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/`/g, '#96;')
    .replace(/\|/g, '#124;')
    .replace(/[[]/g, '#91;')
    .replace(/]/g, '#93;')
    .replace(/[{]/g, '#123;')
    .replace(/}/g, '#125;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/\r?\n/g, ' ');

/**
 * A stateful ID allocator: sanitize display names to the Mermaid-safe node-ID
 * charset `[A-Za-z0-9_]`, appending deterministic `_2`/`_3`… suffixes when two
 * distinct names sanitize to the same base. Because callers feed names in a
 * fixed (alphabetical) order, the assignment is byte-deterministic (AC-6). The
 * same name always maps to the same ID within one allocator instance.
 */
export const createIdAllocator = () => {
  const byName = new Map<string, string>();
  const used = new Set<string>();

  const allocate = ({ name }: { name: string }): string => {
    const existing = byName.get(name);
    if (existing !== undefined) {
      return existing;
    }

    const base = name.replace(/[^A-Za-z0-9_]/g, '_') || '_';

    let id = base;
    let n = 2;
    while (used.has(id)) {
      id = `${base}_${n}`;
      n += 1;
    }

    used.add(id);
    byName.set(name, id);

    return id;
  };

  return { allocate };
};
