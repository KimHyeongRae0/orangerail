import { loadConfig } from './config';
import {
  approvalsApprove,
  approvalsList,
  approvalsReject,
  approvalsShow,
} from './commands/approvals';
import { auditVerify } from './commands/audit';
import { runMcp } from './commands/mcp';
import { storeUnlock } from './commands/store';

const USAGE = `orangerail — governed ontology runtime CLI

Usage:
  orangerail mcp [--config <path>]                 launch the MCP server over stdio
  orangerail approvals list [--config <path>]      list pending approvals
  orangerail approvals show <id> [--config <path>] show one approval
  orangerail approvals approve <id> [--config …]   approve a staged action
  orangerail approvals reject <id> [--config …]    reject a staged action
  orangerail audit verify [--config <path>]        verify the audit chain
  orangerail store unlock [--config <path>]        clear a provably-dead store lock
`;

/** Hand-rolled arg parsing (§3.4 — no commander, zero runtime deps). */
const parseArgs = ({ argv }: { argv: string[] }): { positional: string[]; configPath?: string } => {
  const positional: string[] = [];
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--config') {
      configPath = argv[i + 1];
      i += 1;
    } else if (token !== undefined) {
      positional.push(token);
    }
  }

  return configPath === undefined ? { positional } : { positional, configPath };
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
  const { positional, configPath } = parseArgs({ argv: process.argv.slice(2) });
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

run()
  .then((code) => {
    // `mcp` keeps the event loop alive via stdio; other commands exit here.
    if (code !== 0 || process.argv[2] !== 'mcp') {
      process.exit(code);
    }
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`orangerail: ${message}\n`);
    process.exit(1);
  });
