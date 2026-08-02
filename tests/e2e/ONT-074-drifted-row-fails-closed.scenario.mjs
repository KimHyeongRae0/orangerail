/**
 * ONT-074 e2e driver — a row that drifts from its declared schema closes the
 * gate instead of opening it (ticket section 5).
 *
 * `defineObject` stores `schema` and never parses `resolve` output with it
 * (`packages/core/src/define/object.ts:31-38`), so `evaluateWhere` read a
 * property off a row nobody had checked. When the declared field is absent that
 * read is `undefined`, and `undefined !== 'soldout'` is `true` — the clause
 * written to STOP the action permitted it, under a gate whose own doc comment
 * says it fails closed.
 *
 * Everything below runs against a REAL generated Prisma ontology over a LIVE
 * database, twice: PostgreSQL and MySQL. Hand-built fixtures cannot answer the
 * question this ticket actually risks, which is whether the check refuses rows
 * that work today — a Prisma row carries a `Date`, a `Decimal` and a `BigInt`
 * where the generated schema declares three strings, and a check taken at the
 * wrong place would mark or refuse every one of them.
 *
 *   Phase 1 (AC-7): the untouched project. `Product_get` serves every column
 *     unmarked — the `Decimal` as `"19.99"`, the `BigInt` as its decimal string,
 *     the `DateTime` as an ISO string — and the gated action stages, is approved
 *     and executes. A row carrying all three passes the gate end to end.
 *   Phase 2 (AC-3): `note` is removed from the Prisma schema and the client is
 *     regenerated, so the resolver stops selecting it and the row no longer
 *     carries a field the ontology declares required. The clause reads `status`,
 *     so the action still stages — and the read marks `note` while still
 *     succeeding (AC-5).
 *   Phase 3 (AC-1, AC-4, AC-5): `status` goes the same way. The gated action is
 *     REFUSED with `target_nonconforming` naming the field, the read of the same
 *     row still succeeds with `status` marked, and the audit chain carries the
 *     refusal and verifies.
 *
 * The drift is produced the way a project produces it: a migration the ontology
 * did not follow. `ontology/Product.mjs` is written once by `init` and is never
 * re-scanned, so removing the column from `prisma/schema.prisma` and running
 * `prisma generate` again leaves the declaration and the datasource disagreeing
 * — which is the whole defect, staged live rather than mocked.
 *
 * The gated action is hand-written into `ontology/` after `init`, because the
 * scanner emits no `where` clause of its own (`emit-action.ts:290`) and the
 * config self-discovers every `ontology/*.mjs`. A governed action over a
 * generated object is the product's own documented shape.
 *
 * Both live runs are capability-gated (DEV-01): an unreachable database or a
 * failed network install is a LOUD skip, never a silent pass. Point them at
 * servers they may create their own database on with
 * ORANGERAIL_ONT074_POSTGRES_URL / ORANGERAIL_ONT074_MYSQL_URL; only the
 * database named in each URL and the one table below are touched.
 *
 * Everything runs OUTSIDE the repo, under os.tmpdir(): the Prisma-major probe
 * walks upward for `node_modules/@prisma/client`, so a scratch dir inside the
 * monorepo would read the monorepo's Prisma 6 whatever the phase planted.
 *
 * RED (against 062e527, live PostgreSQL 16.14): phase 1 passes — it is the
 * control. Phase 2 fails first, on the read: `note` is served unmarked, as
 *
 *   {"id":1,"title":"Widget","status":"active","price":"19.99",
 *    "serial":"9007199254740993","createdAt":"2026-08-02T00:00:00.000Z"}
 *
 * — the declared field simply absent. With that one assertion relaxed the run
 * reaches phase 3 and fails there on the defect itself: `the gate answered
 * approval_pending for a row missing the field its clause reads`, complete with
 * a minted approvalId.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const CORE = join(ROOT, 'packages', 'core');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-074');

// process.pid keeps concurrent runs isolated without Date.now/random.
const WORK = join(tmpdir(), `orangerail-ont-074-${process.pid}`);

const INIT_ARGS = ['init', '--yes', '--no-studio', '--no-docs'];

/** The prisma line-up this ticket was verified against, pinned so a rerun is the same run. */
const PRISMA_VERSION = '7.9.1';

