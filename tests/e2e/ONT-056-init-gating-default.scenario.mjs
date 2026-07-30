/**
 * ONT-056 e2e driver — the `orangerail init --gate` default, end to end.
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) over the ont-056 fixture
 * (a Prisma SQLite source, `Customer` -> `Order`, which scans to exactly the 2
 * object(s) / 6 action(s) the README quickstart quotes) and proves that the
 * posture `init` NOW ships is real at every layer it is claimed at:
 *
 *   Phase 1 (AC-1/2/3, no database needed): `init` with no `--gate` writes
 *     `policy: { approval: 'required' }` on the two deletes and on NOTHING else,
 *     the un-gated files say so in their own header instead of claiming to stage,
 *     an un-gated `update` KEEPS its `target`/`targetIdFrom`, and the three
 *     readouts that quote a number — the init summary, `orangerail status`, and
 *     the governance baseline's note — all say 2 of 6 rather than 6.
 *   Phase 2 (AC-4, the claim that matters): against a real SQLite database, an
 *     MCP client calls the generated `updateOrder` and the row CHANGES on that
 *     call with no approvalId anywhere; it then calls the generated `deleteOrder`
 *     and gets `approval_pending` while the row STAYS. A human approves through
 *     the shipped CLI, `check_approval` executes it, and only then is the row
 *     gone. `audit verify` passes over a chain that holds both — which is the
 *     point of un-gating: the write is not staged, it is still recorded.
 *   Phase 3 (AC-5, flag parity): `--gate all` gates all 6, `--gate none` gates 0,
 *     and an unknown `--gate` value refuses with exit 1 while naming the three
 *     accepted values — the same contract `--preset` has.
 *
 * RED (pre-implementation): `init` gated all six actions, so phase 1 fails at
 * its first assertion — `createCustomer.mjs` carries the gate the default is
 * supposed to leave off. Phase 2's `updateOrder` call would return
 * `approval_pending` instead of a row. Phase 3 fails on the flag not existing.
 *
 * Capability gate (DEV-01): only phase 2's database work is gated behind a real
 * `prisma db push` probe. If the toolchain cannot run it, phase 2 is skipped
 * with a LOUD notice (never silently passed); phases 1 and 3 read generated
 * bytes and CLI exit codes and always run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const PRISMA_BIN = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-056');
const SCRATCH = join(ROOT, '.docs', 'scratch');

const RUN_DEFAULT = join(SCRATCH, 'ont-056-run-default');
const RUN_ALL = join(SCRATCH, 'ont-056-run-all');
const RUN_NONE = join(SCRATCH, 'ont-056-run-none');
const RUN_BOGUS = join(SCRATCH, 'ont-056-run-bogus');

const DB_ENV = { DATABASE_URL: 'file:./ont-056.db' };

/** Every action the fixture scans to, split by what `--gate delete` does to it. */
const GATED_BY_DEFAULT = ['deleteCustomer', 'deleteOrder'];
const UNGATED_BY_DEFAULT = ['createCustomer', 'createOrder', 'updateCustomer', 'updateOrder'];
const ALL_ACTIONS = [...GATED_BY_DEFAULT, ...UNGATED_BY_DEFAULT];

/**
 * The emitted policy line, matched WITH its surrounding newlines and indent.
 * An un-gated file names the same text in its header ("add `policy: { approval:
 * 'required' },` below"), so a bare substring match would report every un-gated
 * file as gated — the assertion has to look at the code, not at the prose about
 * the code.
 */
const GATE_LINE = "\n  policy: { approval: 'required' },\n";

