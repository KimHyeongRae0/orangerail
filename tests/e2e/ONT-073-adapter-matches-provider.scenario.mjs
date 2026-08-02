/**
 * ONT-073 e2e driver — the driver adapter is the one the schema's `datasource`
 * provider names, not the first one installed (ticket section 5).
 *
 * `@prisma/adapter-pg` heads `SUPPORTED_ADAPTERS` and the selection took the
 * first entry the repo carried, so a schema declaring `provider = "mysql"` in a
 * repo that also had the PostgreSQL adapter installed got
 * `new PrismaPg(url)` emitted against a MySQL connection string — under a full
 * green `init` summary and exit 0. A monorepo serving two databases, and a
 * project that migrated to MySQL without uninstalling the old adapter, both
 * produce that repo.
 *
 *   Phase 1 (AC-2, offline): the MySQL schema with ONLY `@prisma/adapter-pg`
 *     present refuses before writing a byte — exit 1, no `ontology/`, no config,
 *     no `orangerail.governance.json` — naming the provider it scanned and the
 *     one `npm install` that fixes it. Having another database's adapter on disk
 *     does not become permission to use it.
 *   Phase 2 (AC-4, offline): a schema declaring NO provider emits output
 *     BYTE-IDENTICAL to a reference captured on the merge base — every generated
 *     file compared in full. Install order still answers there, because nothing
 *     better is available.
 *   Phase 3 (AC-5, offline): the MySQL schema in a single-adapter repo whose
 *     provider matches is byte-identical to its own merge-base reference. The
 *     repos that were already right do not move.
 *   Phase 4 (AC-1, AC-3, live): a REAL prisma 7.9.1 install carrying BOTH
 *     adapters against a REAL MySQL. The emitted construction is
 *     `new PrismaMariaDb(url)`, the closing summary names that class and the
 *     `mysql` provider it was chosen for, and the shipped MCP server reads the
 *     seeded rows back out of the database — which `PrismaPg` over a MySQL URL
 *     cannot do.
 *
 * Phase 4 needs a reachable MySQL and a network install, so it is
 * capability-gated (DEV-01): unavailable means a LOUD skip, never a silent pass.
 * Point it at a server it may create its own database on with
 * ORANGERAIL_ONT073_MYSQL_URL; it defaults to a local root connection. Only the
 * database named in that URL and the two tables below are touched.
 *
 * `prisma-client-js` is the fixture's generator on purpose: Prisma 7's default
 * `prisma-client` emits TypeScript needing Node >= 22.18, which is ONT-067's
 * subject and would gate this scenario on something it is not measuring.
 *
 * Everything runs OUTSIDE the repo, under os.tmpdir(): the Prisma-major probe
 * walks upward for `node_modules/@prisma/client`, so a scratch dir inside the
 * monorepo would read the monorepo's Prisma 6 whatever the phase planted.
 *
 * RED (against 3c943f0, the merge base): phases 2 and 3 pass — they are the
 * controls. Phase 1 fails by exiting 0 and generating a full ontology through
 * `PrismaPg`, and phase 4 fails on the emitted class, which is the defect
 * exactly as reported.
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
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-073');
const REFERENCE = join(FIXTURE, 'reference');

// process.pid keeps concurrent runs isolated without Date.now/random.
const WORK = join(tmpdir(), `orangerail-ont-073-${process.pid}`);

const INIT_ARGS = ['init', '--yes', '--no-studio', '--no-docs'];

/** The prisma line-up this ticket was verified against, pinned so a rerun is the same run. */
const PRISMA_VERSION = '7.9.1';

const MYSQL_URL =
  process.env['ORANGERAIL_ONT073_MYSQL_URL'] ?? 'mysql://root@127.0.0.1:3306/orangerail_ont073_e2e';

let skipped = 0;