const DB_NAME = 'orangerail_ont074_e2e';

/**
 * A Homebrew PostgreSQL creates a superuser named after the OS user and no
 * `postgres` role at all, which is the machine this ticket was measured on.
 */
const POSTGRES_URL =
  process.env['ORANGERAIL_ONT074_POSTGRES_URL'] ??
  `postgresql://${process.env['USER'] ?? 'postgres'}@127.0.0.1:5432/${DB_NAME}`;

const MYSQL_URL =
  process.env['ORANGERAIL_ONT074_MYSQL_URL'] ?? `mysql://root@127.0.0.1:3306/${DB_NAME}`;

/** A BigInt past 2^53, so a run that rounded it would be visible rather than plausible. */
const SERIAL = '9007199254740993';

const CREATED_AT = '2026-08-02T00:00:00.000Z';

const PRICE = '19.99';

let skipped = 0;

const fail = ({ message }) => {
  console.error(`ONT-074 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const skip = ({ message }) => {
  skipped += 1;
  console.error(`\n>>> ONT-074 e2e SKIP: ${message}\n`);
};

const run = ({ cwd, command, args, env, timeout = 600_000 }) =>
  spawnSync(command, args, { cwd, encoding: 'utf8', timeout, env: { ...process.env, ...env } });

const runCli = ({ cwd, args, env }) => {
  const res = run({ cwd, command: process.execPath, args: [CLI, ...args], env, timeout: 300_000 });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
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
      clientInfo: { name: 'ont-074-e2e', version: '0.0.0' },
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

const structured = ({ result }) => result?.structuredContent ?? {};

/** The text a tool result actually shows an agent, which is what a failure has to quote. */
const textOf = ({ result }) => result?.content?.[0]?.text ?? '';

/** The one governed action in this project — hand-written, because `init` emits no `where`. */
const GATED_ACTION = [
  '/**',
  ' * ONT-074 e2e — a governed action over the GENERATED object, gated on a column',
  ' * the generated schema declares. `init` emits no `where` clause of its own, and',
  ' * the config self-discovers every `ontology/*.mjs`, so this is the documented',
  ' * way a project adds one.',
  ' */',
  "import { z } from 'zod';",
  '',
  "import { registry } from './_registry.mjs';",
  "import { Product } from './Product.mjs';",
  '',
  'export const holdProduct = registry.defineAction({',
  "  name: 'holdProduct',",
  '  input: z.object({ id: z.string() }),',
  "  policy: { approval: 'required', where: { field: 'status', op: 'neq', value: 'soldout' } },",
  '  target: Product,',
  "  targetIdFrom: 'id',",
  '  execute: async ({ input }) => ({ held: input.id }),',
  '});',
  '',
].join('\n');

/** Drop one field from the fixture's Prisma schema, as a migration the ontology did not follow. */
const removeField = ({ cwd, field }) => {
  const path = join(cwd, 'prisma', 'schema.prisma');
  const kept = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !new RegExp(`^\\s{2}${field}\\s`).test(line))
    .join('\n');

  writeFileSync(path, kept, 'utf8');

  assert({
    ok: !new RegExp(`^\\s{2}${field}\\s`, 'm').test(kept),
    message: `could not remove \`${field}\` from the fixture schema`,
  });
};

