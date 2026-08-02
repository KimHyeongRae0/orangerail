/**
 * The baseline arm: an unenforced write tool over the database, plus a rules file.
 *
 * This is what you do instead of installing anything — you write the rules down and
 * trust the agent to follow them. The client here is scripted rather than a model, and
 * every part of the substitution runs in the baseline's favour: it reads the forbidden
 * operations off the rules by exact name and refuses every one of them without
 * interpretation, hesitation or drift. It is a **perfectly obedient** agent.
 *
 * It reads rules from BOTH places a real agent host does, and that is deliberate — a
 * baseline that only walked up from the working directory would be weaker than the tool
 * it stands in for, and the comparison would flatter us:
 *
 *   - the **project** file: nearest `AGENT_RULES.md` walking up from the working
 *     directory, which is how a per-repo `CLAUDE.md` is found;
 *   - the **global** file: `~/.agent/AGENT_RULES.md`, which is how `~/.claude/CLAUDE.md`
 *     is found — measured on Claude Code 2.1.220, that one is read from every working
 *     directory on the machine, including directories with no project file above them.
 *
 * Both are loaded and the forbidden operations are unioned, so a rule written in either
 * place is obeyed. The global file is resolved through `os.homedir()`, which is to say
 * through the account the process runs under — this file contains no knowledge of the
 * scenario driving it.
 *
 * The one thing it cannot do is obey a rule that is in neither place. That is the only
 * variable these scenarios move.
 *
 * Usage: `node baseline/agent.mjs <operation> <id> [value]`, with DATABASE_URL set.
 * Prints a transcript, and a final `verdict=refused|executed` line for the caller.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const RULES_FILE = 'AGENT_RULES.md';

/** Where the account-wide rules live, the way `~/.claude/CLAUDE.md` does. */
const globalRulesPath = () => join(homedir(), '.agent', RULES_FILE);

/**
 * Finds the nearest rules file walking up from a directory, as an agent host does.
 *
 * @returns {string | null} the absolute path, or `null` when no directory up to the
 *   filesystem root carries one.
 */
const findRules = ({ from }) => {
  let dir = resolve(from);

  for (;;) {
    const candidate = join(dir, RULES_FILE);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(dir);

    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
};

/**
 * Reads the operations the rules file forbids, by exact name.
 *
 * @returns {string[]} every operation named on a `- FORBIDDEN: <name>` line.
 */
const forbiddenOperations = ({ text }) =>
  text
    .split('\n')
    .map((line) => /^-\s+FORBIDDEN:\s+(\S+)/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => match[1]);

/**
 * Runs the operation directly against the database. Nothing gates this call: the tool is
 * a write tool with credentials, which is the whole point of the baseline arm.
 */
const runOperation = async ({ operation, id, value }) => {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    if (operation === 'deleteOrder') {
      return await prisma.order.delete({ where: { id } });
    }

    if (operation === 'deleteCustomer') {
      return await prisma.customer.delete({ where: { id } });
    }

    if (operation === 'updateOrder') {
      return await prisma.order.update({ where: { id }, data: { status: value } });
    }

    throw new Error(`this agent has no tool named ${operation}`);
  } finally {
    await prisma.$disconnect();
  }
};

const [operation, id, value] = process.argv.slice(2);
const say = ({ message }) => console.log(`[baseline agent] ${message}`);

const globalPath = globalRulesPath();
const projectPath = findRules({ from: process.cwd() });

const sources = [
  { label: 'global ', path: globalPath, found: existsSync(globalPath) },
  { label: 'project', path: projectPath, found: projectPath !== null },
];

say({ message: `working directory: ${process.cwd()}` });
say({ message: `home directory:    ${homedir()}` });

for (const source of sources) {
  const where = source.path === null ? `no ${RULES_FILE} in this directory or any parent` : source.path;

  say({ message: `${source.label} rules: ${source.found ? 'FOUND  ' : 'absent '} ${where}` });
}

const forbidden = [
  ...new Set(
    sources
      .filter((source) => source.found)
      .flatMap((source) => forbiddenOperations({ text: readFileSync(source.path, 'utf8') })),
  ),
];

say({ message: `rules forbid: ${forbidden.length === 0 ? '(nothing — there are no rules to obey)' : forbidden.join(', ')}` });
say({ message: `task: ${operation}({ id: "${id}" })` });

if (forbidden.includes(operation)) {
  say({ message: `REFUSED — the rules name ${operation} as forbidden.` });
  say({ message: `report: "Asked to ${operation} ${id}. Did not run it, per the rules. Please decide."` });
  console.log('verdict=refused');
  process.exit(0);
}

await runOperation({ operation, id, value });

say({ message: `RAN IT — ${operation} ${id} executed against the database.` });
console.log('verdict=executed');
