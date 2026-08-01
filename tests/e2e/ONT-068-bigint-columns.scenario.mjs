/**
 * ONT-068 e2e driver — a `BigInt` column travels as a decimal string, end to end
 * (ticket section 5).
 *
 * A `BigInt` column of any kind took the whole model out of service. Every `_get`
 * and `_list` threw `Do not know how to serialize a BigInt` and surfaced as
 * `internal_error`; `update` and `delete` were uncallable, because no JSON value
 * satisfies `z.bigint()`; and `create` landed the row, returned `internal_error`
 * and wrote no terminal audit record, so the row existed with nothing in the
 * chain saying it had been written. One `BigInt` FOREIGN key did the same to a
 * model whose own key is an `Int`. `$table->id()` — every default Laravel
 * migration since 5.8 — is `BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY`, and
 * Rails has defaulted to bigint keys since 5.1.
 *
 *   Phase 1 (AC-6): a schema with NO `BigInt` column emits output byte-identical
 *     to a reference captured on `main` — every generated file compared in full.
 *   Phase 2 (AC-7): `orangerail sync` is green on a project the new emitter
 *     generated against a BigInt-bearing schema. The hand-patched ontology this
 *     ticket was measured with failed exactly here, forever, because `zod.ts` is
 *     the single source of truth for both the emitter and the differ.
 *   Phase 3 (AC-4): `tools/list` publishes a `BigInt` field as `{"type":"string"}`
 *     and its filter with ordering/equality operators only; `contains` is refused
 *     by the GATE, and no payload anywhere says `"integer"`.
 *   Phase 4 (AC-1, AC-3, section 4): `_list` and `_get` return the row whose id
 *     is `9007199254740993` with the id rendered as a string, `BIGINT UNSIGNED`
 *     answers at the top of its range, a malformed id takes the clean not-found
 *     path, and a cursor walk steps across 2^53 with no overlap.
 *   Phase 5 (AC-2): `update` and `delete` are callable with a decimal-string id;
 *     a gated delete reaches `approval_pending`, `approvals approve` then
 *     `check_approval` returns `executed`, the row is gone, the audit record's
 *     PRIOR carries the decimal string, and `audit verify` reports the chain OK.
 *   Phase 6 (AC-5): the `Int`-keyed model carrying a `BigInt` foreign key does
 *     all of that too.
 *
 * Phases 2 to 6 need a reachable MySQL and a network install, so they are
 * capability-gated (DEV-01): unavailable means a LOUD skip, never a silent pass.
 * Set ORANGERAIL_ONT068_MYSQL_URL to point at a database this scenario may create
 * and drop tables in; it defaults to a local root connection.
 *
 * Everything runs OUTSIDE the repo, under os.tmpdir(): the Prisma-major probe
 * walks upward for `node_modules/@prisma/client`, so a scratch dir inside the
 * monorepo would read the monorepo's Prisma 6 whatever the phase installed.
 *
 * RED (pre-implementation): phase 1 passes — that is the control. Phase 3 fails
 * next, on `updateSigned` publishing `{"type":"integer"}`, and phase 4 fails at
 * the first `_list`, which is the defect exactly as reported.
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
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-068');
const REFERENCE = join(FIXTURE, 'reference');

// process.pid keeps concurrent runs isolated without Date.now/random.
const WORK = join(tmpdir(), `orangerail-ont-068-${process.pid}`);

const INIT_ARGS = ['init', '--yes', '--no-studio', '--no-docs'];

/** The prisma line-up this ticket was verified against, pinned so a rerun is the same run. */
const PRISMA_VERSION = '7.9.1';

const MYSQL_URL =
  process.env['ORANGERAIL_ONT068_MYSQL_URL'] ?? 'mysql://root@127.0.0.1:3306/orangerail_ont068_e2e';

/** The id `JSON.parse` cannot hold: 2^53 + 1, where a JSON number silently becomes …992. */
const HUGE = '9007199254740993';

