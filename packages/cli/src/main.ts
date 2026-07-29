import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { keepAliveFor, parseArgs, type ParsedArgs } from './args';
import { loadConfig, resolveConfigPath } from './config';
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
  orangerail sync [--config <path>] [--accept-new] [--accept-governance]
                                                   re-scan and report drift
                                                   exit 0 nothing to act on / 1 unresolved drift / 2 could not check
                                                   --accept-governance re-records orangerail.governance.json
  orangerail mcp [--config <path>]                 launch the MCP server over stdio
                                                   (withholds actions weaker than the recorded baseline)
  orangerail status [--config <path>]              show the governance posture (gated actions, baseline, audit, pending)
  orangerail studio [--config <path>] [--port <n>] [--no-open]  serve the map-mode studio locally
  orangerail docs [--config <path>] [--out <dir>]  generate the agent-facing domain doc
  orangerail approvals list [--config <path>]      list pending approvals
  orangerail approvals show <id> [--full] [--config <path>]
                                                   show one approval (--full: uncapped input)
  orangerail approvals approve <id> [--config …]   approve a staged action
  orangerail approvals reject <id> [--config …]    reject a staged action
  orangerail audit verify [--config <path>]        verify the audit chain
  orangerail store unlock [--config <path>]        clear a provably-dead store lock

  --help, -h     print this usage (accepted anywhere, e.g. \`orangerail init --help\`)
  --version, -v  print the CLI version
`;

/**
 * The shipped version, read from the package manifest so it can never drift
 * from what npm would install. `dist/main.js` sits one level under the package
 * root in both the repo and the published tarball, so the relative path holds.
 */
const readVersion = (): string => {
  const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

  return (JSON.parse(manifest) as { version: string }).version;
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

const dispatch = async ({ args }: { args: ParsedArgs }): Promise<number> => {
  const { positional, configPath, outPath, port, open } = args;
  const [command, sub, arg] = positional;

  // `--version` / `--help` are answered before any dispatch, so they never fall
  // through to a command that would load a config or start scanning the repo.
  if (args.showVersion) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === undefined) {
    process.stdout.write(USAGE);
    return 2;
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
    return runSync({
      acceptGovernance: args.acceptGovernance,
      acceptNew: args.acceptNew,
      cwd: process.cwd(),
      configPath,
    });
  }

  const config = await loadConfig({ configPath });

  // The governance baseline sits next to the config that declares the registry
  // it describes, so `orangerail mcp --config /elsewhere/orangerail.config.mjs`
  // checks the project it is actually serving rather than whatever directory it
  // was launched from. With no `--config` this is the cwd.
  const projectRoot = dirname(resolveConfigPath({ configPath }));

  if (command === 'mcp') {
    await runMcp({ config, projectRoot });
    return 0;
  }

  if (command === 'status') {
    return runStatus({ config, projectRoot });
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
      return approvalsShow({ config, id: requireId({ id: arg }), full: args.full });
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

/** The outcome of a run: the exit code, plus whether this process should stay up. */
interface RunResult {
  code: number;
  keepAlive: boolean;
}

const run = async (): Promise<RunResult> => {
  const args = parseArgs({ argv: process.argv.slice(2) });
  const code = await dispatch({ args });

  return { code, keepAlive: keepAliveFor({ args, code }) };
};

/**
 * Exit once stdout and stderr have drained. `process.exit` discards whatever is
 * still queued on a pipe, which silently truncated a large `approvals show`
 * (1 MB in, 128 KB out) — the operator surface must never quietly lose output it
 * claims to have printed. Writing an empty chunk and exiting from its callback
 * guarantees everything queued before it has been flushed.
 */
const exitAfterFlush = ({ code }: { code: number }): void => {
  let pending = 2;
  const done = (): void => {
    pending -= 1;

    if (pending === 0) {
      process.exit(code);
    }
  };

  // A closed reader (`| head -1`) makes the write fail rather than drain; the
  // callback still runs with an error, so exit is never blocked on a dead pipe.
  process.stdout.write('', done);
  process.stderr.write('', done);
};

run()
  .then(({ code, keepAlive }) => {
    // `mcp` (stdio), `studio` (http server), and `init` (studio handoff) keep
    // the event loop alive; every other command exits here.
    if (!keepAlive) {
      exitAfterFlush({ code });
    }
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`orangerail: ${message}\n`);
    exitAfterFlush({ code: 1 });
  });