/** One full live run against one database. */
const live = async ({ label, dialect, url, adapterPackage, adapterClass, ddl, serverUrl }) => {
  const cwd = join(WORK, label);

  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(join(cwd, 'prisma'), { recursive: true });
  cpSync(join(FIXTURE, 'package.json'), join(cwd, 'package.json'));
  cpSync(join(FIXTURE, `${dialect}.prisma`), join(cwd, 'prisma', 'schema.prisma'));

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
      `${adapterPackage}@${PRISMA_VERSION}`,
      'zod@^3.23.0',
    ],
  });

  if (install.status !== 0) {
    skip({
      message: `${label}: could not install prisma ${PRISMA_VERSION} (npm exited ${install.status}) — the live phases need a network install`,
    });
    return;
  }

  // The generated ontology imports orangerail-core at runtime; the workspace copy
  // is the one under test, so it is linked rather than fetched.
  const coreDir = join(cwd, 'node_modules', 'orangerail-core');
  mkdirSync(coreDir, { recursive: true });
  cpSync(join(CORE, 'dist'), join(coreDir, 'dist'), { recursive: true });
  cpSync(join(CORE, 'package.json'), join(coreDir, 'package.json'));

  const env = { DATABASE_URL: url };
  const generate = () => run({ cwd, command: 'npx', args: ['prisma', 'generate'], env });
  const generated = generate();

  assert({
    ok: generated.status === 0,
    message: `${label}: prisma generate exited ${generated.status}\n${generated.stderr}`,
  });

  // The database and the one table are created with plain DDL through the
  // generated client rather than `prisma db push`: Prisma 7 gates that command
  // behind an explicit user-consent variable because it can destroy a database,
  // and an e2e has no consent to give. It doubles as the reachability probe.
  writeFileSync(
    join(cwd, 'seed.mjs'),
    "import { PrismaClient } from '@prisma/client';\n" +
      `import { ${adapterClass} } from '${adapterPackage}';\n\n` +
      `const server = new PrismaClient({ adapter: new ${adapterClass}(${JSON.stringify(serverUrl)}) });\n` +
      `for (const statement of ${JSON.stringify(ddl.server, null, 2)}) {\n` +
      '  await server.$executeRawUnsafe(statement);\n' +
      '}\n' +
      'await server.$disconnect();\n\n' +
      `const prisma = new PrismaClient({ adapter: new ${adapterClass}(process.env.DATABASE_URL) });\n` +
      `for (const statement of ${JSON.stringify(ddl.database, null, 2)}) {\n` +
      '  await prisma.$executeRawUnsafe(statement);\n' +
      '}\n' +
      'await prisma.$disconnect();\n',
    'utf8',
  );

  const seed = run({ cwd, command: process.execPath, args: ['seed.mjs'], env });

  if (seed.status !== 0) {
    skip({
      message: `${label}: no reachable database at ${url} (setup exited ${seed.status}) — set the URL env var for this dialect to a server this scenario may create ${DB_NAME} on\n${seed.stderr}`,
    });
    return;
  }

  const initRun = runCli({ cwd, args: INIT_ARGS, env });

  assert({
    ok: initRun.status === 0,
    message: `${label}: init exited ${initRun.status}\n${initRun.stdout}${initRun.stderr}`,
  });

  const declared = readFileSync(join(cwd, 'ontology', 'Product.mjs'), 'utf8');

  assert({
    ok: declared.includes('"status": z.string()') && declared.includes('"note": z.string()'),
    message: `${label}: the generated ontology does not declare status/note as required strings — the drift below would measure nothing\n${declared}`,
  });

  writeFileSync(join(cwd, 'ontology', 'holdProduct.mjs'), GATED_ACTION, 'utf8');

  // ---- Phase 1 (AC-7): the untouched project ----
  const first = await openSession({ cwd, env });

  try {
    const read = await first.callTool({ name: 'Product_get', args: { id: '1' } });

    assert({
      ok: structured({ result: read }).status === 'ok',
      message: `${label} phase 1 (AC-7): the read answered ${textOf({ result: read })}`,
    });
    assert({
      ok: !textOf({ result: read }).includes('<UNRENDERABLE'),
      message: `${label} phase 1 (AC-7): a conforming Prisma row was marked — ${textOf({ result: read })}`,
    });

    const row = structured({ result: read }).object ?? {};

    assert({
      ok: row.price === PRICE,
      message: `${label} phase 1 (AC-7): the Decimal column arrived as ${JSON.stringify(row.price)}`,
    });
    assert({
      ok: row.serial === SERIAL,
      message: `${label} phase 1 (AC-7): the BigInt column arrived as ${JSON.stringify(row.serial)}`,
    });
    assert({
      ok: String(row.createdAt).startsWith('2026-08-02T00:00:00'),
      message: `${label} phase 1 (AC-7): the DateTime column arrived as ${JSON.stringify(row.createdAt)}`,
    });

    const staged = await first.callTool({ name: 'holdProduct', args: { id: '1' } });

    assert({
      ok: structured({ result: staged }).status === 'approval_pending',
      message: `${label} phase 1 (AC-7): the gated action over a Date/Decimal/BigInt row answered ${textOf({ result: staged })}\n${first.stderrText()}`,
    });

    const approvalId = structured({ result: staged }).approvalId;
    const approve = runCli({ cwd, args: ['approvals', 'approve', approvalId, '--yes'], env });

    assert({
      ok: approve.status === 0,
      message: `${label} phase 1 (AC-7): approving ${approvalId} exited ${approve.status}\n${approve.stdout}${approve.stderr}`,
    });

    const executed = await first.callTool({ name: 'check_approval', args: { approvalId } });

    assert({
      ok: structured({ result: executed }).status === 'executed',
      message: `${label} phase 1 (AC-7): the approved action answered ${textOf({ result: executed })}\n${first.stderrText()}`,
    });

    console.log(
      `ONT-074 ${label} phase 1 (AC-7): a real Prisma row carrying a Date, a Decimal and a BigInt reads unmarked, stages, and executes.`,
    );
  } finally {
    await first.close();
  }

  // ---- Phase 2 (AC-3): a column the clause does not read goes away ----
  removeField({ cwd, field: 'note' });

  const regenerated = generate();

  assert({
    ok: regenerated.status === 0,
    message: `${label} phase 2 (AC-3): prisma generate exited ${regenerated.status}\n${regenerated.stderr}`,
  });

  const second = await openSession({ cwd, env });

  try {
    const staged = await second.callTool({ name: 'holdProduct', args: { id: '1' } });

    assert({
      ok: structured({ result: staged }).status === 'approval_pending',
      message: `${label} phase 2 (AC-3): a row drifted in a field the clause never reads was refused — ${textOf({ result: staged })}\n${second.stderrText()}`,
    });

    const read = await second.callTool({ name: 'Product_get', args: { id: '1' } });

    assert({
      ok: structured({ result: read }).status === 'ok',
      message: `${label} phase 2 (AC-5): the read of a drifted row failed — ${textOf({ result: read })}`,
    });
    assert({
      ok: String(structured({ result: read }).object?.note ?? '').includes('<UNRENDERABLE'),
      message: `${label} phase 2 (AC-5): the missing \`note\` was served unmarked — ${textOf({ result: read })}`,
    });

    console.log(
      `ONT-074 ${label} phase 2 (AC-3): a row missing \`note\` still stages, and the read marks the field it is missing.`,
    );
  } finally {
    await second.close();
  }

  // ---- Phase 3 (AC-1, AC-4, AC-5): the column the clause reads goes away ----
  removeField({ cwd, field: 'status' });

  const regeneratedAgain = generate();

  assert({
    ok: regeneratedAgain.status === 0,
    message: `${label} phase 3: prisma generate exited ${regeneratedAgain.status}\n${regeneratedAgain.stderr}`,
  });

  const third = await openSession({ cwd, env });

  try {
    const staged = await third.callTool({ name: 'holdProduct', args: { id: '1' } });
    const answer = structured({ result: staged });

    assert({
      ok: answer.status === 'target_nonconforming',
      message: `${label} phase 3 (AC-1): the gate answered ${answer.status} for a row missing the field its clause reads — ${textOf({ result: staged })}\n${third.stderrText()}`,
    });
    assert({
      ok: answer.field === 'status',
      message: `${label} phase 3 (AC-4): the refusal names ${JSON.stringify(answer.field)} rather than the field the clause reads`,
    });
    assert({
      ok: staged?.isError === true && textOf({ result: staged }).includes('"status"'),
      message: `${label} phase 3 (AC-4): the agent-facing text does not name the field — ${textOf({ result: staged })}`,
    });
    assert({
      ok: answer.reason === undefined,
      message: `${label} phase 3 (AC-4): the operator-facing reason was forwarded to the agent — ${JSON.stringify(answer)}`,
    });
    assert({
      ok: answer.approvalId === undefined,
      message: `${label} phase 3 (AC-1): the refused action still produced an approval ${answer.approvalId}`,
    });

    const read = await third.callTool({ name: 'Product_get', args: { id: '1' } });

    assert({
      ok: structured({ result: read }).status === 'ok',
      message: `${label} phase 3 (AC-5): the read of the same row failed — ${textOf({ result: read })}`,
    });
    assert({
      ok: String(structured({ result: read }).object?.status ?? '').includes('<UNRENDERABLE'),
      message: `${label} phase 3 (AC-5): the missing \`status\` was served unmarked — ${textOf({ result: read })}`,
    });

    console.log(
      `ONT-074 ${label} phase 3 (AC-1/AC-4/AC-5): the gate refuses and names \`status\`, and the read of the same row still answers with it marked.`,
    );
  } finally {
    await third.close();
  }

  const chain = readFileSync(join(cwd, '.orangerail', 'store', 'audit.jsonl'), 'utf8');

  assert({
    ok: chain.includes('"phase":"target_nonconforming"'),
    message: `${label} phase 3 (AC-4): the refusal is not on the audit chain`,
  });
  assert({
    ok: chain.includes('not what Product declares'),
    message: `${label} phase 3 (AC-4): the audit record does not carry the operator-facing reason`,
  });

  const verify = runCli({ cwd, args: ['audit', 'verify'], env });

  assert({
    ok: verify.status === 0,
    message: `${label} phase 3: audit verify exited ${verify.status}\n${verify.stdout}${verify.stderr}`,
  });

  console.log(`ONT-074 ${label}: audit chain verifies with the refusal recorded on it.`);
};

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