const fail = ({ message }) => {
  console.error(`ONT-056 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

/** Build a child environment from the ambient one plus an overlay. */
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

/** Copy the fixture repo into a clean scratch run dir. */
const prepareRunDir = ({ dir }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
};

/** Read a generated `ontology/<name>.mjs`. */
const readAction = ({ runDir, name }) =>
  readFileSync(join(runDir, 'ontology', `${name}.mjs`), 'utf8');

/**
 * Real `prisma db push` capability probe: creates the SQLite database AND
 * generates the client, so phase 2 can be gated on whether this environment can
 * run Prisma at all rather than reporting a false pass.
 */
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
    ok: res.status === 0,
    message: `reading Order "${id}" via a short-lived client failed (exit ${res.status}):\n${res.stderr}`,
  });

  return JSON.parse(res.stdout);
};

/**
 * Minimal MCP stdio client (the ONT-003/006/018 pattern) over the generated
 * config. stderr is echoed rather than swallowed so a server that dies during a
 * call explains itself in the scenario log.
 */
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
      clientInfo: { name: 'ont-056-e2e', version: '0.0.0' },
    },
  });
  send({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  return {
    listTools: async () => request({ method: 'tools/list', params: {} }),
    callTool: async ({ name, args }) =>
      request({ method: 'tools/call', params: { name, arguments: args } }),
    close: async () => {
      child.stdin.end();
      child.kill('SIGTERM');
      await exited;
    },
  };
};

// ───────── phase 1 — what the default writes, and what it says it wrote ───────

console.log('[phase 1] init with no --gate gates the deletes and nothing else (AC-1/2/3)');

prepareRunDir({ dir: RUN_DEFAULT });

const init = runCli({
  args: ['init', '--yes', '--no-studio', '--preset', 'approval-for-writes'],
  cwd: RUN_DEFAULT,
});
assert({
  ok: init.status === 0,
  message: `init must exit 0, got ${init.status}:\n${init.stdout}\n${init.stderr}`,
});

// AC-1, and the RED gate: pre-ONT-056 every one of these carried the gate.
for (const name of GATED_BY_DEFAULT) {
  const src = readAction({ runDir: RUN_DEFAULT, name });
  assert({
    ok: src.includes(GATE_LINE),
    message: `${name}.mjs must carry \`policy: { approval: 'required' },\` under the default --gate delete`,
  });
  assert({
    ok: /DESTRUCTIVE/.test(src),
    message: `${name}.mjs must still be marked DESTRUCTIVE so an approver sees what they authorize`,
  });
}

for (const name of UNGATED_BY_DEFAULT) {
  const src = readAction({ runDir: RUN_DEFAULT, name });
  assert({
    ok: !src.includes(GATE_LINE),
    message: `${name}.mjs must NOT carry an approval gate under the default --gate delete:\n${src}`,
  });

  // AC-2: the header is the first thing a reviewer reads, so it has to track the
  // policy below it rather than keep claiming a staging step that is not there.
  assert({
    ok: /whenever the agent calls it/.test(src),
    message: `${name}.mjs must say in its header that it runs when the agent calls it, got:\n${src}`,
  });
  assert({
    ok: /NOT approval-gated/.test(src) && src.includes("add `policy: { approval: 'required' },`"),
    message: `${name}.mjs must tell the reader how to gate it, got:\n${src}`,
  });
  assert({
    ok: !/staged for human approval/.test(src),
    message: `${name}.mjs must not describe itself as staged when it is not:\n${src}`,
  });
}

// An un-gated targeted write KEEPS its target wiring: `target`/`targetIdFrom` name
// the row the action governs (the studio self-loop, a future `where` guard, and
// the recorded posture all read it), and dropping them with the gate would be a
// silent second change nobody asked for.
const updateOrderSrc = readAction({ runDir: RUN_DEFAULT, name: 'updateOrder' });
assert({
  ok: /target: Order,/.test(updateOrderSrc) && /targetIdFrom: "id",/.test(updateOrderSrc),
  message: `un-gated updateOrder.mjs must still carry target + targetIdFrom, got:\n${updateOrderSrc}`,
});

// AC-3: every readout that quotes a number quotes the SAME number, and none of
// them is the old blanket claim.
assert({
  ok: init.stdout.includes(
    '--gate delete: 2 of 6 write action(s) gated behind human approval — the other 4 run when the agent calls them',
  ),
  message: `init's closing summary must name the gate and both counts, got:\n${init.stdout}`,
});
assert({
  ok: init.stdout.includes('--gate all') && init.stdout.includes('--gate none'),
  message: `init must tell the operator how to change the posture in both directions, got:\n${init.stdout}`,
});

const status = runCli({ args: ['status'], cwd: RUN_DEFAULT });
assert({
  ok: status.stdout.includes('actions:  2 approval-gated, 4 auto'),
  message: `orangerail status must report 2 approval-gated, 4 auto, got:\n${status.stdout}`,
});

const baselinePath = join(RUN_DEFAULT, 'orangerail.governance.json');
assert({
  ok: existsSync(baselinePath),
  message: 'init must record the generated posture in orangerail.governance.json',
});
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
assert({
  ok: baseline.recordedBy === 'init',
  message: `the baseline must be init-provenance, got ${JSON.stringify(baseline.recordedBy)}`,
});
assert({
  ok: baseline.note.includes('(2 of 6 action(s) approval-gated)'),
  message: `the baseline note must count its own rows so a reader knows the nulls were generated, got:\n${baseline.note}`,
});
const recordedGated = baseline.actions
  .filter((row) => row.approval === 'required')
  .map((row) => row.name);
assert({
  ok: JSON.stringify([...recordedGated].sort()) === JSON.stringify([...GATED_BY_DEFAULT].sort()),
  message: `the baseline rows must record exactly the deletes as gated, got ${JSON.stringify(recordedGated)}`,
});