/** The row after it, so a cursor that ends on HUGE has somewhere to step to. */
const NEXT = '9007199254740995';

/** The top of a SIGNED 64-bit BigInt, which is the widest key Prisma can target. */
const SIGNED_MAX = '9223372036854775807';

/** MySQL's `BIGINT UNSIGNED` maximum — past the top of a SIGNED BigInt as well. */
const UNSIGNED_MAX = '18446744073709551615';

let skipped = 0;

const fail = ({ message }) => {
  console.error(`ONT-068 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const skip = ({ message }) => {
  skipped += 1;
  console.error(`\n>>> ONT-068 e2e SKIP: ${message}\n`);
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
const assertByteIdentical = ({ label, cwd }) => {
  const expected = treeOf({ dir: REFERENCE });
  const missing = expected.filter((path) => !existsSync(join(cwd, path)));

  assert({
    ok: missing.length === 0,
    message: `${label}: ${missing.length} of ${expected.length} reference files were not generated — ${missing.join(', ')}`,
  });

  for (const path of expected) {
    assert({
      ok: readFileSync(join(REFERENCE, path), 'utf8') === readFileSync(join(cwd, path), 'utf8'),
      message: `${label}: ${path} drifted from the reference captured on main`,
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
      clientInfo: { name: 'ont-068-e2e', version: '0.0.0' },
    },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    listTools: () => request({ method: 'tools/list', params: {} }),
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

// ---- Phase 1 (AC-6): a schema with no BigInt column does not move ----
const control = makeRepo({ name: 'ac6-no-bigint', schema: 'no-bigint' });
const controlRun = runCli({ cwd: control, args: INIT_ARGS });

assert({ ok: controlRun.status === 0, message: `phase 1: init exited ${controlRun.status}` });
assertByteIdentical({ label: 'phase 1', cwd: control });

console.log('ONT-068 phase 1 (AC-6): a BigInt-free schema emits byte-identical output.');

// ---- Phases 2-6: the live surface ----

/** The tables this scenario owns, dropped child-first so the foreign key releases. */
const DDL = [
  'DROP TABLE IF EXISTS Fk',
  'DROP TABLE IF EXISTS Signed',
  'DROP TABLE IF EXISTS `Unsigned`',
  'CREATE TABLE Signed (id BIGINT NOT NULL AUTO_INCREMENT, name VARCHAR(64) NOT NULL, PRIMARY KEY (id))',
  'CREATE TABLE `Unsigned` (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(64) NOT NULL, PRIMARY KEY (id))',
  'CREATE TABLE Fk (id INT NOT NULL AUTO_INCREMENT, signedId BIGINT NOT NULL, label VARCHAR(64) NOT NULL, PRIMARY KEY (id), KEY fk_signed (signedId), CONSTRAINT fk_signed FOREIGN KEY (signedId) REFERENCES Signed(id))',
  `INSERT INTO Signed (id, name) VALUES (1, 'signed-one'), (2, 'signed-two'), (${HUGE}, 'signed-huge'), (${NEXT}, 'signed-next')`,
  `INSERT INTO \`Unsigned\` (id, name) VALUES (1, 'unsigned-one'), (${SIGNED_MAX}, 'signed-max'), (${UNSIGNED_MAX}, 'unsigned-max')`,
  `INSERT INTO Fk (id, signedId, label) VALUES (1, 1, 'fk-one'), (2, ${HUGE}, 'fk-huge')`,
];

/** The text a tool result actually shows an agent, which is what the ticket measured. */
const textOf = ({ result }) => result?.content?.[0]?.text ?? '';

const structured = ({ result }) => result?.structuredContent ?? {};

const live = async () => {
  const cwd = makeRepo({ name: 'live-bigint', schema: 'bigint' });

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
      message: `could not install prisma ${PRISMA_VERSION} (npm exited ${install.status}) — the live phases need a network install`,
    });
    return;
  }

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
    message: `live: prisma generate exited ${generate.status}\n${generate.stderr}`,
  });

  // The tables are created with plain DDL through the generated client rather
  // than `prisma db push`: prisma 7 gates that command behind an explicit
  // user-consent variable because it can destroy a database, and an e2e has no
  // consent to give. Only the three tables this scenario names are touched. It
  // doubles as the reachability probe.
  writeFileSync(
    join(cwd, 'seed.mjs'),
    "import { PrismaClient } from '@prisma/client';\n" +
      "import { PrismaMariaDb } from '@prisma/adapter-mariadb';\n\n" +
      'const prisma = new PrismaClient({ adapter: new PrismaMariaDb(process.env.DATABASE_URL) });\n\n' +
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
      message: `no reachable MySQL at ${MYSQL_URL} (setup exited ${seed.status}) — set ORANGERAIL_ONT068_MYSQL_URL to a database this scenario may create tables in\n${seed.stderr}`,
    });
    return;
  }

  const initRun = runCli({ cwd, args: INIT_ARGS, env });

  assert({ ok: initRun.status === 0, message: `live: init exited ${initRun.status}` });

  // ---- Phase 2 (AC-7) ----
  const sync = runCli({ cwd, args: ['sync'], env });

  assert({
    ok: sync.status === 0,
    message: `phase 2 (AC-7): sync exited ${sync.status} on a project this emitter generated\n${sync.stdout}${sync.stderr}`,
  });
  assert({
    ok: sync.stdout.includes('in sync with your sources'),
    message: `phase 2 (AC-7): sync reported drift\n${sync.stdout}`,
  });

  console.log('ONT-068 phase 2 (AC-7): sync is green on a BigInt-bearing schema.');

  const session = await openSession({ cwd, env });
  let approvalId;
  let fkApprovalId;

  try {
    // ---- Phase 3 (AC-4) ----
    const tools = await session.listTools();
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    const listSchema = byName.get('Signed_list')?.inputSchema;
    const idFilter = listSchema?.properties?.filter?.properties?.id;

    assert({
      ok: !JSON.stringify(tools).includes('"integer"'),
      message: 'phase 3 (AC-4): tools/list still advertises an integer somewhere',
    });
    assert({
      ok: byName.get('updateSigned')?.inputSchema?.properties?.id?.type === 'string',
      message: `phase 3 (AC-4): updateSigned publishes ${JSON.stringify(byName.get('updateSigned')?.inputSchema?.properties?.id)} for a BigInt key`,
    });
    assert({
      ok: idFilter?.anyOf?.[0]?.type === 'string',
      message: `phase 3 (AC-4): the filter leaf for a BigInt column is ${JSON.stringify(idFilter?.anyOf?.[0])}`,
    });
    assert({
      ok: idFilter?.anyOf?.[1]?.$ref === '#/$defs/bigintOperators',
      message: 'phase 3 (AC-4): the BigInt column does not reference its own operator set',
    });

    const operators = Object.keys(listSchema?.$defs?.bigintOperators?.properties ?? {});

    assert({
      ok:
        JSON.stringify(operators) ===
        JSON.stringify(['equals', 'gt', 'gte', 'in', 'lt', 'lte', 'not']),
      message: `phase 3 (AC-4): the published BigInt operators are ${JSON.stringify(operators)}`,
    });

    const refusedFilter = await session.callTool({
      name: 'Signed_list',
      args: { filter: { id: { contains: '900' } } },
    });

    assert({
      ok: structured({ result: refusedFilter }).status === 'invalid_input',
      message: `phase 3 (AC-4): \`contains\` was not refused by the gate — ${textOf({ result: refusedFilter })}`,
    });
    assert({
      ok: textOf({ result: refusedFilter }).includes('is not a supported operator'),
      message: `phase 3 (AC-4): the refusal does not name the operator — ${textOf({ result: refusedFilter })}`,
    });

    console.log(
      'ONT-068 phase 3 (AC-4): a BigInt publishes as a string, and contains is gated out.',
    );

    // ---- Phase 4 (AC-1, AC-3, section 4) ----
    const listed = await session.callTool({ name: 'Signed_list', args: {} });
    const items = structured({ result: listed }).items ?? [];

    assert({
      ok: structured({ result: listed }).status === 'ok',
      message: `phase 4 (AC-1): Signed_list did not succeed — ${textOf({ result: listed })}\n${session.stderrText()}`,
    });
    assert({
      ok: items.length === 4 && items.every((row) => typeof row.id === 'string'),
      message: `phase 4 (AC-1): expected 4 rows with string ids, got ${JSON.stringify(items)}`,
    });
    assert({
      ok: items.some((row) => row.id === HUGE),
      message: `phase 4 (AC-1): the row above 2^53 is missing from the listing — ${JSON.stringify(items)}`,
    });

    const got = await session.callTool({ name: 'Signed_get', args: { id: HUGE } });

    assert({
      ok: structured({ result: got }).object?.id === HUGE,
      message: `phase 4 (AC-1): Signed_get returned ${textOf({ result: got })}`,
    });
    assert({
      ok: structured({ result: got }).object?.name === 'signed-huge',
      message: 'phase 4 (AC-1): Signed_get returned the wrong row for an id above 2^53',
    });

    // `BIGINT UNSIGNED` runs to 2^64-1 and Prisma's `BigInt` scalar is SIGNED
    // 64-bit, so the two ranges do not coincide. A row past 2^63-1 is READ back
    // with every digit intact — which is the property this ticket delivers — and
    // cannot be TARGETED by key, because Prisma refuses the argument before any
    // query is built ("number too large to fit in target type"). That boundary
    // is Prisma's, and the transport's job at it is to refuse cleanly and
    // quotably rather than to guess a different row.
    const unsignedListed = await session.callTool({ name: 'Unsigned_list', args: {} });
    const unsignedRows = structured({ result: unsignedListed }).items ?? [];

    assert({
      ok: unsignedRows.some((row) => row.id === UNSIGNED_MAX),
      message: `phase 4 (section 4): BIGINT UNSIGNED at the top of its range listed as ${JSON.stringify(unsignedRows)}`,
    });

    const unsignedTop = await session.callTool({ name: 'Unsigned_get', args: { id: SIGNED_MAX } });

    assert({
      ok: structured({ result: unsignedTop }).object?.id === SIGNED_MAX,
      message: `phase 4 (section 4): the widest targetable key returned ${textOf({ result: unsignedTop })}`,
    });

    const beyondSigned = await session.callTool({
      name: 'Unsigned_get',
      args: { id: UNSIGNED_MAX },
    });

    assert({
      ok: structured({ result: beyondSigned }).status === 'resolve_error',
      message: `phase 4 (section 4): an id past Prisma's signed range answered ${JSON.stringify(structured({ result: beyondSigned }))}`,
    });
    assert({
      ok: typeof structured({ result: beyondSigned }).correlationId === 'string',
      message:
        'phase 4 (section 4): the refusal past 2^63-1 carries no correlationId for an operator to quote',
    });

    // A hostile or malformed id takes the ordinary not-found path — never
    // `Cannot convert not-a-number to a BigInt` under an opaque resolve_error.
    for (const id of ['not-a-number', '', '1.5', '0x10', ' 1', '../etc/passwd']) {
      const missing = await session.callTool({ name: 'Signed_get', args: { id } });

      assert({
        ok: structured({ result: missing }).status === 'not_found',
        message: `phase 4 (section 4): id ${JSON.stringify(id)} answered ${textOf({ result: missing })}`,
      });
    }

    // A negative id and "-0" are well-formed and simply name no row.
    for (const id of ['-1', '-0']) {
      const missing = await session.callTool({ name: 'Signed_get', args: { id } });

      assert({
        ok: structured({ result: missing }).status === 'not_found',
        message: `phase 4 (section 4): id ${JSON.stringify(id)} answered ${textOf({ result: missing })}`,
      });
    }

    // Leading zeros are accepted and resolve to the same row, as decided.
    const padded = await session.callTool({ name: 'Signed_get', args: { id: '001' } });

    assert({
      ok: structured({ result: padded }).object?.id === '1',
      message: `phase 4 (section 4): a leading-zero id answered ${textOf({ result: padded })}`,
    });

    // AC-3: a page ending at 9007199254740993 yields a cursor that returns the
    // next row and no overlap.
    const page1 = await session.callTool({ name: 'Signed_list', args: { limit: 3 } });
    const first = structured({ result: page1 });

    assert({
      ok: first.items?.at(-1)?.id === HUGE && first.nextCursor === HUGE,
      message: `phase 4 (AC-3): the first page ended at ${JSON.stringify(first.items?.at(-1))} with cursor ${first.nextCursor}`,
    });

    const page2 = await session.callTool({
      name: 'Signed_list',
      args: { limit: 3, cursor: first.nextCursor },
    });
    const second = structured({ result: page2 });

    assert({
      ok: second.items?.length === 1 && second.items[0].id === NEXT,
      message: `phase 4 (AC-3): the page after 2^53 returned ${JSON.stringify(second.items)}`,
    });
    assert({
      ok: !second.items.some((row) => first.items.some((seen) => seen.id === row.id)),
      message: 'phase 4 (AC-3): the second page overlaps the first',
    });

    const badCursor = await session.callTool({
      name: 'Signed_list',
      args: { cursor: 'not-a-cursor' },
    });

    assert({
      ok:
        structured({ result: badCursor }).status === 'ok' &&
        structured({ result: badCursor }).items?.length === 0,
      message: `phase 4 (section 4): a malformed cursor answered ${textOf({ result: badCursor })}`,
    });

    const filtered = await session.callTool({
      name: 'Signed_list',
      args: { filter: { id: { gte: HUGE } } },
    });

    assert({
      ok: (structured({ result: filtered }).items ?? []).length === 2,
      message: `phase 4 (AC-4): an ordering filter above 2^53 returned ${textOf({ result: filtered })}`,
    });

    console.log(
      'ONT-068 phase 4 (AC-1, AC-3): reads answer above 2^53, and the cursor steps across it.',
    );

    // ---- Phase 5 (AC-2) ----
    const updated = await session.callTool({
      name: 'updateSigned',
      args: { id: HUGE, name: 'signed-renamed' },
    });

    assert({
      ok: structured({ result: updated }).status === 'executed',
      message: `phase 5 (AC-2): update with a decimal-string id answered ${textOf({ result: updated })}`,
    });
    assert({
      ok: structured({ result: updated }).result?.id === HUGE,
      message: `phase 5 (AC-2): the update result carries ${JSON.stringify(structured({ result: updated }).result)}`,
    });

    const created = await session.callTool({ name: 'createSigned', args: { name: 'signed-new' } });

    assert({
      ok: structured({ result: created }).status === 'executed',
      message: `phase 5 (AC-2): create answered ${textOf({ result: created })}`,
    });

    const staged = await session.callTool({ name: 'deleteSigned', args: { id: '2' } });

    assert({
      ok: structured({ result: staged }).status === 'approval_pending',
      message: `phase 5 (AC-2): the gated delete answered ${textOf({ result: staged })}`,
    });

    approvalId = structured({ result: staged }).approvalId;

    // ---- Phase 6 (AC-5): an Int key carrying a BigInt foreign key ----
    const fkListed = await session.callTool({ name: 'Fk_list', args: {} });

    assert({
      ok: (structured({ result: fkListed }).items ?? []).some((row) => row.signedId === HUGE),
      message: `phase 6 (AC-5): the BigInt foreign key came back as ${textOf({ result: fkListed })}`,
    });

    const fkCreated = await session.callTool({
      name: 'createFk',
      args: { signedId: HUGE, label: 'fk-created' },
    });

    assert({
      ok: structured({ result: fkCreated }).status === 'executed',
      message: `phase 6 (AC-5): create on the FK model answered ${textOf({ result: fkCreated })}`,
    });

    const fkUpdated = await session.callTool({
      name: 'updateFk',
      args: { id: 1, signedId: HUGE, label: 'fk-renamed' },
    });

    assert({
      ok: structured({ result: fkUpdated }).status === 'executed',
      message: `phase 6 (AC-5): update on the FK model answered ${textOf({ result: fkUpdated })}`,
    });
    assert({
      ok: structured({ result: fkUpdated }).result?.signedId === HUGE,
      message: `phase 6 (AC-5): the update result carries ${JSON.stringify(structured({ result: fkUpdated }).result)}`,
    });

    const fkStaged = await session.callTool({ name: 'deleteFk', args: { id: 2 } });

    assert({
      ok: structured({ result: fkStaged }).status === 'approval_pending',
      message: `phase 6 (AC-5): the gated delete on the FK model answered ${textOf({ result: fkStaged })}`,
    });

    fkApprovalId = structured({ result: fkStaged }).approvalId;
  } finally {
    await session.close();
  }

  for (const id of [approvalId, fkApprovalId]) {
    const approve = runCli({ cwd, args: ['approvals', 'approve', id, '--yes'], env });

    assert({
      ok: approve.status === 0 && approve.stdout.includes('approved'),
      message: `phase 5 (AC-2): approving ${id} exited ${approve.status}\n${approve.stdout}${approve.stderr}`,
    });
  }

  // A SECOND session, so the completion is the one an agent polling
  // `check_approval` actually gets rather than a continuation of the staging one.
  const completion = await openSession({ cwd, env });

  try {
    for (const [label, id] of [
      ['phase 5 (AC-2)', approvalId],
      ['phase 6 (AC-5)', fkApprovalId],
    ]) {
      const executed = await completion.callTool({
        name: 'check_approval',
        args: { approvalId: id },
      });

      assert({
        ok: structured({ result: executed }).status === 'executed',
        message: `${label}: check_approval answered ${textOf({ result: executed })}\n${completion.stderrText()}`,
      });
    }

    const gone = await completion.callTool({ name: 'Signed_get', args: { id: '2' } });

    assert({
      ok: structured({ result: gone }).status === 'not_found',
      message: `phase 5 (AC-2): the approved delete left the row readable — ${textOf({ result: gone })}`,
    });
  } finally {
    await completion.close();
  }

  const verify = runCli({ cwd, args: ['audit', 'verify'], env });

  assert({
    ok: verify.status === 0 && verify.stdout.includes('audit chain OK'),
    message: `phase 5 (AC-2): audit verify exited ${verify.status}\n${verify.stdout}${verify.stderr}`,
  });

  // The PRIOR target row is read at engine.ts:448 and stamped on the
  // execution_started record. It is the one BigInt on the audit path that no
  // transport ever sees, so it is asserted on the chain itself.
  const records = readFileSync(join(cwd, '.orangerail', 'store', 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const priors = records.filter((record) => record.prior?.state === 'value');

  assert({
    ok: priors.length > 0,
    message: 'phase 5 (section 4): no audit record carries a prior target row at all',
  });
  assert({
    ok: priors.some((record) => record.prior.value.id === HUGE),
    message: `phase 5 (section 4): no audit record carries the decimal string for the row above 2^53 — ${JSON.stringify(priors.map((record) => record.prior.value))}`,
  });
  assert({
    ok: priors.some((record) => record.prior.value.signedId === HUGE),
    message: 'phase 6 (AC-5): the audit record for the FK model does not carry its BigInt column',
  });

  console.log(
    `ONT-068 phases 5-6 (AC-2, AC-5): writes execute, the gate completes, and ${verify.stdout.trim()}`,
  );
};

await live();

rmSync(WORK, { recursive: true, force: true });

if (skipped > 0) {
  console.log(`ONT-068 e2e: ${skipped} capability-gated phase(s) SKIPPED (see notices above).`);
}

console.log('ONT-068 e2e: all assertions passed.');
