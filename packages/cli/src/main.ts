import { loadConfig } from './config';
import {
  approvalsApprove,
  approvalsList,
  approvalsReject,
  approvalsShow,
} from './commands/approvals';
import { auditVerify } from './commands/audit';
import { runDocs } from './commands/docs';
import { runInit } from './commands/init';
import { runMcp } from './commands/mcp';
import { DEFAULT_STUDIO_PORT, runStudio } from './commands/studio';
import { runStatus } from './commands/status';
import { storeUnlock } from './commands/store';
import { runSync } from './commands/sync';

const USAGE = `orangerail — governed ontology runtime CLI

Usage:
  orangerail init [--yes] [--preset <p>] [--sources <csv>] [--models <csv>]
                [--docs|--no-docs] [--studio|--no-studio] [--no-open] [--port <n>]
                                                 scan a repo and assemble the ontology
  orangerail sync [--config <path>] [--accept-new] re-scan and report drift (exit 1 on drift)
  orangerail mcp [--config <path>]                 launch the MCP server over stdio
  orangerail status [--config <path>]              show the governance posture (gated actions, audit, pending)
  orangerail studio [--config <path>] [--port <n>] [--no-open]  serve the map-mode studio locally
  orangerail docs [--config <path>] [--out <dir>]  generate the agent-facing domain doc
  orangerail approvals list [--config <path>]      list pending approvals
  orangerail approvals show <id> [--config <path>] show one approval
  orangerail approvals approve <id> [--config …]   approve a staged action
  orangerail approvals reject <id> [--config …]    reject a staged action
  orangerail audit verify [--config <path>]        verify the audit chain
  orangerail store unlock [--config <path>]        clear a provably-dead store lock
`;

/** Parsed CLI arguments (§3.4 — hand-rolled, zero runtime deps). */
interface ParsedArgs {
  positional: string[];
  configPath?: string;
  outPath?: string;
  port?: number;
  open: boolean;
  yes: boolean;
  preset?: string;
  sources?: string[];
  models?: string[];
  docs?: boolean;
  studio?: boolean;
  acceptNew: boolean;
  fromJira?: string;
  fromSlack?: string;
}

const splitCsv = ({ value }: { value: string | undefined }): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** Hand-rolled arg parsing (§3.4 — no commander, zero runtime deps). */
const parseArgs = ({ argv }: { argv: string[] }): ParsedArgs => {
  const positional: string[] = [];
  let configPath: string | undefined;
  let outPath: string | undefined;
  let port: number | undefined;
  let open = true;
  let yes = false;
  let preset: string | undefined;
  let sources: string[] | undefined;
  let models: string[] | undefined;
  let docs: boolean | undefined;
  let studio: boolean | undefined;
  let acceptNew = false;
  let fromJira: string | undefined;
  let fromSlack: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--from-jira') {
      fromJira = argv[i + 1];
      i += 1;
    } else if (token?.startsWith('--from-jira=')) {
      fromJira = token.slice('--from-jira='.length);
    } else if (token === '--from-slack') {
      fromSlack = argv[i + 1];
      i += 1;
    } else if (token?.startsWith('--from-slack=')) {
      fromSlack = token.slice('--from-slack='.length);
    } else if (token === '--config') {
      configPath = argv[i + 1];
      i += 1;
    } else if (token === '--out') {
      outPath = argv[i + 1];
      i += 1;
    } else if (token === '--port') {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--no-open') {
      open = false;
    } else if (token === '--yes' || token === '-y') {
      yes = true;
    } else if (token === '--preset') {
      preset = argv[i + 1];
      i += 1;
    } else if (token?.startsWith('--preset=')) {
      preset = token.slice('--preset='.length);
    } else if (token === '--sources') {
      sources = splitCsv({ value: argv[i + 1] });
      i += 1;
    } else if (token?.startsWith('--sources=')) {
      sources = splitCsv({ value: token.slice('--sources='.length) });
    } else if (token === '--models') {
      models = splitCsv({ value: argv[i + 1] });
      i += 1;
    } else if (token?.startsWith('--models=')) {
      models = splitCsv({ value: token.slice('--models='.length) });
    } else if (token === '--docs') {
      docs = true;
    } else if (token === '--no-docs') {
      docs = false;
    } else if (token === '--studio') {
      studio = true;
    } else if (token === '--no-studio') {
      studio = false;
    } else if (token === '--accept-new') {
      acceptNew = true;
    } else if (token !== undefined) {
      positional.push(token);
    }
  }

  return {
    positional,
    open,
    yes,
    acceptNew,
    ...(configPath === undefined ? {} : { configPath }),
    ...(outPath === undefined ? {} : { outPath }),
    ...(port === undefined ? {} : { port }),
    ...(preset === undefined ? {} : { preset }),
    ...(sources === undefined ? {} : { sources }),
    ...(models === undefined ? {} : { models }),
    ...(docs === undefined ? {} : { docs }),
    ...(studio === undefined ? {} : { studio }),
    ...(fromJira === undefined ? {} : { fromJira }),
    ...(fromSlack === undefined ? {} : { fromSlack }),
  };
};

