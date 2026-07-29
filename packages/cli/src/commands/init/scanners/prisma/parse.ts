/**
 * Hand-rolled Prisma schema parser (plan D3). packages/cli stays
 * zero-external-deps, so we tokenize and parse a subset by hand rather than
 * pulling `@prisma/internals`. The subset: `model` / `enum` blocks; scalar
 * types; `?` optional and `[]` list markers; the attributes that affect naming
 * or relations. Unsupported constructs are surfaced to the caller (the mapper)
 * which turns them into skip-with-warning diagnostics — the parser never throws
 * on a supported-subset schema.
 *
 * String literals are respected everywhere (comment stripping, brace matching,
 * attribute scanning) so hostile payloads inside `@map` / `@default` string
 * arguments — quotes, backticks, comment terminators — are inert data and
 * cannot derail the parse (AC-9).
 */

/** A raw field line inside a model block, before type classification. */
export interface RawField {
  name: string;
  /** Base type identifier with `?` / `[]` / `(...)` stripped. */
  type: string;
  optional: boolean;
  list: boolean;
  /** True when the declared type was `Unsupported(...)`. */
  unsupported: boolean;
  /** The attribute remainder of the line (for `@id` / `@relation` detection). */
  attributes: string;
}

/** A raw parsed `model` block. */
export interface RawModel {
  name: string;
  fields: RawField[];
}

/** A raw parsed `enum` block. */
export interface RawEnum {
  name: string;
  values: string[];
}

/**
 * The schema's `datasource` block, reduced to the two facts codegen needs
 * (ONT-049): which database it is, and which environment variable holds the
 * connection URL.
 *
 * Both are optional because both are optional in practice. Prisma 7 removed
 * `url` from the datasource block entirely (it moved to `prisma.config.ts`), so
 * a Prisma 7 schema declares a provider and nothing else; and a schema that
 * inlines a literal URL declares no environment variable to read.
 */
export interface RawDatasource {
  provider?: string;
  /** The name inside `url = env("…")`, when the URL comes from the environment. */
  urlEnv?: string;
}

/** The full raw parse result. */
export interface ParsedSchema {
  models: RawModel[];
  enums: RawEnum[];
  /** The first `datasource` block, when the schema declares one. */
  datasource?: RawDatasource;
  /** Names of declared `view` blocks, in source order (bodies never parsed). */
  views: string[];
  /**
   * `<keyword> <name>` headers whose block name this grammar cannot accept, in
   * source order. Prisma rejects those names too, so the SKIP is correct — the
   * defect was that it happened with zero diagnostics, leaving a user staring at
   * "✓ 1 object(s)" with three models silently absent (ONT-042 F).
   */
  invalidBlocks: string[];
}

/**
 * Strip `//` line comments while respecting string literals. Prisma has no
 * block-comment syntax, so comment-terminator sequences only ever appear
 * inside string literals and are left untouched. Newlines are preserved so
 * line-based field parsing stays valid.
 */
