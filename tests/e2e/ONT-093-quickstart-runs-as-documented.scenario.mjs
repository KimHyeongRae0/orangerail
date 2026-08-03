/**
 * ONT-093 e2e driver — the README's own Quickstart runs as documented, and
 * reaches the governed write it promises.
 *
 * ONT-087 (#141/#142) made every `examples/` README run as written. Nothing did
 * that for the README's Quickstart, and following it verbatim from a cold start
 * did not work: the page never installed `@prisma/client`, never ran
 * `prisma generate` and never created the database, so the closing move — a
 * human approving a staged delete and the agent's next `check_approval`
 * executing it — failed with `the datasource client is not installed or has
 * never been generated`, spending the approval and changing no row.
 *
 * So this driver does not retype the Quickstart's commands. It LIFTS them out
 * of `README.md`, in document order, and executes them:
 *
 *   - every line of every ```bash fence in the `## Quickstart` section;
 *   - every `$ `-prefixed line of every ```console fence there, because that is
 *     where the page puts a command it also shows the output of;
 *   - the ```json fence, written to the project as `.mcp.json`, which is what
 *     the prose above it tells the reader to do with it.
 *
 * The section ends at the next heading of any level, so the `### A table you
 * refuse stays refused` aside — whose `init --exclude` fence is an alternative
 * to step 2, not a step after it — is outside what runs.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. The scenario installs THIS TREE's
 * packed tarballs, not the published `orangerail` on npm. It proves the
 * documented SEQUENCE works against this source tree; it cannot prove the
 * published tarball does. That is the release gate's job, and a green run here
 * must not be read as more than it checked.
 *
 * Three substitutions are made in the lifted commands, each reported on stdout
 * so the omission stays visible:
 *
 *   1. the five workspace package names in an `npm i`/`npm install` line are
 *      replaced by this tree's packed tarballs (see above);
 *   2. `prisma@6` is installed as fixture setup rather than lifted, because
 *      step 2's prose says "Run this in a repo with a `prisma/schema.prisma`" —
 *      the reader's Prisma toolchain predates the Quickstart;
 *   3. the approval id in `orangerail approvals approve <id>` is a uuid minted
 *      by the run being documented, so it is rewritten to the id THIS run
 *      staged. Nothing else about that command is touched: change the verb or
 *      the flags and this scenario runs the new thing.
 *
 * `DATABASE_URL` is DELETED from the environment of every lifted block. Step 4
 * exports it, and if that export is ever dropped the block must die the way a
 * stranger's shell would rather than inherit one from the runner (ONT-085's
 * failure mode, in an example).
 *
 * Phases:
 *
 *   phase 1  the setup half of the documented sequence — everything up to the
 *            first command that reads the operator surface — runs to exit 0.
 *   phase 2  the agent, through a real MCP stdio client spawned exactly as the
 *            documented `.mcp.json` says: an auto action returns a row, and the
 *            gated `deleteCustomer` stages instead of executing.
 *   phase 3  the operator half — `status`, `approvals list`, `approvals approve`
 *            — lifted from the page and run with the staged id.
 *   phase 4  the agent's next `check_approval` executes, and the row is GONE.
 *            This is the payoff the page promises and could not reach.
 *
 * RED (pre-implementation): drop step 4 (`@prisma/client` / `prisma generate` /
 * `prisma db push`) from the README's Quickstart and phase 2 fails on the first
 * auto write with `the datasource client is not installed or has never been
 * generated` — the exact defect this ticket exists for, verifiable in one edit.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = join(ROOT, 'README.md');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-093');

// The scratch project lives OUTSIDE the repo (ONT-019's reason): a project
// nested under the monorepo resolves `@prisma/client`, `zod` and
// `orangerail-core` by walking up into the repo's own node_modules, which is
// exactly how a missing documented install step goes unnoticed. `process.pid`
// isolates concurrent runs without Date.now/random.
const WORK = join(tmpdir(), `orangerail-ont-093-${process.pid}`);
const PACK_DIR = join(WORK, 'tarballs');
const PROJECT = join(WORK, 'shop');

/** The workspace packages a lifted `npm install` must resolve from this tree. */
const WORKSPACE_PACKAGES = [
  { name: 'orangerail', dir: 'packages/cli' },
  { name: 'orangerail-core', dir: 'packages/core' },
  { name: 'orangerail-mcp', dir: 'packages/mcp' },
  { name: 'orangerail-docs-gen', dir: 'packages/docs-gen' },
  { name: 'orangerail-studio', dir: 'packages/studio' },
];

