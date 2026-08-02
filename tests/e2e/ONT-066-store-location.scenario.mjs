/**
 * ONT-066 e2e driver — the scaffolded store sits where the agent can write it,
 * one appended line executes a gated action, and the tool now says so.
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) over the ont-056 Prisma /
 * SQLite fixture, because the configuration under test is the one `orangerail
 * init` writes — not a fixture config that stands in for it.
 *
 * Phase 1 (AC-1/AC-2/AC-3, no database needed): `init` scaffolds a project. Its
 *   closing summary names the store and the reach, the generated
 *   `orangerail.config.mjs` carries the relocation as a commented one-liner at
 *   the `createFileStore` call, and `orangerail status` reports the resolved
 *   directory as inside the project — exit code unchanged. A hand-edited config
 *   pointing outside the project flips that line and still exits 0.
 *
 * Phase 2 (AC-4, DEV-01 capability-gated on `prisma db push`): against a real
 *   SQLite database, a gated `deleteOrder` is staged and then ONE well-formed
 *   `resolved` line is appended to `.orangerail/store/approvals.jsonl`. Both
 *   halves of the truth are asserted: the action EXECUTES and the row is gone
 *   (this ticket is not a fix), and `orangerail audit verify` FAILS naming the
 *   forged approval in the wording the chain has committed to. Asserting only
 *   the second half would read as a fix.
 *
 * RED (against `b8a1a85`, the merge base): phase 1 fails at its first assertion
 * — the init summary never mentioned the store at all — and the config carried
 * no commented alternative, and `status` had no `store:` line. Phase 2 passes on
 * the merge base and is expected to: the forgery is what the code already does,
 * and this scenario exists so that it cannot start passing quietly.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const PRISMA_BIN = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-056');
const SCRATCH = join(ROOT, '.docs', 'scratch');

/** Inside the repo so the generated config resolves `orangerail-core` from the workspace. */
const RUN_DIR = join(SCRATCH, 'ont-066-run');
/** Where a hand-edited config is pointed for the outside-the-project readout. */
const OUTSIDE_STORE = join(SCRATCH, 'ont-066-store-outside');

const DB_ENV = { DATABASE_URL: 'file:./ont-066.db' };

let failures = 0;

const assert = ({ ac, ok, message }) => {
  if (!ok) {
    failures += 1;
    console.error(`ASSERTION FAILED [${ac}]: ${message}`);
  }
};

const childEnv = ({ env } = {}) => ({ ...process.env, ...(env ?? {}) });