const fail = ({ message }) => {
  console.error(`ONT-073 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const skip = ({ message }) => {
  skipped += 1;
  console.error(`\n>>> ONT-073 e2e SKIP: ${message}\n`);
};

/** A fresh fixture repo carrying one of the two schemas under test. */
const makeRepo = ({ name, schema }) => {
  const dir = join(WORK, name);

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'prisma'), { recursive: true });

  cpSync(join(FIXTURE, 'package.json'), join(dir, 'package.json'));
  cpSync(join(FIXTURE, `${schema}.prisma`), join(dir, 'prisma', 'schema.prisma'));

  return dir;
};

/**
 * Plant a package manifest where the adapter probe will read it. The probe reads
 * `version` and nothing else, so the offline phases cost no install — what those
 * manifests stand in for is installed for real in phase 4.
 */
const plant = ({ cwd, pkg }) => {
  const dir = join(cwd, 'node_modules', ...pkg.split('/'));

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: pkg, version: PRISMA_VERSION }),
    'utf8',
  );
};

const run = ({ cwd, command, args, env, timeout = 600_000 }) =>
  spawnSync(command, args, { cwd, encoding: 'utf8', timeout, env: { ...process.env, ...env } });

const runCli = ({ cwd, args, env }) => {
  const res = run({ cwd, command: process.execPath, args: [CLI, ...args], env, timeout: 300_000 });

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
const assertByteIdentical = ({ label, cwd, reference }) => {
  const expected = treeOf({ dir: reference });
  const missing = expected.filter((path) => !existsSync(join(cwd, path)));

  assert({
    ok: missing.length === 0,
    message: `${label}: ${missing.length} of ${expected.length} reference files were not generated — ${missing.join(', ')}`,
  });

  for (const path of expected) {
    assert({
      ok: readFileSync(join(reference, path), 'utf8') === readFileSync(join(cwd, path), 'utf8'),
      message: `${label}: ${path} drifted from the reference captured on the merge base`,
    });
  }
};

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
      clientInfo: { name: 'ont-073-e2e', version: '0.0.0' },
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

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

assert({ ok: existsSync(CLI), message: `CLI bundle missing at ${CLI} — build first` });

// ---- Phase 1 (AC-2): the wrong adapter present is not permission to use it ----
const refused = makeRepo({ name: 'ac2-wrong-adapter', schema: 'mysql' });
plant({ cwd: refused, pkg: '@prisma/client' });
plant({ cwd: refused, pkg: '@prisma/adapter-pg' });

const refusedRun = runCli({ cwd: refused, args: INIT_ARGS });

assert({
  ok: refusedRun.status === 1,
  message: `phase 1 (AC-2): expected exit 1, got ${refusedRun.status}\n${refusedRun.stdout}`,
});
assert({
  ok: refusedRun.stderr.includes('Your datasource provider is `mysql`'),
  message: `phase 1 (AC-2): the refusal does not narrow to the scanned provider\n${refusedRun.stderr}`,
});
assert({
  ok: refusedRun.stderr.includes('npm install @prisma/adapter-mariadb'),
  message: `phase 1 (AC-2): the refusal does not name the adapter to install\n${refusedRun.stderr}`,
});
assert({
  ok: !refusedRun.stderr.includes('npm install @prisma/adapter-pg'),
  message: 'phase 1 (AC-2): the refusal offers the adapter that is already installed',
});
assert({
  ok: refusedRun.stdout === '',
  message: `phase 1 (AC-2): a refusal wrote to stdout — ${JSON.stringify(refusedRun.stdout)}`,
});

for (const path of ['ontology', 'orangerail.config.mjs', 'orangerail.governance.json']) {
  assert({
    ok: !existsSync(join(refused, path)),
    message: `phase 1 (AC-2): the refusal still wrote ${path}`,
  });
}

console.log(
  'ONT-073 phase 1 (AC-2): a MySQL schema with only the pg adapter refuses, writing nothing.',
);

// ---- Phase 2 (AC-4): no declared provider keeps install order, byte for byte ----
const noProvider = makeRepo({ name: 'ac4-no-provider', schema: 'no-provider' });
plant({ cwd: noProvider, pkg: '@prisma/client' });
plant({ cwd: noProvider, pkg: '@prisma/adapter-pg' });
plant({ cwd: noProvider, pkg: '@prisma/adapter-mariadb' });

const noProviderRun = runCli({ cwd: noProvider, args: INIT_ARGS });

assert({
  ok: noProviderRun.status === 0,
  message: `phase 2 (AC-4): init exited ${noProviderRun.status}\n${noProviderRun.stderr}`,
});
assertByteIdentical({
  label: 'phase 2 (AC-4)',
  cwd: noProvider,
  reference: join(REFERENCE, 'no-provider'),
});

// Stated as well as compared: the reference is only worth what it captures, and
// what it captures is the table-order answer over two installed adapters.
assert({
  ok: readFileSync(join(noProvider, 'ontology', 'Shop.mjs'), 'utf8').includes(
    'new PrismaClient({ adapter: new PrismaPg(url) })',
  ),
  message: 'phase 2 (AC-4): the no-provider path stopped taking the first adapter in the table',
});

console.log('ONT-073 phase 2 (AC-4): a schema with no provider emits byte-identical output.');

// ---- Phase 3 (AC-5): a repo that was already right does not move ----
const matched = makeRepo({ name: 'ac5-single-adapter', schema: 'mysql' });
plant({ cwd: matched, pkg: '@prisma/client' });
plant({ cwd: matched, pkg: '@prisma/adapter-mariadb' });

const matchedRun = runCli({ cwd: matched, args: INIT_ARGS });

assert({
  ok: matchedRun.status === 0,
  message: `phase 3 (AC-5): init exited ${matchedRun.status}\n${matchedRun.stderr}`,
});
assertByteIdentical({
  label: 'phase 3 (AC-5)',
  cwd: matched,
  reference: join(REFERENCE, 'matched'),
});

console.log('ONT-073 phase 3 (AC-5): a single-adapter repo whose provider matches is unchanged.');

// ---- Phase 4 (AC-1, AC-3): the live surface ----

/** The database this scenario provisions for itself, and the two tables it owns. */
const target = new URL(MYSQL_URL);
const DB_NAME = target.pathname.replace(/^\//, '');

/**
 * The same server, reached through `information_schema`, which is where the
 * `CREATE DATABASE` below runs from. The adapter refuses a connection string
 * carrying no database at all, and the database this scenario owns does not
 * exist yet on a first run — so the bootstrap connection is made to the one
 * catalog every MySQL has and nothing writes to.
 */
const SERVER_URL = (() => {
  const server = new URL(MYSQL_URL);
  server.pathname = '/information_schema';

  return server.toString();
})();

const DDL = [
  `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``,
  `DROP TABLE IF EXISTS \`${DB_NAME}\`.Sale`,
  `DROP TABLE IF EXISTS \`${DB_NAME}\`.Shop`,
  `CREATE TABLE \`${DB_NAME}\`.Shop (id INT NOT NULL AUTO_INCREMENT, slug VARCHAR(64) NOT NULL, name VARCHAR(64) NOT NULL, PRIMARY KEY (id), UNIQUE KEY slug (slug))`,
  `CREATE TABLE \`${DB_NAME}\`.Sale (id INT NOT NULL AUTO_INCREMENT, shopId INT NOT NULL, reference VARCHAR(64) NOT NULL, totalCents INT NOT NULL, note VARCHAR(64) NULL, PRIMARY KEY (id), KEY fk_sale_shop (shopId), CONSTRAINT fk_sale_shop FOREIGN KEY (shopId) REFERENCES \`${DB_NAME}\`.Shop(id))`,
  `INSERT INTO \`${DB_NAME}\`.Shop (id, slug, name) VALUES (1, 'north', 'North Market'), (2, 'south', 'South Market')`,
  `INSERT INTO \`${DB_NAME}\`.Sale (id, shopId, reference, totalCents, note) VALUES (1, 1, 'SALE-1', 1250, NULL), (2, 2, 'SALE-2', 990, 'gift')`,
];

const structured = ({ result }) => result?.structuredContent ?? {};

/** The text a tool result actually shows an agent, which is what a failure has to quote. */
const textOf = ({ result }) => result?.content?.[0]?.text ?? '';

const live = async () => {
  const cwd = makeRepo({ name: 'live-mysql', schema: 'mysql' });

  writeFileSync(
    join(cwd, 'prisma.config.ts'),
    'import { defineConfig } from "prisma/config";\n\n' +
      'export default defineConfig({\n' +
      '  schema: "prisma/schema.prisma",\n' +
      '  datasource: { url: process.env["DATABASE_URL"] },\n' +
      '});\n',
    'utf8',
  );

  // BOTH adapters, really installed. That is the whole point of the phase: the
  // repo genuinely carries the PostgreSQL driver, and the emitted code has to
  // reach past it because the schema says `mysql`.
  const install = run({
    cwd,
    command: 'npm',
    args: [
      'install',
      '--no-audit',
      '--no-fund',
      `prisma@${PRISMA_VERSION}`,
      `@prisma/client@${PRISMA_VERSION}`,
      `@prisma/adapter-pg@${PRISMA_VERSION}`,
      `@prisma/adapter-mariadb@${PRISMA_VERSION}`,
      'zod@^3.23.0',
    ],
  });

  if (install.status !== 0) {
    skip({
      message: `could not install prisma ${PRISMA_VERSION} (npm exited ${install.status}) — the live phase needs a network install`,
    });
    return;
  }

  assert({
    ok: existsSync(join(cwd, 'node_modules', '@prisma', 'adapter-pg')),
    message: 'phase 4 (AC-1): the PostgreSQL adapter is not installed, so the phase proves nothing',
  });

  // The generated ontology imports orangerail-core at runtime; the workspace copy
  // is the one under test, so it is linked rather than fetched.
  const coreDir = join(cwd, 'node_modules', 'orangerail-core');
  mkdirSync(coreDir, { recursive: true });
  cpSync(join(CORE, 'dist'), join(coreDir, 'dist'), { recursive: true });
  cpSync(join(CORE, 'package.json'), join(coreDir, 'package.json'));

  const env = { DATABASE_URL: MYSQL_URL };
  const generate = run({ cwd, command: 'npx', args: ['prisma', 'generate'], env });

  assert({
    ok: generate.status === 0,
    message: `phase 4 (AC-1): prisma generate exited ${generate.status}\n${generate.stderr}`,
  });

  // The database and its two tables are created with plain DDL through the
  // generated client rather than `prisma db push`: prisma 7 gates that command
  // behind an explicit user-consent variable because it can destroy a database,
  // and an e2e has no consent to give. Only the database named in the URL and
  // the two tables above are touched. It doubles as the reachability probe.
  writeFileSync(
    join(cwd, 'seed.mjs'),
    "import { PrismaClient } from '@prisma/client';\n" +
      "import { PrismaMariaDb } from '@prisma/adapter-mariadb';\n\n" +
      `const prisma = new PrismaClient({ adapter: new PrismaMariaDb(${JSON.stringify(SERVER_URL)}) });\n\n` +
      `const statements = ${JSON.stringify(DDL, null, 2)};\n\n` +
      'for (const statement of statements) {\n' +
      '  await prisma.$executeRawUnsafe(statement);\n' +
      '}\n\n' +
      'await prisma.$disconnect();\n',
    'utf8',
  );

  const seed = run({ cwd, command: process.execPath, args: ['seed.mjs'], env });

  if (seed.status !== 0) {
    skip({
      message: `no reachable MySQL at ${SERVER_URL} (setup exited ${seed.status}) — set ORANGERAIL_ONT073_MYSQL_URL to a server this scenario may create \`${DB_NAME}\` on\n${seed.stderr}`,
    });
    return;
  }

  const initRun = runCli({ cwd, args: INIT_ARGS, env });

  assert({
    ok: initRun.status === 0,
    message: `phase 4 (AC-1): init exited ${initRun.status}\n${initRun.stderr}`,
  });

  const generated = readFileSync(join(cwd, 'ontology', 'Shop.mjs'), 'utf8');

  assert({
    ok: generated.includes('new PrismaClient({ adapter: new PrismaMariaDb(url) })'),
    message: 'phase 4 (AC-1): the emitted construction is not the MySQL adapter',
  });
  assert({
    ok: !generated.includes('PrismaPg'),
    message: 'phase 4 (AC-1): the PostgreSQL adapter survived into a MySQL ontology',
  });

  // AC-3: readable in the summary, not only in the generated bytes.
  assert({
    ok: initRun.stdout.includes('driver adapter PrismaMariaDb from @prisma/adapter-mariadb'),
    message: `phase 4 (AC-3): the closing summary does not name the adapter it chose\n${initRun.stdout}`,
  });
  assert({
    ok: initRun.stdout.includes('chosen for the `mysql` provider your schema declares'),
    message: `phase 4 (AC-3): the closing summary does not name the provider it chose it for\n${initRun.stdout}`,
  });

  // The emitted class name is not the claim. The claim is that the generated
  // ontology reads this database, which `PrismaPg` over a MySQL URL cannot.
  const session = await openSession({ cwd, env });

  try {
    const shops = await session.callTool({ name: 'Shop_list', args: {} });
    const rows = structured({ result: shops }).items ?? [];

    assert({
      ok: structured({ result: shops }).status === 'ok',
      message: `phase 4 (AC-1): Shop_list did not succeed — ${textOf({ result: shops })}\n${session.stderrText()}`,
    });
    assert({
      ok: rows.length === 2 && rows.every((row) => typeof row.slug === 'string'),
      message: `phase 4 (AC-1): expected the 2 seeded shops, got ${JSON.stringify(rows)}`,
    });
    assert({
      ok: rows.some((row) => row.name === 'North Market'),
      message: `phase 4 (AC-1): the seeded row did not come back — ${JSON.stringify(rows)}`,
    });

    const sale = await session.callTool({ name: 'Sale_get', args: { id: 2 } });

    assert({
      ok: structured({ result: sale }).object?.reference === 'SALE-2',
      message: `phase 4 (AC-1): Sale_get answered ${textOf({ result: sale })}`,
    });
  } finally {
    await session.close();
  }

  // AC-6 at the doorway that re-writes generated files: `sync` resolves the
  // construction through the same call, so a project generated one way cannot be
  // re-synced another.
  const sync = runCli({ cwd, args: ['sync'], env });

  assert({
    ok: sync.status === 0 && sync.stdout.includes('in sync with your sources'),
    message: `phase 4 (AC-6): sync exited ${sync.status} on a project this emitter generated\n${sync.stdout}${sync.stderr}`,
  });

  console.log(
    'ONT-073 phase 4 (AC-1, AC-3, AC-6): PrismaMariaDb is emitted beside an installed PrismaPg, named in the summary, and reads live MySQL rows.',
  );
};

await live();

rmSync(WORK, { recursive: true, force: true });

if (skipped > 0) {
  console.log(`ONT-073 e2e: ${skipped} capability-gated phase(s) SKIPPED (see notices above).`);
}

console.log('ONT-073 e2e: all assertions passed.');
