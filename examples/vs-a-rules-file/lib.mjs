/**
 * Shared machinery for the two scenarios: a fixed database state, the two arms, and the
 * printing. Nothing here decides an outcome — each scenario asserts its own.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, '..', '..', 'packages', 'cli', 'dist', 'main.js');
export const CONFIG = join(HERE, 'orangerail.config.mjs');
export const DATABASE_URL = `file:${join(HERE, 'prisma', 'dev.db')}`;

/**
 * A directory outside this project, with no rules file anywhere above it. It stands in
 * for every ordinary reason a process does not start at your repo root: a second
 * service's checkout, a scheduler, a container that mounts a subtree, an agent invoked
 * from the home directory.
 */
export const ELSEWHERE = join(tmpdir(), 'orangerail-example-elsewhere');

/**
 * Your account's home directory, where a global rules file would live. Scenario 1 starts
 * it empty and writes the global rules into it partway through, which is the fix a reader
 * proposes the moment they see column 2.
 */
export const HOME_YOURS = join(tmpdir(), 'orangerail-example-home-yours');

/**
 * A home directory that belongs to some other account — a CI runner, a container, a
 * scheduler. It is created empty, because that is what a fresh account's home is. The
 * global rules file on this machine is in HOME_YOURS and is not reachable from here.
 */
export const HOME_OTHER = join(tmpdir(), 'orangerail-example-home-other');

mkdirSync(ELSEWHERE, { recursive: true });
mkdirSync(HOME_YOURS, { recursive: true });
mkdirSync(HOME_OTHER, { recursive: true });

// The example owns its database path, so every arm and every child process reaches the
// same file no matter which directory it was started from.
process.env.DATABASE_URL = DATABASE_URL;

const env = { ...process.env, DATABASE_URL };

export const rule = ({ title }) => console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`);
export const banner = ({ title }) => console.log(`\n${'═'.repeat(74)}\n${title}\n${'═'.repeat(74)}`);

export const assert = ({ ok, message }) => {
  if (!ok) {
    console.error(`\nFAILED ASSERTION: ${message}`);
    process.exit(1);
  }
};

/** Opens a Prisma client against the same database both arms write to. */
export const openDatabase = async () => {
  const { PrismaClient } = await import('@prisma/client');

  return new PrismaClient();
};

/**
 * Clears the approvals queue and the audit chain, so a re-run prints the same counts as
 * the first run. Only the store is removed; the generated docs beside it are left alone.
 */
export const resetStore = () => {
  rmSync(join(HERE, '.orangerail', 'store'), { recursive: true, force: true });
};

/** Resets the database to a fixed starting state, so every run says the same thing. */
export const seed = async ({ prisma }) => {
  await prisma.order.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({ data: { id: 'c1', name: 'Ada', email: 'ada@example.com' } });
  await prisma.order.create({ data: { id: 'o4', status: 'cancelled', total: 4200 } });
  await prisma.order.create({ data: { id: 'o5', status: 'paid', total: 900 } });
};

/** Reads the row both arms are asked to delete, straight from the database. */
export const orderState = async ({ prisma, id }) =>
  (await prisma.order.findUnique({ where: { id } })) === null ? 'GONE' : 'STILL THERE';

/** Resets the products scenario 3 uses. `p2` is the sold-out row its rule exists to protect. */
export const seedProducts = async ({ prisma }) => {
  await prisma.product.deleteMany();

  await prisma.product.create({ data: { id: 'p1', title: 'Desk lamp', status: 'active', priceCents: 1999 } });
  await prisma.product.create({ data: { id: 'p2', title: 'Wall clock', status: 'soldout', priceCents: 2999 } });
};

/**
 * Reads a product with raw SQL rather than through the generated model.
 *
 * Scenario 3 regenerates the Prisma client mid-run, so a read that went through the
 * generated model would answer about whichever client version happened to be loaded. The
 * column is never dropped from the table — only from the schema the client is generated
 * from — so raw SQL always sees the truth.
 */
export const productRow = async ({ prisma, id }) => {
  const rows = await prisma.$queryRawUnsafe('SELECT id, status, priceCents FROM Product WHERE id = ?', id);

  return rows[0];
};

/**
 * Runs the baseline arm as a real child process with a real working directory, so the
 * rules file is discovered (or not) exactly as it would be in the field.
 *
 * @returns {{ verdict: string }} `refused` or `executed`, as the agent reported it.
 */
export const runBaselineArm = ({ cwd, operation, id, home, script = 'agent.mjs', args = [operation, id] }) => {
  const result = spawnSync('node', [join(HERE, 'baseline', script), ...args], {
    cwd,
    env: home === undefined ? env : { ...env, HOME: home },
    encoding: 'utf8',
  });

  process.stdout.write(result.stdout.replace(/^/gm, '  '));

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
  }

  const verdict = /verdict=(\w+)/.exec(result.stdout)?.[1] ?? 'crashed';

  return { verdict };
};

/**
 * The orangerail arm. `registration` is the `command` / `args` / `env` triple an agent
 * host stores when you register the server — the same triple is reused across working
 * directories on purpose, because that is the fact under test.
 */
export const registration = ({ configPath = CONFIG } = {}) => ({
  command: 'node',
  args: [CLI, 'mcp', '--config', configPath],
  env: { DATABASE_URL },
});

/** Prints the registration the way a host config file holds it. */
export const printRegistration = ({ reg }) => {
  console.log('  the server registration, byte for byte the same in both runs:');
  console.log(`    command: ${reg.command}`);
  console.log(`    args:    ${reg.args.join(' ')}`);
  console.log(`    env:     DATABASE_URL=${reg.env.DATABASE_URL}`);
};

/**
 * Connects a real MCP client from a given working directory and calls one tool.
 *
 * @returns {{ tools: string[], result: object }} the published tool list and the
 *   structured result of the call.
 */
export const runOrangerailArm = async ({ cwd, tool, args, home, reg = registration() }) => {
  const transport = new StdioClientTransport({
    command: reg.command,
    args: reg.args,
    cwd,
    env: { ...env, ...reg.env, ...(home === undefined ? {} : { HOME: home }) },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'demo-agent', version: '0.0.0' }, { capabilities: {} });

  await client.connect(transport);

  const hostLog = [];

  transport.stderr?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim() !== '') {
        hostLog.push(line.trim());
      }
    }
  });

  const tools = (await client.listTools()).tools.map((t) => t.name);

  let result;
  let text = '';

  try {
    const call = await client.callTool({ name: tool, arguments: args });

    result = call?.structuredContent ?? {};
    text = call?.content?.[0]?.text ?? '';
  } catch (error) {
    result = { status: 'call_rejected', message: error?.message ?? String(error) };
  }

  await client.close();

  return { tools, result, text, hostLog };
};

/** Runs the orangerail CLI against this project, from this project. */
export const cli = ({ args, cwd = HERE, configPath = CONFIG }) =>
  spawnSync('node', [CLI, ...args, '--config', configPath], { cwd, env, encoding: 'utf8' });
