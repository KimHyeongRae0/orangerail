/**
 * ONT-067 e2e driver — the Prisma 7 default generator block, end to end
 * (ticket section 5).
 *
 * `npx prisma init` on prisma 7.9.1 writes
 * `generator client { provider = "prisma-client"  output = "../generated/prisma" }`.
 * That generator writes the client into `output` and puts NOTHING into
 * `@prisma/client`, so an ontology importing the package resolves a directory
 * with no client in it. init printed its full success banner over that, and
 * every tool call then failed with a remedy the user had already run.
 *
 *   Phase 1 (AC-2): `prisma-client-js`, and no generator block at all, emit
 *     output BYTE-IDENTICAL to a reference captured from `main` — every
 *     generated file compared in full, not by inspection.
 *   Phase 2 (AC-3): `prisma-client` with no `output` refuses before writing a
 *     byte: exit 1, no `ontology/`, no config, no `orangerail.governance.json`,
 *     and a message naming both the missing field and the legacy generator.
 *   Phase 3 (section 4): an `env()` output and an output outside the project
 *     refuse the same way — neither becomes a guessed path nor a climbing import.
 *   Phase 4 (AC-1): the literal `prisma init` block, against a REAL prisma 7.9.1
 *     install and a REAL MySQL database. `prisma generate` writes the client,
 *     `orangerail init` emits an import that names it, the shipped MCP server
 *     boots, and `Customer_list` returns the seeded rows.
 *
 * Phase 4 needs a reachable MySQL and a network install, so it is
 * capability-gated (DEV-01): unavailable means a LOUD skip, never a silent pass.
 * Set ORANGERAIL_ONT067_MYSQL_URL to point it at a database it may create and
 * drop; it defaults to a local root connection. It also needs a Node that runs
 * TypeScript, because the `prisma-client` generator emits TypeScript and nothing
 * else — `generatedFileExtension` accepts only `ts`, `mts` and `cts`. Node 22.18+
 * does that with no flag; older 22.x is given `--experimental-strip-types`.
 *
 * Everything runs OUTSIDE the repo, under os.tmpdir(): the Prisma-major probe
 * walks upward for `node_modules/@prisma/client`, so a scratch dir inside the
 * monorepo would read the monorepo's Prisma 6 whatever the phase installed.
 *
 * RED (pre-implementation): phase 2 fails first — init exits 0 and writes a full
 * ontology for a schema whose client import cannot resolve. Phase 4 then fails at
 * the first tool call, which is the defect exactly as reported.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const CORE = join(ROOT, 'packages', 'core');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-067');
const REFERENCE = join(FIXTURE, 'reference');

// process.pid keeps concurrent runs isolated without Date.now/random.
const WORK = join(tmpdir(), `orangerail-ont-067-${process.pid}`);

const INIT_ARGS = ['init', '--yes', '--no-studio', '--no-docs'];

/** The prisma line-up this ticket was verified against, pinned so a rerun is the same run. */
const PRISMA_VERSION = '7.9.1';

const MYSQL_URL =
  process.env['ORANGERAIL_ONT067_MYSQL_URL'] ?? 'mysql://root@127.0.0.1:3306/orangerail_ont067_e2e';

let skipped = 0;

