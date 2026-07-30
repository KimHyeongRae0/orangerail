/**
 * Hand-rolled CLI argument parsing (§3.4 — no commander, zero runtime deps).
 *
 * Split out of `main.ts` so the argv layer is a pure function the test suite can
 * drive directly: importing `main.ts` would run the CLI.
 */

/** Parsed CLI arguments (§3.4 — hand-rolled, zero runtime deps). */
export interface ParsedArgs {
  positional: string[];
  configPath?: string;
  outPath?: string;
  port?: number;
  open: boolean;
  yes: boolean;
  preset?: string;
  /** `--gate` — which generated actions carry an approval gate (`init`, ONT-056). */
  gate?: string;
  sources?: string[];
  models?: string[];
  docs?: boolean;
  studio?: boolean;
  acceptNew: boolean;
  acceptGovernance: boolean;
  fromJira?: string;
  fromSlack?: string;
  /** `--full` — print `approvals show` input uncapped. */
  full: boolean;
  /** `--help` / `-h` seen anywhere in argv, including after a subcommand. */
  help: boolean;
  /** `--version` / `-v` seen anywhere in argv. */
  showVersion: boolean;
}

const splitCsv = ({ value }: { value: string | undefined }): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/**
 * Flags that consume a value, either as the next token or after an `=`. Declared
 * once so the missing-value guard, the `--flag=value` form, and the unknown-flag
 * message all agree on the same set.
 */
const VALUE_FLAGS = new Set([
  '--config',
  '--out',
  '--port',
  '--preset',
  '--gate',
  '--sources',
  '--models',
  '--from-jira',
  '--from-slack',
]);

/** Flags that stand alone; passing `--flag=value` to one of these is an error. */
const BOOLEAN_FLAGS = new Set([
  '--help',
  '-h',
  '--version',
  '-v',
  '--yes',
  '-y',
  '--no-open',
  '--docs',
  '--no-docs',
  '--studio',
  '--no-studio',
  '--accept-new',
  '--accept-governance',
  '--full',
]);

const KNOWN_FLAGS = [...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort();

/**
 * Read a value flag's value. A flag whose value the shell ate used to fall back
 * silently — `--config` with nothing after it became `undefined`, which
 * `resolveConfigPath` reads as "no --config given", so the operator audited the
 * local project believing they had audited another one. A value is therefore
 * required to exist and to not itself look like a flag.
 */
const takeValue = ({
  flag,
  inline,
  argv,
  index,
}: {
  flag: string;
  inline: string | undefined;
  argv: string[];
  index: number;
}): { value: string; consumed: number } => {
  if (inline !== undefined) {
    if (inline === '') {
      throw new Error(`${flag} requires a value — got an empty "${flag}="`);
    }

    return { value: inline, consumed: 0 };
  }

  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    const got = next === undefined ? 'nothing followed it' : `the next token was "${next}"`;

    throw new Error(`${flag} requires a value — ${got}`);
  }

  return { value: next, consumed: 1 };
};

/** Validate `--port` here rather than letting `server.listen` throw about `options.port`. */
const parsePort = ({ value }: { value: string }): number => {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535 — got "${value}"`);
  }

  return port;
};

/** Hand-rolled arg parsing (§3.4 — no commander, zero runtime deps). */
export const parseArgs = ({ argv }: { argv: string[] }): ParsedArgs => {
  const positional: string[] = [];
  let configPath: string | undefined;
  let outPath: string | undefined;
  let port: number | undefined;
  let open = true;
  let yes = false;
  let preset: string | undefined;
  let gate: string | undefined;
  let sources: string[] | undefined;
  let models: string[] | undefined;
  let docs: boolean | undefined;
  let studio: boolean | undefined;
  let acceptNew = false;
  let acceptGovernance = false;
  let fromJira: string | undefined;
  let fromSlack: string | undefined;
  let full = false;
  let help = false;
  let showVersion = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === undefined) {
      continue;
    }

    // Bare `help` (no dashes) is the one word treated as a flag.
    if (token === 'help') {
      help = true;
      continue;
    }

    // Anything that does not start with `-` is a subcommand or a subcommand
    // argument; everything else must be a flag we recognize.
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);

    if (VALUE_FLAGS.has(flag)) {
      const { value, consumed } = takeValue({ flag, inline, argv, index: i });
      i += consumed;

      if (flag === '--config') {
        configPath = value;
      } else if (flag === '--out') {
        outPath = value;
      } else if (flag === '--port') {
        port = parsePort({ value });
      } else if (flag === '--preset') {
        preset = value;
      } else if (flag === '--gate') {
        gate = value;
      } else if (flag === '--sources') {
        sources = splitCsv({ value });
      } else if (flag === '--models') {
        models = splitCsv({ value });
      } else if (flag === '--from-jira') {
        fromJira = value;
      } else {
        fromSlack = value;
      }

      continue;
    }

    if (!BOOLEAN_FLAGS.has(flag)) {
      // An unrecognized flag used to land in `positional`, where every command
      // ignored it: `orangerail status --confg <prod>` read the LOCAL config and
      // reported a confident green status for the wrong project. Fail loudly with
      // the valid set instead, exactly like an unknown `--preset` value does.
      throw new Error(`unknown flag "${flag}" — expected one of ${KNOWN_FLAGS.join(', ')}`);
    }

    if (inline !== undefined) {
      throw new Error(`${flag} does not take a value — got "${token}"`);
    }

    if (flag === '--help' || flag === '-h') {
      help = true;
    } else if (flag === '--version' || flag === '-v') {
      showVersion = true;
    } else if (flag === '--yes' || flag === '-y') {
      yes = true;
    } else if (flag === '--no-open') {
      open = false;
    } else if (flag === '--docs') {
      docs = true;
    } else if (flag === '--no-docs') {
      docs = false;
    } else if (flag === '--studio') {
      studio = true;
    } else if (flag === '--no-studio') {
      studio = false;
    } else if (flag === '--accept-new') {
      acceptNew = true;
    } else if (flag === '--accept-governance') {
      acceptGovernance = true;
    } else {
      full = true;
    }
  }

  return {
    positional,
    open,
    yes,
    acceptNew,
    acceptGovernance,
    full,
    help,
    showVersion,
    ...(configPath === undefined ? {} : { configPath }),
    ...(outPath === undefined ? {} : { outPath }),
    ...(port === undefined ? {} : { port }),
    ...(preset === undefined ? {} : { preset }),
    ...(gate === undefined ? {} : { gate }),
    ...(sources === undefined ? {} : { sources }),
    ...(models === undefined ? {} : { models }),
    ...(docs === undefined ? {} : { docs }),
    ...(studio === undefined ? {} : { studio }),
    ...(fromJira === undefined ? {} : { fromJira }),
    ...(fromSlack === undefined ? {} : { fromSlack }),
  };
};

/** Commands that keep the event loop alive (studio server / mcp stdio / init handoff). */
export const LONG_RUNNING = new Set(['mcp', 'studio', 'init']);

/**
 * Whether this invocation must stay up after the dispatch resolves.
 *
 * The decision keys off the subcommand the PARSER resolved, never off a
 * positional guess at argv: `orangerail --config <path> studio` has `--config` at
 * `argv[2]`, and reading that raw token exited the process immediately after the
 * studio server had printed "serving". `--help` / `--version` short-circuit the
 * dispatch without starting anything, so they never keep us up either.
 */
export const keepAliveFor = ({ args, code }: { args: ParsedArgs; code: number }): boolean => {
  const [command] = args.positional;

  return code === 0 && !args.help && !args.showVersion && LONG_RUNNING.has(command ?? '');
};