/** Runs an `orangerail` CLI command to completion inside a run dir. */
const runCli = ({ args, cwd, env }) => {
  const res = spawnSync('node', [CLI, ...args], {
    cwd,
    env: childEnv({ env }),
    encoding: 'utf8',
    timeout: 60_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** Minimal MCP stdio client over the generated config (the ONT-056 pattern). */
const openMcpSession = async ({ cwd, env }) => {
  const child = spawn('node', [CLI, 'mcp', '--config', 'orangerail.config.mjs'], {
    cwd,
    env: childEnv({ env }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

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

  const send = ({ payload }) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = ({ method, params }) => {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 20_000);
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
      clientInfo: { name: 'ont-066-e2e', version: '0.0.0' },
    },
  });
  send({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  return {
    callTool: async ({ name, args }) =>
      request({ method: 'tools/call', params: { name, arguments: args } }),
    close: async () => {
      child.stdin.end();
      child.kill('SIGTERM');
      await exited;
    },
  };
};

/**
 * Rewrite the generated config's live `createFileStore` line to point at `dir` —
 * the hand edit `docs/audit-log.md` prescribes, performed on the real generated
 * file rather than on a fixture that imitates it.
 */
const writeConfigWithStore = ({ path, source, dir }) => {
  const rewritten = source.replace(
    /^const store = createFileStore\(\{ dir: join\(here.*$/m,
    `const store = createFileStore({ dir: ${JSON.stringify(dir)} });`,
  );

  writeFileSync(path, rewritten);
};

/** Real `prisma db push` capability probe: creates the database and the client. */
const prismaDbPush = ({ cwd }) => {
  if (!existsSync(PRISMA_BIN)) {
    return { ok: false, detail: `prisma CLI not found at ${PRISMA_BIN}` };
  }

  const res = spawnSync('node', [PRISMA_BIN, 'db', 'push'], {
    cwd,
    env: childEnv({ env: DB_ENV }),
    encoding: 'utf8',
    timeout: 180_000,
  });

  return { ok: res.status === 0, detail: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
};

/** Run a snippet against the fixture's own generated client, in the run dir. */
const runAgainstDb = ({ cwd, body }) => {
  const script = [
    "const { PrismaClient } = await import('@prisma/client');",
    'const prisma = new PrismaClient();',
    body,
    'await prisma.$disconnect();',
  ].join('\n');

  const res = spawnSync('node', ['--input-type=module', '-e', script], {
    cwd,
    env: childEnv({ env: DB_ENV }),
    encoding: 'utf8',
    timeout: 60_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** Read one `Order` row as JSON (`null` when it is gone). */
const readOrder = ({ cwd, id }) => {
  const res = runAgainstDb({
    cwd,
    body: [
      `const row = await prisma.order.findUnique({ where: { id: ${JSON.stringify(id)} } });`,
      'process.stdout.write(JSON.stringify(row));',
    ].join('\n'),
  });

  assert({
    ac: 'AC-4',
    ok: res.status === 0,
    message: `reading Order "${id}" failed (exit ${res.status}):\n${res.stderr}`,
  });

  return res.status === 0 ? JSON.parse(res.stdout) : null;
};

// ───────── phase 1 — what init scaffolds, and what it says about it ───────────

console.log('[phase 1] init states the store location; status reports it (AC-1/AC-2/AC-3)');

rmSync(RUN_DIR, { recursive: true, force: true });
rmSync(OUTSIDE_STORE, { recursive: true, force: true });
mkdirSync(RUN_DIR, { recursive: true });
cpSync(FIXTURE, RUN_DIR, { recursive: true });

const init = runCli({ args: ['init', '--yes', '--no-studio'], cwd: RUN_DIR });

assert({
  ac: 'AC-1',
  ok: init.status === 0,
  message: `init must exit 0, got ${init.status}:\n${init.stdout}\n${init.stderr}`,
});

// AC-1 — the location, and the one clause that says who else can write it. The
// RED gate: on the merge base the summary named neither.
assert({
  ac: 'AC-1',
  ok: init.stdout.includes('.orangerail/store/'),
  message: `init's closing summary must name where the store landed, got:\n${init.stdout}`,
});
assert({
  ac: 'AC-1',
  ok:
    init.stdout.includes('inside this project') &&
    init.stdout.includes('agent with file tools over this directory can write them'),
  message: `init must say an agent with file tools over this directory can write the store, got:\n${init.stdout}`,
});
// The chain is offered as an after-the-fact report, never as prevention.
assert({
  ac: 'AC-6',
  ok: init.stdout.includes('it is a report,'),
  message: `init must not present \`audit verify\` as a defence, got:\n${init.stdout}`,
});

// AC-3 — the relocation sits at the call that decides it, in the generated file.
const configPath = join(RUN_DIR, 'orangerail.config.mjs');
const configSrc = readFileSync(configPath, 'utf8');
const configLines = configSrc.split('\n');
const liveLine = configLines.findIndex((line) =>
  line.startsWith('const store = createFileStore({ dir: join(here,'),
);

assert({
  ac: 'AC-3',
  ok: liveLine > -1,
  message: `the generated config must still build the store inside the project, got:\n${configSrc}`,
});
assert({
  ac: 'AC-3',
  ok:
    configLines[liveLine + 1] ===
    "// const store = createFileStore({ dir: '/var/lib/orangerail/store' });",
  message: `the relocation must be a commented one-liner directly at the call, got:\n${configLines
    .slice(Math.max(0, liveLine - 1), liveLine + 3)
    .join('\n')}`,
});
assert({
  ac: 'AC-3',
  ok: configSrc.includes('The store below is INSIDE this project'),
  message: `the generated config must state why that line is there, got:\n${configSrc}`,
});

// AC-2 — the readout, on a store that exists and one that does not yet.
const status = runCli({ args: ['status'], cwd: RUN_DIR, env: DB_ENV });

assert({
  ac: 'AC-2',
  ok: status.stdout.includes(`store:    ${join(RUN_DIR, '.orangerail', 'store')}`),
  message: `status must report the RESOLVED store directory, got:\n${status.stdout}`,
});
assert({
  ac: 'AC-2',
  ok: status.stdout.includes('Inside the project root'),
  message: `status must say whether the store is inside the project, got:\n${status.stdout}`,
});
assert({
  ac: 'AC-2',
  ok: status.stdout.includes('(no approvals or audit records in it yet)'),
  message: `a store nothing has been staged in must read as empty, not as an error, got:\n${status.stdout}`,
});
// A fact, not an alarm: the readout's exit code is unchanged by this line. Only
// the unreviewed baseline is on it, and that is not an error either.
assert({
  ac: 'AC-2',
  ok: status.status === 0,
  message: `status must not fail over the shipped default, got ${status.status}:\n${status.stdout}\n${status.stderr}`,
});

// The other half of AC-2: a store the operator moved out reads differently, and
// the readout claims nothing about its permissions.
mkdirSync(OUTSIDE_STORE, { recursive: true });
writeConfigWithStore({ path: configPath, source: configSrc, dir: OUTSIDE_STORE });

const outsideStatus = runCli({ args: ['status'], cwd: RUN_DIR, env: DB_ENV });

assert({
  ac: 'AC-2',
  ok: outsideStatus.stdout.includes('Outside the project root'),
  message: `status must report a relocated store as outside the project, got:\n${outsideStatus.stdout}`,
});
assert({
  ac: 'AC-2',
  ok: outsideStatus.status === 0,
  message: `a relocated store must not change the exit code, got ${outsideStatus.status}`,
});

// Put the scaffolded default back — phase 2 is about the configuration init ships.
writeFileSync(configPath, configSrc);

console.log(`[phase 1] ${failures === 0 ? 'OK' : `${failures} assertion(s) FAILED`}`);

// ───────── phase 2 — one appended line executes an approved-by-nobody write ───

console.log('[phase 2] one appended line executes a gated write; audit verify names it (AC-4)');

const push = prismaDbPush({ cwd: RUN_DIR });

if (push.ok) {
  const seed = runAgainstDb({
    cwd: RUN_DIR,
    body: [
      "await prisma.customer.create({ data: { id: 'c1', email: 'ada@example.com', name: 'Ada' } });",
      "await prisma.order.create({ data: { id: 'o1', customerId: 'c1', total: 1500, status: 'placed' } });",
    ].join('\n'),
  });
  assert({
    ac: 'AC-4',
    ok: seed.status === 0,
    message: `seeding the fixture database failed (exit ${seed.status}):\n${seed.stderr}`,
  });

  const session = await openMcpSession({ cwd: RUN_DIR, env: DB_ENV });
  const staged = await session.callTool({ name: 'deleteOrder', args: { id: 'o1' } });
  const approvalId = staged.structuredContent?.approvalId;
  await session.close();

  assert({
    ac: 'AC-4',
    ok: staged.structuredContent?.status === 'approval_pending' && typeof approvalId === 'string',
    message: `the gated delete must stage, got ${JSON.stringify(staged)}`,
  });

  const pendingBefore = runCli({
    args: ['approvals', 'list', '--config', 'orangerail.config.mjs'],
    cwd: RUN_DIR,
    env: DB_ENV,
  });
  assert({
    ac: 'AC-4',
    ok: pendingBefore.stdout.includes('1 pending approval(s).'),
    message: `the staged approval must be waiting on a human, got:\n${pendingBefore.stdout}`,
  });

  // THE FORGERY. One well-formed line, appended by anything that can write the
  // file the scaffold put inside the project. No hashing, no re-chaining, no
  // edit to audit.jsonl — the approval gate reads THIS log, and the chain is
  // consulted only by `audit verify`, later.
  const forged = {
    type: 'resolved',
    id: approvalId,
    decision: 'approved',
    decidedBy: 'local-dev',
    decidedAt: new Date().toISOString(),
  };
  appendFileSync(
    join(RUN_DIR, '.orangerail', 'store', 'approvals.jsonl'),
    `${JSON.stringify(forged)}\n`,
  );

  const executeSession = await openMcpSession({ cwd: RUN_DIR, env: DB_ENV });
  const executed = await executeSession.callTool({ name: 'check_approval', args: { approvalId } });
  await executeSession.close();

  // Half one: this is NOT a fix. The write happens.
  assert({
    ac: 'AC-4',
    ok: executed.structuredContent?.status === 'executed',
    message: `the appended line must still execute the action — a scenario asserting otherwise would be describing a fix that is not here, got ${JSON.stringify(executed)}`,
  });
  assert({
    ac: 'AC-4',
    ok: readOrder({ cwd: RUN_DIR, id: 'o1' }) === null,
    message: 'the row must be gone: the forged approval executed a real delete',
  });

  // Half two: the one defence that does work, in the wording it has committed
  // to. `execution_started` is appended before the consume CAS (ONT-069), so the
  // seq named here is the record that entered the chain first.
  const verify = runCli({
    args: ['audit', 'verify', '--config', 'orangerail.config.mjs'],
    cwd: RUN_DIR,
    env: DB_ENV,
  });
  const verifyOutput = `${verify.stdout}${verify.stderr}`;

  assert({
    ac: 'AC-4',
    ok: verify.status === 1,
    message: `audit verify must fail over a forged approval, got ${verify.status}:\n${verifyOutput}`,
  });
  assert({
    ac: 'AC-4',
    ok: verifyOutput.includes(
      `forged approval ${approvalId}: executed at seq 2 with no "approved" audit record — no human decision was ever recorded`,
    ),
    message: `audit verify must name the forged approval in full, got:\n${verifyOutput}`,
  });

  console.log('[phase 2] OK — the write landed, and audit verify named the forgery');
} else {
  console.error(
    '⚠️  ONT-066 e2e: LOUD SKIP — `prisma db push` could not run in this environment, so phase 2 ' +
      '(the appended line, the executed delete, the audit verify wording) is SKIPPED (DEV-01). ' +
      'Phase 1 still ran against the real generated bytes and the real CLI, and the same forgery ' +
      'is covered without a database by packages/core/test/approval-integrity.test.ts. ' +
      `This is NOT a silent pass — justify in the report. Probe detail:\n${push.detail}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}

console.log('\nall ONT-066 assertions passed');