/** A uuid as `approvals approve` receives it. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const fail = ({ message }) => {
  console.error(`ONT-093 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const resetDir = ({ dir }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
};

/** Run a command to completion, returning status + captured output. */
const run = ({ command, args, cwd, env }) => {
  const child = { ...process.env, ...(env ?? {}) };
  delete child.DATABASE_URL;

  const res = spawnSync(command, args, {
    cwd,
    env: child,
    encoding: 'utf8',
    timeout: 600_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

// ───────── lifting the Quickstart out of the README ─────────

/**
 * The lines of the README's `## Quickstart` section, ending at the next heading
 * of any level. A README without one cannot be followed, which is a finding
 * about the README rather than about this scenario.
 */
const quickstartLines = () => {
  const lines = readFileSync(README, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^##\s+Quickstart\s*$/.test(line));

  assert({
    ok: start !== -1,
    message: 'README.md has no "## Quickstart" section — this scenario does not know what to run',
  });

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{2,}\s/.test(line));

  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * Every fenced block in the given lines, in document order, as
 * `{ language, body }`. Language is whatever follows the opening backticks.
 */
const fences = ({ lines }) => {
  const found = [];
  let current = null;

  for (const line of lines) {
    if (current === null) {
      const opening = /^```(\w*)\s*$/.exec(line);
      if (opening !== null) {
        current = { language: opening[1], body: [] };
      }
      continue;
    }

    if (/^```\s*$/.test(line)) {
      found.push({ language: current.language, body: current.body.join('\n') });
      current = null;
      continue;
    }

    current.body.push(line);
  }

  return found;
};

/**
 * The commands the Quickstart tells a reader to type, in document order.
 *
 * A ```bash fence is all command; a ```console fence is a transcript, so only
 * its `$ `-prefixed lines are. Comments and blank lines are dropped — they are
 * for the reader, and a `#` line is not a step.
 */
const documentedCommands = ({ blocks }) => {
  const commands = [];

  for (const block of blocks) {
    if (block.language === 'bash') {
      for (const line of block.body.split('\n')) {
        const trimmed = line.trim();
        if (trimmed !== '' && !trimmed.startsWith('#')) {
          commands.push(trimmed);
        }
      }
      continue;
    }

    if (block.language === 'console') {
      for (const line of block.body.split('\n')) {
        if (line.startsWith('$ ')) {
          commands.push(line.slice(2).trim());
        }
      }
    }
  }

  return commands;
};

// ───────── a minimal MCP stdio client (the ONT-003/018/019 pattern) ─────────

const openMcpSession = async ({ command, args, cwd, env }) => {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');

    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (line !== '') {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const settle = pending.get(msg.id);
          pending.delete(msg.id);
          settle(msg);
        }
      }

      idx = buffer.indexOf('\n');
    }
  });

  const send = ({ payload }) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = ({ method, params }) => {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`MCP request timed out: ${method}\n--- server stderr ---\n${stderr}`)),
        30_000,
      );
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(`MCP error for ${method}: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolve(msg.result);
      });
      send({ payload: { jsonrpc: '2.0', id, method, params } });
    });
  };

  const exited = new Promise((resolve) => child.on('exit', resolve));

  await request({
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ont-093-e2e', version: '0.0.0' },
    },
  });
  send({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  return {
    callTool: ({ name, args: toolArgs }) =>
      request({ method: 'tools/call', params: { name, arguments: toolArgs } }),
    stderrSoFar: () => stderr,
    close: async () => {
      child.stdin.end();
      child.kill('SIGTERM');
      await exited;
    },
  };
};

/** The text a tool call came back with, joined. */
const resultText = ({ result }) =>
  (result?.content ?? []).map((part) => part.text ?? '').join('\n');

// ───────── setup: the tree's tarballs, and the repo the reader already has ─────────

console.log('ONT-093: lifting the Quickstart out of README.md');

const blocks = fences({ lines: quickstartLines() });
const commands = documentedCommands({ blocks });

assert({
  ok: commands.length > 0,
  message: 'the README Quickstart section documents no commands — nothing to run',
});

const mcpJson = blocks.find((block) => block.language === 'json');
assert({
  ok: mcpJson !== undefined,
  message: 'the README Quickstart documents no ```json block — there is no .mcp.json to write',
});

