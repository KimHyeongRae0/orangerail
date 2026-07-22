import { loadConfig } from './config';
import {
  approvalsApprove,
  approvalsList,
  approvalsReject,
  approvalsShow,
} from './commands/approvals';
import { auditVerify } from './commands/audit';
import { runDocs } from './commands/docs';
import { runMcp } from './commands/mcp';
import { DEFAULT_STUDIO_PORT, runStudio } from './commands/studio';
import { storeUnlock } from './commands/store';

const USAGE = `orangerail — governed ontology runtime CLI

Usage:
  orangerail mcp [--config <path>]                 launch the MCP server over stdio
  orangerail studio [--config <path>] [--port <n>] [--no-open]  serve the map-mode studio locally
  orangerail docs [--config <path>] [--out <dir>]  generate the agent-facing domain doc
  orangerail approvals list [--config <path>]      list pending approvals
  orangerail approvals show <id> [--config <path>] show one approval
  orangerail approvals approve <id> [--config …]   approve a staged action
  orangerail approvals reject <id> [--config …]    reject a staged action
  orangerail audit verify [--config <path>]        verify the audit chain
  orangerail store unlock [--config <path>]        clear a provably-dead store lock
`;

/** Hand-rolled arg parsing (§3.4 — no commander, zero runtime deps). */
const parseArgs = ({
  argv,
}: {
  argv: string[];
}): {
  positional: string[];
  configPath?: string;
  outPath?: string;
  port?: number;
  open: boolean;
} => {
  const positional: string[] = [];
  let configPath: string | undefined;
  let outPath: string | undefined;
  let port: number | undefined;
  let open = true;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--config') {
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
    } else if (token !== undefined) {
      positional.push(token);
    }
  }

  return {
    positional,
    open,
    ...(configPath === undefined ? {} : { configPath }),
    ...(outPath === undefined ? {} : { outPath }),
    ...(port === undefined ? {} : { port }),
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
  const { positional, configPath, outPath, port, open } = parseArgs({
    argv: process.argv.slice(2),
  });
  const [command, sub, arg] = positional;

  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }

  const config = await loadConfig({ configPath });

  if (command === 'mcp') {
    await runMcp({ config });
    return 0;
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

const LONG_RUNNING = new Set(['mcp', 'studio']);

run()
  .then((code) => {
    // `mcp` (stdio) and `studio` (http server) keep the event loop alive; every
    // other command exits here.
    if (code !== 0 || !LONG_RUNNING.has(process.argv[2] ?? '')) {
      process.exit(code);
    }
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`orangerail: ${message}\n`);
    process.exit(1);
  });
