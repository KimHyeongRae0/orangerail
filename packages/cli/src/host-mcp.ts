import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What else the agent has mounted next to this project (ONT-060).
 *
 * Every other readout in this CLI describes the surface orangerail declares, and
 * the product's central claim is that the agent's surface IS that declaration.
 * The claim holds only when nothing else is mounted, and until this module
 * existed nothing here ever looked. Measured on 2026-07-31 with a real agent: a
 * project narrowed to four models, with a wide SQL server still registered in
 * the same `.mcp.json`, answered an ordinary support question by falling back to
 * that server's raw-query tool — seven queries, one of them over the payment
 * table the narrowing existed to exclude. No error, no warning, and nothing on
 * the audit chain, because from orangerail's point of view nothing happened.
 *
 * So this module makes the fact visible. It does not govern, proxy or block the
 * other server — that is a different product — and it never says "unsafe". The
 * only claim it makes is the narrow true one: those tools are outside this
 * project's governance.
 *
 * No vendor is named anywhere in this file and a test enforces it. The signal
 * has to be structural, because a name list is a claim about which servers are
 * dangerous — neither ours to make nor stable — while "this project does not
 * govern that one" is true of a raw SQL server and a Slack server alike.
 */

/**
 * The host config files this survey reads: PROJECT scope only, resolved against
 * the directory holding `orangerail.config.mjs`.
 *
 * User- and machine-scope configs (`~/.claude.json`, Claude Desktop's
 * `claude_desktop_config.json`, `~/.cursor/mcp.json`) are deliberately absent,
 * for three reasons that all point the same way:
 *
 * 1. Reading a home directory out of a health check is a privacy-relevant side
 *    effect that has to earn its keep. `~/.claude.json` is not an MCP config at
 *    all — it is the host's entire local state, project history included — and
 *    parsing it to answer a question about THIS project is disproportionate.
 * 2. A project-scope file is part of the project: committed, reviewable, and
 *    unambiguously scoped to the thing `status` describes.
 * 3. A machine-wide survey would have to guess which host is even in use, and
 *    guessing wrong is the false accusation this whole module must avoid.
 *
 * The cost is that this survey has a floor and no ceiling, which is why every
 * rendered variant states its own bound rather than letting a quiet readout be
 * read as an all-clear.
 */
export const HOST_CONFIG_PATHS = [
  '.mcp.json',
  join('.cursor', 'mcp.json'),
  join('.vscode', 'mcp.json'),
] as const;

/**
 * The root keys that hold server declarations. Claude Code and Cursor use
 * `mcpServers`; VS Code uses `servers`. Both are read from every file rather
 * than keyed by filename, because which host writes which shape is a moving
 * target and a union costs nothing.
 */
const SERVER_KEYS = ['mcpServers', 'servers'] as const;

/** One MCP server declaration, and the file a human has to go edit. */
export interface DeclaredServer {
  /** The name the host registers it under. */
  name: string;
  /** Project-relative path of the config that declared it. */
  source: string;
}

/** A config file that exists and could not be understood. */
export interface UnreadableHostConfig {
  /** Project-relative path of the file. */
  source: string;
  /** Why it could not be read — a parse message, quoted rather than paraphrased. */
  detail: string;
}

export type HostSurveyState =
  /** No project-scope host config exists, so this survey can see nothing. */
  | 'unmounted'
  /** At least one config was read and every server in it is ours. */
  | 'exclusive'
  /** At least one declared server is not governed by this project. */
  | 'shared';

export interface HostSurveyReview {
  state: HostSurveyState;
  /** Project-relative paths actually read (parsed or not). */
  sources: string[];
  /** Declared servers this project does govern — its own `orangerail mcp` entries. */
  governed: DeclaredServer[];
  /** Declared servers this project does not govern. */
  foreign: DeclaredServer[];
  /** Files that exist but could not be parsed; carried on every state. */
  unreadable: UnreadableHostConfig[];
}

/**
 * Whether a declaration launches THIS product.
 *
 * Positive identification of our own server, and no opinion whatsoever about
 * anything else — that is what keeps this honest without a vendor list. A
 * blocklist would be a claim about which servers are dangerous, which is neither
 * ours to make nor stable; the true statement is "we govern this one and not
 * that one", and only one side of it is knowable from here.
 *
 * Keyed on `command` and `args` — what actually executes — and NOT on the entry
 * name, which is a label the user chose and decides nothing. It matches
 * `npx orangerail mcp`, a resolved `node …/orangerail/…/main.js mcp` path, and a
 * `--config …/orangerail.config.mjs`. The residual false positive is an
 * orangerail launched through a wrapper script that names us nowhere, and it
 * costs one noisy line about our own server; the false negative it replaces is
 * the entire hole this module exists to close.
 */