const fail = ({ message }) => {
  console.error(`ONT-067 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const skip = ({ message }) => {
  skipped += 1;
  console.error(`\n>>> ONT-067 e2e SKIP: ${message}\n`);
};

/**
 * A fresh fixture repo whose schema is one generator block prepended to the
 * shared models. Composing here rather than committing six near-identical
 * schemas keeps the generator block the ONLY difference between phases.
 */
const makeRepo = ({ name, generator }) => {
  const dir = join(WORK, name);

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'prisma'), { recursive: true });

  cpSync(join(FIXTURE, 'package.json'), join(dir, 'package.json'));

  const header = readFileSync(join(FIXTURE, 'generators', `${generator}.prisma`), 'utf8');
  const models = readFileSync(join(FIXTURE, 'models.prisma'), 'utf8');

  writeFileSync(join(dir, 'prisma', 'schema.prisma'), `${header}\n${models}`, 'utf8');

  return dir;
};

const runInit = ({ cwd, env }) => {
  const res = spawnSync(process.execPath, [CLI, ...INIT_ARGS], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, ...env },
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** Every file under a directory, path-relative and sorted, so two trees compare as one list. */
const treeOf = ({ dir }) => {
  const walk = ({ current }) =>
    readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) =>
        entry.isDirectory()
          ? walk({ current: join(current, entry.name) })
          : [relative(dir, join(current, entry.name))],
      );

  return walk({ current: dir });
};

/** Assert one generated tree is byte-for-byte the reference tree. */
const assertByteIdentical = ({ label, cwd }) => {
  const expected = treeOf({ dir: REFERENCE });
  const actual = expected.filter((path) => existsSync(join(cwd, path)));

  assert({
    ok: actual.length === expected.length,
    message: `${label}: generated ${actual.length} of ${expected.length} reference files — missing ${expected
      .filter((path) => !existsSync(join(cwd, path)))
      .join(', ')}`,
  });

  for (const path of expected) {
    const want = readFileSync(join(REFERENCE, path), 'utf8');
    const got = readFileSync(join(cwd, path), 'utf8');

    assert({
      ok: want === got,
      message: `${label}: ${path} drifted from the reference captured on main`,
    });
  }
};

/** Assert a refusal wrote nothing at all — the whole point of refusing before writing. */
const assertNothingWritten = ({ label, cwd }) => {
  for (const path of ['ontology', 'orangerail.config.mjs', 'orangerail.governance.json']) {
    assert({
      ok: !existsSync(join(cwd, path)),
      message: `${label}: refusal still wrote ${path}`,
    });
  }
};

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

assert({ ok: existsSync(CLI), message: `CLI bundle missing at ${CLI} — build first` });

// ---- Phase 1 (AC-2): today's working paths do not move ----
for (const generator of ['legacy', 'none']) {
  const cwd = makeRepo({ name: `ac2-${generator}`, generator });
  const run = runInit({ cwd });

  assert({ ok: run.status === 0, message: `phase 1 (${generator}): init exited ${run.status}` });
  assertByteIdentical({ label: `phase 1 (${generator})`, cwd });
}

console.log('ONT-067 phase 1 (AC-2): prisma-client-js and no-generator output byte-identical.');

// ---- Phase 2 (AC-3): a generator with no output refuses before writing ----
const noOutput = makeRepo({ name: 'ac3-no-output', generator: 'no-output' });
const noOutputRun = runInit({ cwd: noOutput });

assert({
  ok: noOutputRun.status === 1,
  message: `phase 2: expected exit 1, got ${noOutputRun.status}`,
});
assert({
  ok: noOutputRun.stderr.includes('`output`'),
  message: 'phase 2: the refusal does not name the missing `output` field',
});
assert({
  ok: noOutputRun.stderr.includes('prisma-client-js'),
  message: 'phase 2: the refusal does not name the legacy-generator alternative',
});
assertNothingWritten({ label: 'phase 2', cwd: noOutput });

console.log('ONT-067 phase 2 (AC-3): a missing `output` refuses, exit 1, nothing written.');

// ---- Phase 3 (section 4): unresolvable and out-of-project outputs ----
for (const [generator, needle] of [
  ['env-output', 'env("PRISMA_CLIENT_OUT")'],
  ['outside-output', 'outside this project'],
]) {
  const cwd = makeRepo({ name: `edge-${generator}`, generator });
  const run = runInit({ cwd });

  assert({
    ok: run.status === 1,
    message: `phase 3 (${generator}): expected exit 1, got ${run.status}`,
  });
  assert({
    ok: run.stderr.includes(needle),
    message: `phase 3 (${generator}): the refusal does not say what it refused (${needle})`,
  });
  assertNothingWritten({ label: `phase 3 (${generator})`, cwd });
}

console.log('ONT-067 phase 3: an env() output and an out-of-project output both refuse.');

// ---- Phase 4 (AC-1): the literal `prisma init` block, against a live database ----

/**
 * The flags this Node needs to load the TypeScript the `prisma-client` generator
 * emits. Node 22.18+ strips types with none; 22.6 through 22.17 need the flag;
 * anything older cannot run the generated client at all.
 */
const stripTypesOptions = () => {
  const [major, minor] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));

  if (major === undefined || minor === undefined) {
    return undefined;
  }

  if (major > 22 || (major === 22 && minor >= 18)) {
    return '';
  }

  return major === 22 && minor >= 6 ? '--experimental-strip-types' : undefined;
};

const run = ({ cwd, command, args, env, timeout = 600_000 }) =>
  spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  });

/** A pure-Node MCP stdio session against the SHIPPED server. */
const openSession = async ({ cwd, env }) => {
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  let nextId = 1;
  let buffer = '';
  const pending = new Map();

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

  const request = ({ method, params }) => {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP request timed out: ${method}\n${stderr}`)),
        60_000,
      );
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const exited = new Promise((resolve) => child.on('exit', resolve));

  await request({
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ont-067-e2e', version: '0.0.0' },
    },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    callTool: ({ name, args }) =>
      request({ method: 'tools/call', params: { name, arguments: args } }),
    stderrText: () => stderr,
    close: async () => {
      child.stdin.end();
      child.kill('SIGTERM');
      await exited;
    },
  };
};