const hostConfig = JSON.parse(mcpJson.body).mcpServers?.orangerail;
assert({
  ok: hostConfig !== undefined,
  message: 'the documented .mcp.json declares no "orangerail" server',
});

// AC-1 has no other automated guard: `-y` is the standing permission that lets a
// host fetch a copy of its own, which is the duplicate install the Quickstart
// exists to avoid — made permanent for the one process that does the writing.
assert({
  ok: !(hostConfig.args ?? []).includes('-y'),
  message:
    'the documented .mcp.json spawns the server with `-y`, which lets the agent host fetch its ' +
    'own copy of orangerail rather than running the one the Quickstart installs',
});

resetDir({ dir: WORK });
mkdirSync(PACK_DIR, { recursive: true });

const tarballs = new Map();

for (const pkg of WORKSPACE_PACKAGES) {
  const dest = join(PACK_DIR, pkg.name);
  mkdirSync(dest, { recursive: true });

  const packed = run({
    command: 'pnpm',
    args: ['pack', '--pack-destination', dest],
    cwd: join(ROOT, pkg.dir),
  });
  assert({
    ok: packed.status === 0,
    message: `\`pnpm pack\` failed for ${pkg.dir} — harness precondition, not the feature:\n${packed.stdout}\n${packed.stderr}`,
  });

  const files = readdirSync(dest).filter((name) => name.endsWith('.tgz'));
  assert({
    ok: files.length === 1,
    message: `expected one tarball for ${pkg.dir}, got ${files.join(', ')}`,
  });

  tarballs.set(pkg.name, join(dest, files[0]));
}

console.log(
  `ONT-093: packed ${tarballs.size} workspace package(s) — the lifted install lines resolve to these`,
);

cpSync(FIXTURE, PROJECT, { recursive: true });

// The reader's own Prisma toolchain, which step 2 assumes and does not install.
const prismaSetup = run({
  command: 'npm',
  args: ['install', '--no-audit', '--no-fund', '--save-dev', 'prisma@6'],
  cwd: PROJECT,
});
assert({
  ok: prismaSetup.status === 0,
  message:
    'fixture setup: installing prisma@6 into the scratch project failed (offline?) — this is the ' +
    `repo the Quickstart assumes, not a documented step:\n${prismaSetup.stdout}\n${prismaSetup.stderr}`,
});

console.log('ONT-093: fixture ready — a Prisma 6 project holding only the Customer/Order schema');

// ───────── the lifted commands, with the three reported substitutions ─────────

/** Rewrite a lifted command so it resolves against this tree instead of npm. */
const againstThisTree = ({ command }) => {
  if (!/^npm (i|install)\b/.test(command)) {
    return command;
  }

  const rewritten = command
    .split(/\s+/)
    .map((token) => tarballs.get(token) ?? token)
    .join(' ');

  if (rewritten !== command) {
    // Installing the CLI tarball alone would pull its four siblings from npm,
    // which is the published build this scenario is deliberately not testing.
    const missing = [...tarballs.entries()].filter(([, tgz]) => !rewritten.includes(tgz));
    return [rewritten, ...missing.map(([, tgz]) => tgz)].join(' ');
  }

  return command;
};