const isGoverned = ({ entry }: { entry: unknown }): boolean => {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }

  const { command, args } = entry as { command?: unknown; args?: unknown };
  const words = [
    typeof command === 'string' ? command : '',
    ...(Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : []),
  ];

  return words.some((word) => word.toLowerCase().includes('orangerail'));
};

/** The server declarations in one parsed config, deduped across both root keys. */
const declarationsIn = ({ parsed }: { parsed: object }): Map<string, unknown> => {
  const found = new Map<string, unknown>();

  for (const key of SERVER_KEYS) {
    const block = (parsed as Record<string, unknown>)[key];

    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      continue;
    }

    for (const [name, entry] of Object.entries(block)) {
      if (!found.has(name)) {
        found.set(name, entry);
      }
    }
  }

  return found;
};

/**
 * Read one config, or report why not.
 *
 * An absent file is `null` and never an error: not having a `.mcp.json` is the
 * ordinary state, and the survey's own emptiness is reported by
 * {@link surveyHostConfigs} rather than by three complaints. A file that exists
 * and does not parse is `unreadable`, which is the honest verdict and pointedly
 * not a clean one — VS Code permits comments in `.vscode/mcp.json`, so JSONC
 * lands here. That is accepted: naming the file and quoting the parse error
 * beats both a hand-rolled comment stripper and pretending the file said
 * nothing.
 */