// The default posture is not drift: a `sync` straight after init has nothing to
// report. Without this, "we changed the default" and "we broke the drift check"
// would look identical from the outside.
const sync = runCli({ args: ['sync'], cwd: RUN_DEFAULT });
assert({
  ok: sync.status === 0,
  message: `sync right after init must exit 0 on the default posture, got ${sync.status}:\n${sync.stdout}\n${sync.stderr}`,
});

console.log('[phase 1] OK');

// ───────── phase 2 — the update runs, the delete waits, against real SQLite ────

console.log('[phase 2] a generated update executes on call; a generated delete stages (AC-4)');

const push = prismaDbPush({ cwd: RUN_DEFAULT });

if (push.ok) {
  const seed = runAgainstDb({
    cwd: RUN_DEFAULT,
    body: [
      "await prisma.customer.create({ data: { id: 'c1', email: 'ada@example.com', name: 'Ada' } });",
      "await prisma.order.create({ data: { id: 'o1', customerId: 'c1', total: 1500, status: 'placed' } });",
    ].join('\n'),
  });
  assert({
    ok: seed.status === 0,
    message: `seeding the fixture database failed (exit ${seed.status}):\n${seed.stderr}`,
  });

  const session = await openMcpSession({ cwd: RUN_DEFAULT, env: DB_ENV });

  // The tool descriptions are the agent's only advance notice of which of the two
  // it is about to get, so they have to differ.
  const listed = await session.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of ALL_ACTIONS) {
    assert({
      ok: byName.has(name),
      message: `tools/list must expose "${name}" (got: ${[...byName.keys()].join(', ')})`,
    });
  }
  assert({
    ok: /^Run the/.test(byName.get('updateOrder').description),
    message: `un-gated updateOrder must advertise itself as a run tool, got: ${byName.get('updateOrder').description}`,
  });
  assert({
    ok: /^Stage the/.test(byName.get('deleteOrder').description),
    message: `gated deleteOrder must advertise itself as a staging tool, got: ${byName.get('deleteOrder').description}`,
  });

  // The ordinary write: it executes on the call itself.
  const updated = await session.callTool({
    name: 'updateOrder',
    args: { id: 'o1', status: 'shipped', total: 1800 },
  });
  assert({
    ok: updated.structuredContent?.status === 'executed',
    message: `un-gated updateOrder must EXECUTE on the call, got ${JSON.stringify(updated)}`,
  });
  assert({
    ok: updated.structuredContent?.approvalId === undefined,
    message: `an un-gated action must not produce an approvalId, got ${JSON.stringify(updated)}`,
  });

  const afterUpdate = readOrder({ cwd: RUN_DEFAULT, id: 'o1' });
  assert({
    ok: afterUpdate !== null && afterUpdate.status === 'shipped' && afterUpdate.total === 1800,
    message: `the un-gated update must be observable in the database, got ${JSON.stringify(afterUpdate)}`,
  });

  // The destructive write, on the same server, in the same session: it waits.
  const stagedDelete = await session.callTool({ name: 'deleteOrder', args: { id: 'o1' } });
  const approvalId = stagedDelete.structuredContent?.approvalId;
  assert({
    ok:
      stagedDelete.structuredContent?.status === 'approval_pending' &&
      typeof approvalId === 'string',
    message: `gated deleteOrder must STAGE, got ${JSON.stringify(stagedDelete)}`,
  });

  const stillThere = readOrder({ cwd: RUN_DEFAULT, id: 'o1' });
  assert({
    ok: stillThere !== null,
    message: 'the staged delete must not have touched the row before a human decided',
  });

  await session.close();

  const approve = runCli({
    args: ['approvals', 'approve', approvalId, '--config', 'orangerail.config.mjs'],
    cwd: RUN_DEFAULT,
    env: DB_ENV,
  });
  assert({
    ok: approve.status === 0,
    message: `approvals approve must succeed, got ${approve.status}:\n${approve.stdout}\n${approve.stderr}`,
  });

  const session2 = await openMcpSession({ cwd: RUN_DEFAULT, env: DB_ENV });
  const executed = await session2.callTool({ name: 'check_approval', args: { approvalId } });
  assert({
    ok: executed.structuredContent?.status === 'executed',
    message: `check_approval must execute the approved delete, got ${JSON.stringify(executed)}`,
  });
  await session2.close();

  const gone = readOrder({ cwd: RUN_DEFAULT, id: 'o1' });
  assert({
    ok: gone === null,
    message: `the row must be gone only after the approval, got ${JSON.stringify(gone)}`,
  });

  // The whole argument for shipping an un-gated write: it is not staged, and it
  // is still on the chain. A green `audit verify` over a chain that carries both
  // the un-gated update and the approved delete is that claim, checked.
  const auditVerify = runCli({
    args: ['audit', 'verify', '--config', 'orangerail.config.mjs'],
    cwd: RUN_DEFAULT,
    env: DB_ENV,
  });
  assert({
    ok: auditVerify.status === 0,
    message: `audit verify must pass over a chain holding both writes, got ${auditVerify.status}:\n${auditVerify.stdout}\n${auditVerify.stderr}`,
  });
  assert({
    ok: /chain OK/.test(auditVerify.stdout) && !/0 record\(s\)/.test(auditVerify.stdout),
    message: `the un-gated update must have LANDED on the chain, got:\n${auditVerify.stdout}`,
  });

  console.log('[phase 2] OK — update executed on call, delete waited for a human, chain verified');
} else {
  console.error(
    '⚠️  ONT-056 e2e: LOUD SKIP — `prisma db push` could not run in this environment, so phase 2 ' +
      '(update executes on call / delete stages / row observation / audit verify) is SKIPPED ' +
      '(DEV-01). Phases 1 and 3 still ran against the real generated bytes and the real CLI. ' +
      `This is NOT a silent pass — justify in the report. Probe detail:\n${push.detail}`,
  );
}