/**
 * The first command that reads the operator surface. Everything before it is
 * setup a reader does once; everything from it on is what they do when they
 * come back, and the approval it acts on has to exist by then.
 */
const operatorIndex = commands.findIndex((command) =>
  /\borangerail\s+(status|approvals)\b/.test(command),
);

assert({
  ok: operatorIndex > 0,
  message:
    'the Quickstart documents no `orangerail status` / `approvals` command — this scenario ' +
    'cannot tell where the setup ends and the operator readout begins',
});

const setupCommands = commands.slice(0, operatorIndex);
const operatorCommands = commands.slice(operatorIndex);

/** Execute a list of lifted commands as one bash script, in order. */
const runDocumented = ({ label, list }) => {
  const script = ['set -euo pipefail', '', ...list].join('\n');
  const scriptPath = join(WORK, `${label}.sh`);
  writeFileSync(scriptPath, `${script}\n`, 'utf8');

  const result = run({ command: 'bash', args: [scriptPath], cwd: PROJECT });
  writeFileSync(join(WORK, `${label}.log`), `${result.stdout}${result.stderr}`, 'utf8');

  return result;
};

// ───────── phase 1 — the documented setup ─────────

console.log(
  `\n[phase 1] ${setupCommands.length} documented setup command(s), lifted from the README:`,
);
for (const command of setupCommands) {
  const rewritten = againstThisTree({ command });
  const note = rewritten === command ? '' : "   → resolved against this tree's packed tarballs";
  console.log(`   ${command}${note}`);
}

// The `.mcp.json` fence, written where its own prose says to write it. It is
// also what phase 2 spawns the server from, so a host config the reader could
// not use is a host config this scenario cannot use either.
writeFileSync(join(PROJECT, '.mcp.json'), `${mcpJson.body}\n`, 'utf8');
console.log('   (the documented ```json block written to .mcp.json, as its prose instructs)');

const setup = runDocumented({
  label: 'phase1-setup',
  list: setupCommands.map((command) => againstThisTree({ command })),
});

if (setup.status !== 0) {
  console.error(`\n─── phase 1 exited ${setup.status}, last 40 lines ───`);
  console.error(`${setup.stdout}${setup.stderr}`.split('\n').slice(-40).join('\n'));
  console.error('──────────────────────────────────────────────');
  fail({ message: "the Quickstart's setup commands do not run as documented" });
}

console.log('   phase 1 ok');

// ───────── phase 2 — the agent, spawned the way .mcp.json says ─────────

console.log('\n[phase 2] the agent, through the documented .mcp.json');

const session = await openMcpSession({
  command: hostConfig.command,
  args: hostConfig.args ?? [],
  cwd: PROJECT,
  env: hostConfig.env ?? {},
});

const created = await session.callTool({
  name: 'createCustomer',
  args: { email: 'ada@example.com', name: 'Ada' },
});
const createdText = resultText({ result: created });

assert({
  ok: created.isError !== true && /"id"\s*:\s*1\b/.test(createdText),
  message:
    'an UN-gated write must run when the agent calls it and come back with the row. It did not, ' +
    `which is what a missing database step looks like:\n${createdText}\n--- server stderr ---\n${session.stderrSoFar()}`,
});

const second = await session.callTool({
  name: 'createCustomer',
  args: { email: 'grace@example.com', name: 'Grace' },
});
assert({
  ok: second.isError !== true,
  message: `the second un-gated write failed:\n${resultText({ result: second })}`,
});

const staged = await session.callTool({ name: 'deleteCustomer', args: { id: 2 } });
const stagedText = resultText({ result: staged });
const stagedId = UUID.exec(stagedText)?.[0];