const stripComments = ({ source }: { source: string }): string => {
  let out = '';
  let inString = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (inString) {
      out += ch;

      if (ch === '\\') {
        // Keep the escaped char verbatim (e.g. \" stays inside the string).
        if (next !== undefined) {
          out += next;
          i += 2;
          continue;
        }
      }

      if (ch === '"') {
        inString = false;
      }

      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      // Skip to end of line.
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
};

/** A top-level `keyword name { body }` block. */
interface Block {
  keyword: string;
  name: string;
  body: string;
}

/** A block name this grammar accepts (Prisma's own identifier rule). */
const VALID_BLOCK_NAME = /^[A-Za-z_]\w*$/;

/**
 * Extract top-level `keyword name { ... }` blocks, matching braces while
 * respecting string literals so a brace inside a string never miscounts.
 *
 * The header pattern is deliberately LENIENT about the name and the name is
 * validated afterwards. Matching strictly meant a header the grammar could not
 * accept (`model Über`) was not recognized as a block at all: its body was left
 * in the scan window, and it produced no diagnostic. Recognizing it, consuming
 * its body, and reporting the header keeps the skip (Prisma rejects those names
 * too) while making it visible (ONT-042 F).
 */
const extractBlocks = ({
  source,
}: {
  source: string;
}): { blocks: Block[]; invalidBlocks: string[] } => {
  const blocks: Block[] = [];
  const invalidBlocks: string[] = [];
  const headerRe = /(model|view|enum|generator|datasource|type)\s+([^\s{]+)\s*\{/g;

  let match: RegExpExecArray | null = headerRe.exec(source);

  while (match !== null) {
    const keyword = match[1] ?? '';
    const name = match[2] ?? '';
    const bodyStart = headerRe.lastIndex;

    let depth = 1;
    let inString = false;
    let i = bodyStart;

    while (i < source.length && depth > 0) {
      const ch = source[i];

      if (inString) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
      }

      i += 1;
    }

    if (VALID_BLOCK_NAME.test(name)) {
      blocks.push({ keyword, name, body: source.slice(bodyStart, i - 1) });
    } else {
      invalidBlocks.push(`${keyword} ${name}`);
    }

    headerRe.lastIndex = i;
    match = headerRe.exec(source);
  }

  return { blocks, invalidBlocks };
};

/** Split a type token into base identifier + modifiers. */
const parseTypeToken = ({
  token,
}: {
  token: string;
}): { type: string; optional: boolean; list: boolean; unsupported: boolean } => {
  const list = token.includes('[]');
  const withoutList = token.replace('[]', '');
  const optional = withoutList.endsWith('?');
  const core = optional ? withoutList.slice(0, -1) : withoutList;

  // Base identifier ends at the first `(`, `?`, or `[`.
  const base = core.split(/[([?]/)[0] ?? core;
  const unsupported = base === 'Unsupported';

  return { type: base, optional, list, unsupported };
};

/** Parse the body of a `model` block into raw fields. */
const parseModelBody = ({ body }: { body: string }): RawField[] => {
  const fields: RawField[] = [];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith('@@')) {
      // Empty line or block-level attribute (`@@map` / `@@id` / `@@unique`) —
      // block attributes do not change Prisma Client naming (D3), so ignored.
      continue;
    }

    const nameMatch = /^([A-Za-z_][\w]*)\s+(\S+)(.*)$/.exec(line);
    if (nameMatch === null) {
      continue;
    }

    const name = nameMatch[1] ?? '';
    const typeToken = nameMatch[2] ?? '';
    const attributes = (nameMatch[3] ?? '').trim();

    const parsed = parseTypeToken({ token: typeToken });

    fields.push({
      name,
      type: parsed.type,
      optional: parsed.optional,
      list: parsed.list,
      unsupported: parsed.unsupported,
      attributes,
    });
  }

  return fields;
};

/** Parse the body of an `enum` block into member names, in declared order. */
const parseEnumBody = ({ body }: { body: string }): string[] => {
  const values: string[] = [];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith('@@') || line.startsWith('@')) {
      continue;
    }

    const memberMatch = /^([A-Za-z_][\w]*)/.exec(line);
    if (memberMatch !== null) {
      values.push(memberMatch[1] ?? '');
    }
  }

  return values;
};

/**
 * Parse the body of a `datasource` block. Only `provider` and `url = env("…")`
 * are read; every other key (`directUrl`, `shadowDatabaseUrl`, `relationMode`,
 * `extensions`) is left alone, and a `url` that is a literal string rather than
 * an `env(…)` call yields no variable name — the schema is stating the URL, not
 * naming a place to read it from.
 */
const parseDatasourceBody = ({ body }: { body: string }): RawDatasource => {
  const datasource: RawDatasource = {};

  const provider = /(^|\n)\s*provider\s*=\s*"([^"]*)"/.exec(body);
  if (provider !== null && provider[2] !== undefined && provider[2] !== '') {
    datasource.provider = provider[2];
  }

  const urlEnv = /(^|\n)\s*url\s*=\s*env\(\s*"([^"]*)"\s*\)/.exec(body);
  if (urlEnv !== null && urlEnv[2] !== undefined && urlEnv[2] !== '') {
    datasource.urlEnv = urlEnv[2];
  }

  return datasource;
};

/** Parse a Prisma schema string into raw models and enums (plan D3). */
export const parsePrismaSchema = ({ source }: { source: string }): ParsedSchema => {
  const cleaned = stripComments({ source });
  const { blocks, invalidBlocks } = extractBlocks({ source: cleaned });

  const models: RawModel[] = [];
  const enums: RawEnum[] = [];
  const views: string[] = [];
  let datasource: RawDatasource | undefined;

  for (const block of blocks) {
    if (block.keyword === 'datasource') {
      // First one wins: Prisma allows exactly one datasource, so a second is a
      // schema the CLI would reject anyway — no reason to model a merge here.
      datasource ??= parseDatasourceBody({ body: block.body });
    } else if (block.keyword === 'model') {
      models.push({ name: block.name, fields: parseModelBody({ body: block.body }) });
    } else if (block.keyword === 'enum') {
      enums.push({ name: block.name, values: parseEnumBody({ body: block.body }) });
    } else if (block.keyword === 'view') {
      // View bodies are never parsed (read models are not scanned in v0); the
      // brace matcher has already consumed the body, so a hostile string inside
      // it stays inert. Only the name is recorded, to drive a skip warning.
      views.push(block.name);
    }
  }

  return {
    models,
    enums,
    views,
    invalidBlocks,
    ...(datasource === undefined ? {} : { datasource }),
  };
};