assert({ ok: existsSync(CLI), message: `CLI bundle missing at ${CLI} — build first` });

/** The connection a `CREATE DATABASE` is issued from, since the target may not exist yet. */
const bootstrap = ({ url, database }) => {
  const server = new URL(url);
  server.pathname = `/${database}`;

  return server.toString();
};

const ROW = {
  title: 'Widget',
  status: 'active',
  note: 'seeded',
};

await live({
  label: 'postgres',
  dialect: 'postgres',
  url: POSTGRES_URL,
  adapterPackage: '@prisma/adapter-pg',
  adapterClass: 'PrismaPg',
  serverUrl: bootstrap({ url: POSTGRES_URL, database: 'postgres' }),
  ddl: {
    // PostgreSQL has no `CREATE DATABASE IF NOT EXISTS`, and the statement
    // cannot run inside a transaction — so it is issued on its own and a second
    // run is allowed to find it already there.
    server: [`DROP DATABASE IF EXISTS ${DB_NAME}`, `CREATE DATABASE ${DB_NAME}`],
    database: [
      'DROP TABLE IF EXISTS "Product"',
      'CREATE TABLE "Product" (id SERIAL PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, price NUMERIC(10,2) NOT NULL, serial BIGINT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL)',
      `INSERT INTO "Product" (id, title, status, note, price, serial, "createdAt") VALUES (1, '${ROW.title}', '${ROW.status}', '${ROW.note}', ${PRICE}, ${SERIAL}, '${CREATED_AT}')`,
    ],
  },
});

await live({
  label: 'mysql',
  dialect: 'mysql',
  url: MYSQL_URL,
  adapterPackage: '@prisma/adapter-mariadb',
  adapterClass: 'PrismaMariaDb',
  serverUrl: bootstrap({ url: MYSQL_URL, database: 'information_schema' }),
  ddl: {
    server: [`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``],
    database: [
      'DROP TABLE IF EXISTS Product',
      'CREATE TABLE Product (id INT NOT NULL AUTO_INCREMENT, title VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, note VARCHAR(64) NOT NULL, price DECIMAL(10,2) NOT NULL, serial BIGINT NOT NULL, createdAt DATETIME(3) NOT NULL, PRIMARY KEY (id))',
      `INSERT INTO Product (id, title, status, note, price, serial, createdAt) VALUES (1, '${ROW.title}', '${ROW.status}', '${ROW.note}', ${PRICE}, ${SERIAL}, '2026-08-02 00:00:00.000')`,
    ],
  },
});

if (skipped > 0) {
  console.error(`\nONT-074 e2e: ${skipped} live phase(s) SKIPPED — see the reasons above.\n`);
}

console.log('ONT-074 e2e: PASS');