assert({
  ok: staged.isError !== true && stagedId !== undefined,
  message: `the gated \`deleteCustomer\` must stage and hand back an approval id, got:\n${stagedText}`,
});

const beforeApproval = await session.callTool({ name: 'Customer_get', args: { id: 2 } });
assert({
  ok: /"id"\s*:\s*2\b/.test(resultText({ result: beforeApproval })),
  message: `staging must not delete the row, but Customer 2 is already gone:\n${resultText({ result: beforeApproval })}`,
});

await session.close();

console.log(
  `   an auto write returned a row, deleteCustomer staged ${stagedId}, the row is still there`,
);

// ───────── phase 3 — the documented operator readout ─────────

console.log(
  `\n[phase 3] ${operatorCommands.length} documented operator command(s), lifted from the README:`,
);

const withStagedId = operatorCommands.map((command) => {
  console.log(`   ${command}`);

  if (!UUID.test(command)) {
    return command;
  }

  console.log(`     → approval id rewritten to the one THIS run staged: ${stagedId}`);
  return command.replace(UUID, stagedId);
});

const operator = runDocumented({ label: 'phase3-operator', list: withStagedId });

if (operator.status !== 0) {
  console.error(`\n─── phase 3 exited ${operator.status}, last 40 lines ───`);
  console.error(`${operator.stdout}${operator.stderr}`.split('\n').slice(-40).join('\n'));
  console.error('──────────────────────────────────────────────');
  fail({ message: "the Quickstart's operator commands do not run as documented" });
}

assert({
  ok: operator.stdout.includes(stagedId),
  message: `the documented \`approvals list\` never named the staged approval:\n${operator.stdout}`,
});
assert({
  ok: operator.stdout.includes('approve ok (approved)'),
  message: `the documented \`approvals approve\` did not report an approval:\n${operator.stdout}`,
});

console.log('   phase 3 ok — a human decision is recorded in the store');

// ───────── phase 4 — the payoff the page promises ─────────

console.log('\n[phase 4] the agent comes back to a decided approval');

const back = await openMcpSession({
  command: hostConfig.command,
  args: hostConfig.args ?? [],
  cwd: PROJECT,
  env: hostConfig.env ?? {},
});

const executed = await back.callTool({ name: 'check_approval', args: { approvalId: stagedId } });
const executedText = resultText({ result: executed });

assert({
  ok: executed.isError !== true,
  message:
    'the approved action must execute on the next `check_approval`. This is the defect ONT-093 ' +
    `fixed — a spent approval and an unchanged row:\n${executedText}\n--- server stderr ---\n${back.stderrSoFar()}`,
});

const afterDelete = await back.callTool({ name: 'Customer_get', args: { id: 2 } });
const afterText = resultText({ result: afterDelete });

assert({
  ok: !/"id"\s*:\s*2\b/.test(afterText),
  message: `check_approval reported success and Customer 2 is still there — the write did not happen:\n${afterText}`,
});

await back.close();

const drained = run({
  command: join(PROJECT, 'node_modules', '.bin', 'orangerail'),
  args: ['approvals', 'list'],
  cwd: PROJECT,
});
assert({
  ok: drained.stdout.includes('No pending approvals.'),
  message: `the executed approval should have left the queue empty, got:\n${drained.stdout}`,
});

console.log('   phase 4 ok — the approval executed and the row is gone');

assert({
  ok: existsSync(join(PROJECT, 'orangerail.governance.json')),
  message: 'the documented sequence never produced orangerail.governance.json',
});

console.log(
  `\nONT-093: the Quickstart ran as documented, end to end, in ${PROJECT}.` +
    "\nONT-093: it ran against this tree's packed tarballs, so it proves the documented SEQUENCE, " +
    'not the tarball published to npm.',
);

// Only on success: a failed run leaves the project and its logs where the next
// person can open them, which is the whole reason the scripts are written out.
rmSync(WORK, { recursive: true, force: true });