const fail = ({ message }: { message: string }): number => {
  process.stderr.write(`${message}\n`);
  return 2;
};

const requireId = ({ id }: { id: string | undefined }): string => {
  if (id === undefined) {
    throw new Error('this command requires an approval id');
  }

  return id;
};

const run = async (): Promise<number> => {
  const args = parseArgs({ argv: process.argv.slice(2) });
  const { positional, configPath, outPath, port, open } = args;
  const [command, sub, arg] = positional;

  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }

  // `init` dispatches WITHOUT loading a config — it creates one (plan D1).
  if (command === 'init') {
    return runInit({
      cwd: process.cwd(),
      flags: {
        yes: args.yes,
        open: args.open,
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.sources === undefined ? {} : { sources: args.sources }),
        ...(args.models === undefined ? {} : { models: args.models }),
        ...(args.docs === undefined ? {} : { docs: args.docs }),
        ...(args.studio === undefined ? {} : { studio: args.studio }),
        ...(port === undefined ? {} : { port }),
        ...(args.fromJira === undefined ? {} : { fromJira: args.fromJira }),
        ...(args.fromSlack === undefined ? {} : { fromSlack: args.fromSlack }),
      },
    });
  }

  // `sync` loads the config itself (registry = source of truth, plan D11).
  if (command === 'sync') {
    return runSync({ acceptNew: args.acceptNew, cwd: process.cwd(), configPath });
  }

  const config = await loadConfig({ configPath });

  if (command === 'mcp') {
    await runMcp({ config });
    return 0;
  }

  if (command === 'status') {
    return runStatus({ config });
  }

  if (command === 'studio') {
    return runStudio({ config, configPath, port: port ?? DEFAULT_STUDIO_PORT, open });
  }

  if (command === 'docs') {
    return runDocs({ config, outDir: outPath });
  }

  if (command === 'approvals') {
    if (sub === 'list') {
      return approvalsList({ config });
    }
    if (sub === 'show') {
      return approvalsShow({ config, id: requireId({ id: arg }) });
    }
    if (sub === 'approve') {
      return approvalsApprove({ config, id: requireId({ id: arg }) });
    }
    if (sub === 'reject') {
      return approvalsReject({ config, id: requireId({ id: arg }) });
    }

    return fail({ message: `unknown approvals subcommand: ${sub ?? '<none>'}\n\n${USAGE}` });
  }

  if (command === 'audit') {
    if (sub === 'verify') {
      return auditVerify({ config });
    }

    return fail({ message: `unknown audit subcommand: ${sub ?? '<none>'}\n\n${USAGE}` });
  }

  if (command === 'store') {
    if (sub === 'unlock') {
      return storeUnlock({ config });
    }

    return fail({ message: `unknown store subcommand: ${sub ?? '<none>'}\n\n${USAGE}` });
  }

  return fail({ message: `unknown command: ${command}\n\n${USAGE}` });
};

/** Commands that keep the event loop alive (studio server / mcp stdio / init handoff). */
const LONG_RUNNING = new Set(['mcp', 'studio', 'init']);

run()
  .then((code) => {
    // `mcp` (stdio), `studio` (http server), and `init` (studio handoff) keep
    // the event loop alive; every other command exits here.
    if (code !== 0 || !LONG_RUNNING.has(process.argv[2] ?? '')) {
      process.exit(code);
    }
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`orangerail: ${message}\n`);
    process.exit(1);
  });