const readHostConfig = ({
  projectRoot,
  path,
}: {
  projectRoot: string;
  path: string;
}): { parsed: object } | { detail: string } | null => {
  let text: string;

  try {
    text = readFileSync(join(projectRoot, path), 'utf8');
  } catch {
    // Absent, or a directory this process may not traverse. Either way there is
    // nothing to report about a file we were never shown, and a permission error
    // must not take `status` down over a diagnostic.
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { detail: 'root is not a JSON object' };
    }

    return { parsed };
  } catch (err) {
    return { detail: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Survey the project-scope host configs and split what they declare into what
 * this project governs and what it does not.
 *
 * `projectRoot` is the directory holding `orangerail.config.mjs`, the same
 * anchor the governance baseline uses, so
 * `orangerail status --config /elsewhere/…` surveys the project it is describing
 * rather than the directory it was launched from.
 */
export const surveyHostConfigs = ({ projectRoot }: { projectRoot: string }): HostSurveyReview => {
  const sources: string[] = [];
  const governed: DeclaredServer[] = [];
  const foreign: DeclaredServer[] = [];
  const unreadable: UnreadableHostConfig[] = [];

  for (const path of HOST_CONFIG_PATHS) {
    const result = readHostConfig({ projectRoot, path });

    if (result === null) {
      continue;
    }

    sources.push(path);

    if ('detail' in result) {
      unreadable.push({ source: path, detail: result.detail });
      continue;
    }

    for (const [name, entry] of declarationsIn({ parsed: result.parsed })) {
      (isGoverned({ entry }) ? governed : foreign).push({ name, source: path });
    }
  }

  // A file that exists but did not parse still counts as "we looked and found a
  // host config here": reporting `unmounted` alongside a named unreadable file
  // would be two contradictory sentences in one block.
  const state: HostSurveyState =
    foreign.length > 0 ? 'shared' : sources.length === 0 ? 'unmounted' : 'exclusive';

  return { state, sources, governed, foreign, unreadable };
};

/** `name (path)`, and never the entry's command, args or env — see {@link hostSurveyBlock}. */
const describe = ({ server }: { server: DeclaredServer }): string =>
  `${server.name} (${server.source})`;

/** The paths this survey looked at, for a readout that has to state its own bound. */
const searchedPaths = HOST_CONFIG_PATHS.join(', ');

/**
 * The sentence that keeps this readout from being read as an inventory. It is on
 * every variant of the block, including the reassuring ones, because a floor
 * presented without its ceiling is how a partial check gets quoted as a full
 * one.
 */
const BOUND =
  `            Project scope only (${searchedPaths}); user- and\n` +
  '            machine-scope MCP config is not read.\n';

/** Sub-lines for files that exist and did not parse, appended to whichever block is printed. */
const unreadableLines = ({ review }: { review: HostSurveyReview }): string =>
  review.unreadable
    .map(
      (file) =>
        `            - ${file.source} could not be parsed (${file.detail}) — anything it\n` +
        '              declares is unaccounted for\n',
    )
    .join('');

/**
 * The `hosts:` block of the `orangerail status` readout.
 *
 * Never silent, unlike the runtime block. Core skew says nothing when it cannot
 * tell, and that is right there because a core too old to carry the marker is
 * also too old to carry the hazard — "cannot tell" and "no hazard" coincide.
 * Here they are opposites: an unread user-scope config is exactly where an
 * ungoverned server would be invisible, so a quiet block would be the one
 * reading that operators are entitled to take as an all-clear. Every variant
 * therefore names what was searched and says that project scope is all of it.
 *
 * Server NAMES only. An entry's `args` routinely carry a connection string —
 * `postgresql://user:password@host/db` is the ordinary shape — and a diagnostic
 * that copies a credential onto a terminal and into a CI log would be a new leak
 * introduced by a leak warning. Naming the file is enough for a human to look.
 */
export const hostSurveyBlock = ({ review }: { review: HostSurveyReview }): string => {
  if (review.state === 'shared') {
    const listed = review.foreign
      .map((server) => `              - ${describe({ server })}\n`)
      .join('');

    return (
      `  hosts:    UNGOVERNED TOOLS ALONGSIDE — ${review.foreign.length} other MCP server(s) declared here:\n` +
      listed +
      unreadableLines({ review }) +
      '            orangerail does not gate those tools, they leave no record on the chain\n' +
      '            above, and an agent that cannot answer a question with the verbs above can\n' +
      '            reach for them instead. Remove them, or read this readout as one surface\n' +
      '            among several.\n' +
      BOUND
    );
  }

  if (review.state === 'exclusive') {
    const held =
      review.governed.length === 0
        ? `${review.sources.join(', ')} declares no MCP servers`
        : `${review.sources.join(', ')} declares orangerail and nothing else`;

    return `  hosts:    ${held}.\n` + unreadableLines({ review }) + BOUND;
  }

  return (
    '  hosts:    no MCP client config next to this project, so orangerail cannot tell what\n' +
    '            else your agent has mounted.\n' +
    BOUND
  );
};

/**
 * The `orangerail mcp` startup-line clause.
 *
 * Present only for `shared`, and short. The line it joins begins
 * `serving · governance active`, and that sentence is a half-truth while a
 * server this project does not govern is mounted beside it — the same reason
 * the governance and skew clauses ride on every variant of the line. The
 * detail lives in `orangerail status`, which is where a block fits.
 */
export const hostSurveyClause = ({ review }: { review: HostSurveyReview }): string =>
  review.state === 'shared'
    ? ` · ${review.foreign.length} ungoverned MCP server(s) alongside — run 'orangerail status'`
    : '';

/**
 * The `orangerail init` closing beat, as a `{ tick, body }` pair matching the
 * governance beat's shape.
 *
 * Empty unless something foreign is declared, which is the one place this
 * module is allowed to be quiet: `init` is a moment of creation, a project that
 * has not been wired into a host yet has no `.mcp.json`, and "cannot tell what
 * else is mounted" seconds after generating an ontology is noise about a
 * question nobody has asked yet. `status` is the moment of audit, and there the
 * same absence is a limit on the audit and gets said out loud.
 *
 * When it does fire it fires here, in the closing summary, because this is the
 * exact moment the operator believes they just narrowed their agent's surface.
 */
export const hostSurveyInitBeat = ({
  review,
}: {
  review: HostSurveyReview;
}): { tick: string; body: string } => {
  if (review.state !== 'shared') {
    return { tick: '', body: '' };
  }

  const names = review.foreign.map((server) => describe({ server })).join(', ');

  return {
    tick: `  ⚠  ${review.foreign.length} other MCP server(s) declared next to this project: ${names}\n`,
    body:
      '\n  You just declared a narrow surface and it is not the only one your agent can reach.\n' +
      '  orangerail does not govern those servers: their tools are not gated, they leave no\n' +
      "  record on this project's audit chain, and an agent that cannot answer a question with\n" +
      '  the verbs above can use them instead. Remove them from the config above, or treat the\n' +
      '  narrowing above as partial. Only project-scope config was read\n' +
      `  (${searchedPaths}).\n`,
  };
};