const live = async () => {
  const nodeOptions = stripTypesOptions();

  if (nodeOptions === undefined) {
    skip({
      message: `Node ${process.versions.node} cannot run a TypeScript module, and the \`prisma-client\` generator emits nothing else — phase 4 needs Node 22.6 or newer`,
    });
    return;
  }

  const cwd = makeRepo({ name: 'ac1-default', generator: 'default' });

  writeFileSync(
    join(cwd, 'prisma.config.ts'),
    'import { defineConfig } from "prisma/config";\n\n' +
      'export default defineConfig({\n' +
      '  schema: "prisma/schema.prisma",\n' +
      '  datasource: { url: process.env["DATABASE_URL"] },\n' +
      '});\n',
    'utf8',
  );

  const install = run({
    cwd,
    command: 'npm',
    args: [
      'install',
      '--no-audit',
      '--no-fund',
      `prisma@${PRISMA_VERSION}`,
      `@prisma/client@${PRISMA_VERSION}`,
      `@prisma/adapter-mariadb@${PRISMA_VERSION}`,
      'zod@^3.23.0',
    ],
  });

  if (install.status !== 0) {
    skip({
      message: `could not install prisma ${PRISMA_VERSION} (npm exited ${install.status}) — phase 4 needs a network install`,
    });
    return;
  }

  // The generated ontology imports orangerail-core at runtime; the workspace copy
  // is the one under test, so it is linked rather than fetched.
  const coreDir = join(cwd, 'node_modules', 'orangerail-core');
  mkdirSync(coreDir, { recursive: true });
  cpSync(join(CORE, 'dist'), join(coreDir, 'dist'), { recursive: true });
  cpSync(join(CORE, 'package.json'), join(coreDir, 'package.json'));

  const env = {
    DATABASE_URL: MYSQL_URL,
    ...(nodeOptions === '' ? {} : { NODE_OPTIONS: nodeOptions }),
  };

  const generate = run({ cwd, command: 'npx', args: ['prisma', 'generate'], env });

  assert({
    ok: generate.status === 0,
    message: `phase 4: prisma generate exited ${generate.status}\n${generate.stderr}`,
  });
  assert({
    ok: existsSync(join(cwd, 'generated', 'prisma', 'client.ts')),
    message: 'phase 4: the generator wrote no client at its declared output',
  });
  assert({
    ok: !existsSync(join(cwd, 'node_modules', '.prisma', 'client')),
    message:
      'phase 4: node_modules/.prisma/client exists, so this run is not reproducing the defect',
  });

  // The tables are created with plain DDL through the generated client rather
  // than `prisma db push`: prisma 7 gates that command behind an explicit
  // user-consent variable because it can destroy a database, and an e2e has no
  // consent to give. `CREATE TABLE IF NOT EXISTS` touches nothing it did not
  // create. It doubles as the reachability probe AND as the first proof that the
  // client at the generator's output path loads at all.
  writeFileSync(
    join(cwd, 'seed.mjs'),
    "import { PrismaClient } from './generated/prisma/client.ts';\n" +
      "import { PrismaMariaDb } from '@prisma/adapter-mariadb';\n\n" +
      'const prisma = new PrismaClient({ adapter: new PrismaMariaDb(process.env.DATABASE_URL) });\n\n' +
      'await prisma.$executeRawUnsafe(\n' +
      "  'CREATE TABLE IF NOT EXISTS Customer (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(191) NOT NULL UNIQUE, name VARCHAR(191), tier VARCHAR(32) NOT NULL DEFAULT \\'free\\')',\n" +
      ');\n' +
      'await prisma.$executeRawUnsafe(\n' +
      "  'CREATE TABLE IF NOT EXISTS Payment (id INT AUTO_INCREMENT PRIMARY KEY, customerId INT NOT NULL, amountCents INT NOT NULL, status VARCHAR(32) NOT NULL DEFAULT \\'pending\\', CONSTRAINT fk_pay_cust FOREIGN KEY (customerId) REFERENCES Customer(id))',\n" +
      ');\n\n' +
      'await prisma.payment.deleteMany({});\n' +
      'await prisma.customer.deleteMany({});\n' +
      "await prisma.customer.create({ data: { email: 'a@example.com', name: 'Ada', tier: 'pro' } });\n" +
      "await prisma.customer.create({ data: { email: 'b@example.com', name: 'Bo' } });\n" +
      "await prisma.customer.create({ data: { email: 'c@example.com', name: 'Cy' } });\n" +
      'await prisma.$disconnect();\n',
    'utf8',
  );

  const seed = run({ cwd, command: process.execPath, args: ['seed.mjs'], env });

  if (seed.status !== 0) {
    skip({
      message: `no reachable MySQL at ${MYSQL_URL} (setup exited ${seed.status}) — set ORANGERAIL_ONT067_MYSQL_URL to a database this scenario may create tables in\n${seed.stderr}`,
    });
    return;
  }

  const initRun = runInit({ cwd, env });

  assert({ ok: initRun.status === 0, message: `phase 4: init exited ${initRun.status}` });

  const customer = readFileSync(join(cwd, 'ontology', 'Customer.mjs'), 'utf8');

  assert({
    ok: customer.includes('await import("../generated/prisma/client.ts")'),
    message: 'phase 4: the emitted import does not name the generated client',
  });
  assert({
    ok: !customer.includes("await import('@prisma/client')"),
    message: 'phase 4: the emitted import still names a package that carries no client',
  });

  const session = await openSession({ cwd, env });

  try {
    const result = await session.callTool({ name: 'Customer_list', args: {} });

    assert({
      ok: result?.structuredContent?.status === 'ok',
      message: `phase 4: Customer_list did not succeed — ${JSON.stringify(result)}\n${session.stderrText()}`,
    });
    assert({
      ok: (result?.structuredContent?.items ?? []).length === 3,
      message: `phase 4: expected the 3 seeded rows, got ${JSON.stringify(result?.structuredContent?.items)}`,
    });
  } finally {
    await session.close();
  }

  console.log('ONT-067 phase 4 (AC-1): the Prisma 7 default generator reads rows end to end.');
};

await live();

rmSync(WORK, { recursive: true, force: true });

if (skipped > 0) {
  console.log(`ONT-067 e2e: ${skipped} capability-gated phase(s) SKIPPED (see notices above).`);
}

console.log('ONT-067 e2e: all assertions passed.');