// ───────── phase 3 — flag parity: all, none, and an unknown value ─────────────

console.log('[phase 3] --gate all / --gate none / an unknown value (AC-5)');

prepareRunDir({ dir: RUN_ALL });
const initAll = runCli({
  args: ['init', '--yes', '--no-studio', '--no-docs', '--gate', 'all'],
  cwd: RUN_ALL,
});
assert({
  ok: initAll.status === 0,
  message: `--gate all must exit 0, got ${initAll.status}:\n${initAll.stdout}\n${initAll.stderr}`,
});
for (const name of ALL_ACTIONS) {
  assert({
    ok: readAction({ runDir: RUN_ALL, name }).includes(GATE_LINE),
    message: `--gate all must gate ${name}`,
  });
}
assert({
  ok: initAll.stdout.includes('--gate all: 6 of 6 write action(s) gated behind human approval'),
  message: `--gate all must report 6 of 6, got:\n${initAll.stdout}`,
});
// With nothing left un-gated there is no "the other N" clause to print.
assert({
  ok: !initAll.stdout.includes('run when the agent calls them'),
  message: `--gate all must not tack an empty remainder onto the summary, got:\n${initAll.stdout}`,
});

prepareRunDir({ dir: RUN_NONE });
const initNone = runCli({
  args: ['init', '--yes', '--no-studio', '--no-docs', '--gate', 'none'],
  cwd: RUN_NONE,
});
assert({
  ok: initNone.status === 0,
  message: `--gate none must exit 0, got ${initNone.status}:\n${initNone.stdout}\n${initNone.stderr}`,
});
for (const name of ALL_ACTIONS) {
  assert({
    ok: !readAction({ runDir: RUN_NONE, name }).includes(GATE_LINE),
    message: `--gate none must leave ${name} un-gated`,
  });
}
assert({
  ok: initNone.stdout.includes('--gate none: 0 of 6 write action(s) gated behind human approval'),
  message: `--gate none must report 0 of 6, got:\n${initNone.stdout}`,
});
// A delete is still marked DESTRUCTIVE with nothing gated: the marker describes
// what the code DOES, and `--gate none` is a statement about approval, not about
// whether the row survives.
assert({
  ok: /DESTRUCTIVE/.test(readAction({ runDir: RUN_NONE, name: 'deleteOrder' })),
  message: 'an un-gated delete must still be marked DESTRUCTIVE',
});

// Same refusal contract as `--preset`: reject the unknown value, write nothing.
prepareRunDir({ dir: RUN_BOGUS });
const initBogus = runCli({
  args: ['init', '--yes', '--no-studio', '--no-docs', '--gate', 'sometimes'],
  cwd: RUN_BOGUS,
});
assert({
  ok: initBogus.status !== 0,
  message: `an unknown --gate value must refuse, got exit ${initBogus.status}:\n${initBogus.stdout}\n${initBogus.stderr}`,
});
const bogusOutput = `${initBogus.stdout}\n${initBogus.stderr}`;
assert({
  ok: /unknown gate "sometimes"/.test(bogusOutput) && /all, delete, none/.test(bogusOutput),
  message: `the refusal must name the value and the accepted set, got:\n${bogusOutput}`,
});
assert({
  ok: !existsSync(join(RUN_BOGUS, 'ontology')),
  message: 'a refused --gate must write no ontology at all',
});

console.log('[phase 3] OK');

rmSync(RUN_ALL, { recursive: true, force: true });
rmSync(RUN_NONE, { recursive: true, force: true });
rmSync(RUN_BOGUS, { recursive: true, force: true });
rmSync(RUN_DEFAULT, { recursive: true, force: true });

console.log('ONT-056 e2e: PASS');
