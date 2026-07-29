/**
 * ONT-018 e2e driver — governed Prisma write actions (ticket section 5).
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) against the ont-018
 * fixture (a SQLite Prisma project with a single `Note` model) and an OpenAPI
 * sub-fixture, proving the whole governed write loop plus the honesty /
 * no-regression guarantees:
 *
 *   Phase 1 (AC-1/2/3, the core loop): `orangerail init` over the Prisma fixture
 *     emits real create/update/delete action files whose `execute` runs the
 *     actual `prisma.note.<op>` (NOT the `notImplemented` stub). A pure-Node MCP
 *     client discovers `createNote` in tools/list, calls it (→ approval_pending,
 *     staged, audited), a human approves via the shipped `orangerail approvals
 *     approve`, and — against a real SQLite database created by `prisma db push`
 *     — `check_approval` executes the mutation exactly once (the row is
 *     observably created), a re-call is denied (consumed), and `orangerail audit
 *     verify` passes. NO hand-editing of any generated file.
 *   Phase 2 (AC-4): with the client deliberately generated but NO datasource
 *     configured, calling the write action fails at execute with an actionable,
 *     CLASSIFIED diagnostic — `datasource_not_configured`, naming DATABASE_URL —
 *     while Prisma's own text stays out of the response and reaches only the
 *     operator sink under the same correlationId (ONT-032 + ONT-045). The
 *     generated AGENTS.md documents the Prisma action as approval-required and
 *     carries NO false "[stub — not implemented]" line.
 *   Phase 3 (AC-6): an OpenAPI-source fixture still emits an unchanged action
 *     file — a byte-identity check against a captured pre-ONT-018 reference
 *     proves the OpenAPI stub path is untouched.
 *
 * RED (pre-implementation): the Prisma scanner emits ZERO write actions, so
 * `orangerail init` generates no `ontology/createNote.mjs` and tools/list has no
 * `createNote` — Phase 1 fails at the very first discover assertion (the action
 * file does not exist). db push, staging, execution, and Phases 2/3 are never
 * reached. The RED FAIL therefore comes from "no createNote action exists", not
 * from a setup error. `verify.sh` still PASSes because the tree compiles.
 *
 * Capability gate (plan §4 / DEV-01): only the DB-dependent execute+observe
 * sub-block is gated behind a real `prisma db push` probe — if the toolchain
 * cannot run it, that sub-block is skipped with a LOUD notice (never silently
 * passed); discover, staging, approval, and audit-verify always run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const PRISMA_BIN = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-018');
const PRISMA_FIXTURE = FIXTURES;
const OPENAPI_FIXTURE = join(FIXTURES, 'openapi-src');
const OPENAPI_REFERENCE = join(FIXTURES, 'openapi-reference', 'cancelBooking.mjs');
const SCRATCH = join(ROOT, '.docs', 'scratch');
const RUN_PRISMA = join(SCRATCH, 'ont-018-run-prisma');
const RUN_NODB = join(SCRATCH, 'ont-018-run-nodb');
const RUN_OPENAPI = join(SCRATCH, 'ont-018-run-openapi');

const MODEL = 'Note';
const ACCESSOR = 'note';
const ACTIONS = ['createNote', 'updateNote', 'deleteNote'];
const DB_ENV = { DATABASE_URL: 'file:./ont-018.db' };

const fail = ({ message }) => {
  console.error(`ONT-018 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

/**
 * Build a child environment. `unset` is applied AFTER the merge, which is the
 * whole point: phase 2 needs a process that provably has no DATABASE_URL, and
 * spreading a pre-filtered copy over `process.env` silently puts an ambient one
 * back (the ambient value wins the first spread and nothing removes it).
 */
const childEnv = ({ env, unset } = {}) => {
  const merged = { ...process.env, ...(env ?? {}) };
  for (const key of unset ?? []) {
    delete merged[key];
  }

  return merged;
};

/** Runs an `orangerail` CLI command to completion inside a run dir. */
const runCli = ({ args, cwd, env, unset }) => {
  const res = spawnSync('node', [CLI, ...args], {
    cwd,
    env: childEnv({ env, unset }),
    encoding: 'utf8',
    timeout: 60_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** Copy a fixture repo into a clean scratch run dir. */
const prepareRunDir = ({ dir, fixture }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(fixture, dir, { recursive: true });
};

/** Absolute path of a generated `ontology/<name>` file. */
const ontologyPath = ({ runDir, name }) => join(runDir, 'ontology', name);

/**
 * Real `prisma db push` capability probe (plan §4): creates the SQLite DB AND
 * generates the client. Returns whether it succeeded so the execute+observe
 * sub-block can be gated (skip-with-loud-notice) rather than reporting a false
 * pass in a toolchain that cannot run Prisma.
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

  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;

  return { ok: res.status === 0, detail: output };
};

/**
 * Generate the Prisma client WITHOUT creating a database (phase 2 setup).
 *
 * `prisma generate` reads the schema and emits the client; it never opens the
 * datasource, so it succeeds with no DATABASE_URL. That is what lets phase 2
 * construct the unconfigured-datasource state DELIBERATELY: after this runs, a
 * missing or mismatched client is off the table by construction, and the only
 * fault left in the run dir is the one the phase is about.
 */
const prismaGenerate = ({ cwd }) => {
  if (!existsSync(PRISMA_BIN)) {
    return { ok: false, detail: `prisma CLI not found at ${PRISMA_BIN}` };
  }

  const res = spawnSync('node', [PRISMA_BIN, 'generate'], {
    cwd,
    env: childEnv({ unset: ['DATABASE_URL'] }),
    encoding: 'utf8',
    timeout: 180_000,
  });

  return { ok: res.status === 0, detail: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
};

/**
 * Prove the generated client is present AND carries the model this fixture
 * scanned. Phase 2 asserts on this before it asserts on the failure class: a
 * client that is absent, or generated from someone else's schema, produces a
 * DIFFERENT (also correct) diagnostic, and a phase that cannot tell the two
 * apart is not testing what its name claims.
 */
const prismaClientCarriesModel = ({ cwd }) => {
  const script = [
    "const { PrismaClient } = await import('@prisma/client');",
    'const prisma = new PrismaClient();',
    `process.stdout.write(String(prisma[${JSON.stringify(ACCESSOR)}] !== undefined));`,
  ].join('\n');

  const res = spawnSync('node', ['--input-type=module', '-e', script], {
    cwd,
    env: childEnv({ unset: ['DATABASE_URL'] }),
    encoding: 'utf8',
    timeout: 60_000,
  });

  return {
    ok: res.status === 0 && (res.stdout ?? '').trim() === 'true',
    detail: `${res.stdout ?? ''}\n${res.stderr ?? ''}`,
  };
};

/** Read every `Note` row via a short-lived generated client (row observation). */
const readNotes = ({ cwd }) => {
  const script = [
    "const { PrismaClient } = await import('@prisma/client');",
    'const prisma = new PrismaClient();',
    'const rows = await prisma.note.findMany();',
    'process.stdout.write(JSON.stringify(rows));',
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

/**
 * Minimal MCP stdio client (ONT-003/006/008 pattern) over the generated config.
 *
 * stderr is CAPTURED (and echoed) rather than inherited: it is the operator
 * channel §3.10 promises the full driver text on, and phase 2 has to read it to
 * prove the text went THERE and not to the agent.
 */
const openMcpSession = async ({ cwd, env, unset }) => {
  const child = spawn('node', [CLI, 'mcp', '--config', 'orangerail.config.mjs'], {
    cwd,
    env: childEnv({ env, unset }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    process.stderr.write(chunk);
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
      clientInfo: { name: 'ont-018-e2e', version: '0.0.0' },
    },
  });
  send({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  const callTool = async ({ name, args }) =>
    request({ method: 'tools/call', params: { name, arguments: args } });

  const listTools = async () => request({ method: 'tools/list', params: {} });

  const close = async () => {
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
  };

  /**
   * The operator line and the JSON-RPC response travel on DIFFERENT pipes, and
   * the child writing stderr first does not guarantee the parent reads it
   * first. Poll briefly, so a scheduling accident cannot turn a correct server
   * into a red scenario.
   */
  const awaitOperatorLine = async ({ correlationId, timeoutMs = 5_000 }) => {
    const deadline = Date.now() + timeoutMs;
    while (!stderr.includes(correlationId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return stderr;
  };

  return { request, callTool, listTools, close, awaitOperatorLine };
};

// ───────── phase 1 — the full governed write loop against real SQLite ─────────

console.log('[phase 1] init emits real Prisma CRUD actions + drives the governed loop (AC-1/2/3)');

prepareRunDir({ dir: RUN_PRISMA, fixture: PRISMA_FIXTURE });

const prismaInit = runCli({ args: ['init', '--no-studio', '--yes'], cwd: RUN_PRISMA });
assert({
  ok: prismaInit.status === 0,
  message: `prisma init must exit 0, got ${prismaInit.status}:\n${prismaInit.stdout}\n${prismaInit.stderr}`,
});

// AC-1: every CRUD action file is generated. This is the RED gate — pre-impl the
// Prisma scanner emits ZERO actions, so ontology/createNote.mjs does not exist.
for (const name of ACTIONS) {
  assert({
    ok: existsSync(ontologyPath({ runDir: RUN_PRISMA, name: `${name}.mjs` })),
    message: `expected generated ontology/${name}.mjs — the Prisma scanner emits no write actions (no "${name}" action exists)`,
  });
}

const createSrc = readFileSync(
  ontologyPath({ runDir: RUN_PRISMA, name: 'createNote.mjs' }),
  'utf8',
);
const updateSrc = readFileSync(
  ontologyPath({ runDir: RUN_PRISMA, name: 'updateNote.mjs' }),
  'utf8',
);
const deleteSrc = readFileSync(
  ontologyPath({ runDir: RUN_PRISMA, name: 'deleteNote.mjs' }),
  'utf8',
);

// AC-2: the execute is real (calls the client), NOT the notImplemented stub.
assert({
  ok: new RegExp(`prisma\\.${ACCESSOR}\\.create`).test(createSrc),
  message: `createNote.mjs must call prisma.${ACCESSOR}.create (a real execute), not a stub:\n${createSrc}`,
});
assert({
  ok: !/notImplemented/.test(createSrc),
  message: 'createNote.mjs must NOT use the notImplemented stub (Prisma actions execute for real)',
});
assert({
  ok: new RegExp(`prisma\\.${ACCESSOR}\\.update`).test(updateSrc),
  message: `updateNote.mjs must call prisma.${ACCESSOR}.update`,
});
assert({
  ok: new RegExp(`prisma\\.${ACCESSOR}\\.delete`).test(deleteSrc),
  message: `deleteNote.mjs must call prisma.${ACCESSOR}.delete`,
});

// AC-1 secure-by-default + AC-5 destructive marking.
assert({
  ok: /approval:\s*['"]required['"]/.test(createSrc),
  message: 'generated write actions must be policy: { approval: "required" } (secure by default)',
});
assert({
  ok: /destructive/i.test(deleteSrc),
  message:
    'deleteNote.mjs must be marked DESTRUCTIVE so a human approving sees what they authorize (AC-5)',
});

// AC-3 discover: the write actions surface as governed MCP tools.
const session1 = await openMcpSession({ cwd: RUN_PRISMA, env: DB_ENV });
const listed = await session1.listTools();
const toolNames = listed.tools.map((t) => t.name);

for (const name of ACTIONS) {
  assert({
    ok: toolNames.includes(name),
    message: `tools/list must expose the generated write action "${name}" (got: ${toolNames.join(', ')})`,
  });
}

const createTool = listed.tools.find((t) => t.name === 'createNote');
assert({
  ok: createTool !== undefined && /stage/i.test(createTool.description),
  message: `createNote must be a governed "Stage the ..." tool, got description: ${createTool?.description}`,
});

// AC-3 propose: calling the action stages it for approval (no side effect yet).
const staged = await session1.callTool({
  name: 'createNote',
  args: { title: 'e2e note', body: 'created via the governed write loop' },
});
const approvalId = staged.structuredContent?.approvalId;
assert({
  ok: staged.structuredContent?.status === 'approval_pending' && typeof approvalId === 'string',
  message: `createNote call must stage (approval_pending + approvalId), got ${JSON.stringify(staged)}`,
});
await session1.close();

// AC-3 audited + human approves via the shipped CLI.
const approvalsList = runCli({
  args: ['approvals', 'list', '--config', 'orangerail.config.mjs'],
  cwd: RUN_PRISMA,
});
assert({
  ok: approvalsList.status === 0 && approvalsList.stdout.includes(approvalId),
  message: `approvals list must show the staged ${approvalId}:\n${approvalsList.stdout}\n${approvalsList.stderr}`,
});

const approve = runCli({
  args: ['approvals', 'approve', approvalId, '--config', 'orangerail.config.mjs'],
  cwd: RUN_PRISMA,
});
assert({
  ok: approve.status === 0,
  message: `approvals approve must succeed, got ${approve.status}:\n${approve.stdout}\n${approve.stderr}`,
});

// Capability probe: only the DB-dependent execute+observe block is gated.
const push = prismaDbPush({ cwd: RUN_PRISMA });

if (push.ok) {
  const session2 = await openMcpSession({ cwd: RUN_PRISMA, env: DB_ENV });

  const executed = await session2.callTool({ name: 'check_approval', args: { approvalId } });
  assert({
    ok: executed.structuredContent?.status === 'executed',
    message: `check_approval must execute the approved write exactly once, got ${JSON.stringify(executed)}`,
  });

  const rows = readNotes({ cwd: RUN_PRISMA });
  assert({
    ok: rows.status === 0,
    message: `reading Note rows via a short-lived client failed (exit ${rows.status}):\n${rows.stderr}`,
  });
  const parsed = JSON.parse(rows.stdout);
  assert({
    ok: parsed.length === 1 && parsed[0].title === 'e2e note',
    message: `the approved createNote must be observable in the DB (exactly one row titled "e2e note"), got ${rows.stdout}`,
  });

  const reCheck = await session2.callTool({ name: 'check_approval', args: { approvalId } });
  assert({
    ok: reCheck.structuredContent?.status === 'consumed',
    message: `a re-call after execution must be denied as consumed, got ${JSON.stringify(reCheck)}`,
  });

  await session2.close();
  console.log(
    '[phase 1] execute+observe ran against real SQLite (row created, consume-once enforced)',
  );
} else {
  console.error(
    '⚠️  ONT-018 e2e: LOUD SKIP — `prisma db push` could not run in this environment, so the ' +
      'execute+observe sub-assertions (row observably created, consume-once) are SKIPPED (DEV-01, ' +
      'plan §4). Discover, staging, approval, and audit-verify still ran. This is NOT a silent pass — ' +
      `justify in the report. Probe detail:\n${push.detail}`,
  );
}

// AC-3 audit: the resulting chain verifies clean regardless of the capability gate.
const auditVerify = runCli({
  args: ['audit', 'verify', '--config', 'orangerail.config.mjs'],
  cwd: RUN_PRISMA,
});
assert({
  ok: auditVerify.status === 0,
  message: `audit verify must pass over the governed chain, got ${auditVerify.status}:\n${auditVerify.stdout}\n${auditVerify.stderr}`,
});

console.log('[phase 1] OK');

// ───────── phase 2 — no DATABASE_URL: actionable diagnostic, not a crash ──────

console.log('[phase 2] a write with no DATABASE_URL fails with an actionable diagnostic (AC-4)');

prepareRunDir({ dir: RUN_NODB, fixture: PRISMA_FIXTURE });

const nodbInit = runCli({ args: ['init', '--no-studio', '--yes'], cwd: RUN_NODB });
assert({
  ok: nodbInit.status === 0,
  message: `no-db init must exit 0, got ${nodbInit.status}:\n${nodbInit.stdout}\n${nodbInit.stderr}`,
});

// ── the unconfigured state is CONSTRUCTED here, not inherited ────────────────
//
// This phase used to reach "no database" by deleting DATABASE_URL from the
// child env and hoping for the best. Two things were wrong with that. It leaned
// on the AMBIENT environment, so a runner that happened to export DATABASE_URL
// silently turned it into a different test (and the merge in `openMcpSession`
// put an ambient value straight back). And it left the OTHER precondition
// unstated: whether `@prisma/client` was generated at all decides which of
// orangerail's diagnostics fires, and that depended on whether an earlier
// scenario had run `prisma db push` in this workspace.
//
// So both halves are now positively established and asserted:
//   1. the client IS generated and DOES carry `note` — `prisma generate` needs
//      no database, so this is buildable here, and it removes
//      "client missing" / "model missing" from the possible outcomes;
//   2. DATABASE_URL is removed AFTER the env merge and re-checked.
// What remains is exactly one fault: a datasource with no connection URL.
const generated = prismaGenerate({ cwd: RUN_NODB });
assert({
  ok: generated.ok,
  message: `phase 2 needs a generated Prisma client to isolate the unconfigured-datasource case; \`prisma generate\` failed:\n${generated.detail}`,
});

const carries = prismaClientCarriesModel({ cwd: RUN_NODB });
assert({
  ok: carries.ok,
  message: `phase 2 precondition: the generated client must expose \`prisma.${ACCESSOR}\`, otherwise this phase would be testing the schema-mismatch diagnostic instead:\n${carries.detail}`,
});

const NO_DB = ['DATABASE_URL'];
assert({
  ok: childEnv({ unset: NO_DB }).DATABASE_URL === undefined,
  message: 'phase 2 precondition: the child environment must carry no DATABASE_URL',
});

// No `prisma db push` either — there is no database file to connect to even if
// a URL appeared.
assert({
  ok: !existsSync(join(RUN_NODB, 'ont-018.db')),
  message: 'phase 2 precondition: the no-db run dir must have no database file',
});

const nodbSession = await openMcpSession({ cwd: RUN_NODB, unset: NO_DB });
const nodbStaged = await nodbSession.callTool({
  name: 'createNote',
  args: { title: 'no-db', body: 'should fail at execute' },
});
const nodbApprovalId = nodbStaged.structuredContent?.approvalId;
assert({
  ok:
    nodbStaged.structuredContent?.status === 'approval_pending' &&
    typeof nodbApprovalId === 'string',
  message: `createNote must still stage without a DB, got ${JSON.stringify(nodbStaged)}`,
});
await nodbSession.close();

const nodbApprove = runCli({
  args: ['approvals', 'approve', nodbApprovalId, '--config', 'orangerail.config.mjs'],
  cwd: RUN_NODB,
  unset: NO_DB,
});
assert({
  ok: nodbApprove.status === 0,
  message: `no-db approve must succeed, got ${nodbApprove.status}:\n${nodbApprove.stderr}`,
});

const nodbSession2 = await openMcpSession({ cwd: RUN_NODB, unset: NO_DB });
const nodbExecuted = await nodbSession2.callTool({
  name: 'check_approval',
  args: { approvalId: nodbApprovalId },
});
const nodbOperatorLog = await nodbSession2.awaitOperatorLine({
  correlationId: nodbExecuted.structuredContent?.correlationId ?? '',
});
await nodbSession2.close();

assert({
  ok: nodbExecuted.isError === true,
  message: `executing a write with no DATABASE_URL must fail (not succeed), got ${JSON.stringify(nodbExecuted)}`,
});

// ── what the AGENT is told (ONT-045) ─────────────────────────────────────────
//
// ONT-032 redacts every datasource error, and it is right to: a driver message
// names credentials, hosts, tables and row values. But that also flattened
// orangerail's OWN configuration diagnostics into "the datasource rejected the
// action", which is useless to an agent on a first run. The fix is not a leak —
// it is a CLASSIFICATION: core tags the failure with a code from a closed set,
// and the transport prints its own sentence for that code. So the assertions
// here are (a) the class is right, (b) the sentence is actionable, and (c) the
// driver's own text is still nowhere in the response.
const nodbResponse = JSON.stringify(nodbExecuted);
assert({
  ok: nodbExecuted.structuredContent?.status === 'failed',
  message: `the no-db failure must be a typed execute failure, got: ${nodbResponse}`,
});
assert({
  ok: nodbExecuted.structuredContent?.diagnostic === 'datasource_not_configured',
  message: `the no-db failure must be CLASSIFIED as datasource_not_configured (this is the one fault the phase constructed), got: ${nodbResponse}`,
});

const nodbMessage = nodbExecuted.content?.[0]?.text ?? '';
assert({
  ok: nodbMessage.includes('DATABASE_URL'),
  message: `the no-db diagnostic must tell the agent how to wire DATABASE_URL, got: ${nodbMessage}`,
});
assert({
  ok: /not configured/i.test(nodbMessage),
  message: `the no-db diagnostic must say the datasource is not configured, got: ${nodbMessage}`,
});
assert({
  ok: nodbMessage.includes(nodbExecuted.structuredContent?.correlationId ?? ' '),
  message: `the no-db diagnostic must carry the correlationId an operator looks the full text up by, got: ${nodbMessage}`,
});

// The redaction is NOT relaxed: Prisma's own text, the schema excerpt, and the
// file path it quotes must not appear anywhere in the agent's response.
for (const leak of ['Environment variable not found', 'schema.prisma', 'prisma.note.create']) {
  assert({
    ok: !nodbResponse.includes(leak),
    message: `the response must not carry the raw datasource text ("${leak}"): ${nodbResponse}`,
  });
}

// ...and the operator still gets all of it, under the same correlationId.
assert({
  ok:
    nodbOperatorLog.includes('Environment variable not found: DATABASE_URL') &&
    nodbOperatorLog.includes(nodbExecuted.structuredContent?.correlationId ?? ' '),
  message: `the operator sink must carry the FULL Prisma text under the same correlationId — stderr was:\n${nodbOperatorLog}`,
});

// AC-4 docs half: the generated AGENTS.md documents the Prisma action truthfully
// — approval-required, with NO false "[stub — not implemented]" claim.
const nodbAgentsMd = join(RUN_NODB, '.orangerail', 'generated', 'AGENTS.md');
assert({
  ok: existsSync(nodbAgentsMd),
  message: '.orangerail/generated/AGENTS.md was not generated',
});
const nodbDocs = readFileSync(nodbAgentsMd, 'utf8');
assert({
  ok: nodbDocs.includes('createNote'),
  message: 'AGENTS.md must document the generated createNote action',
});
assert({
  ok: /\[approval required\]/.test(nodbDocs),
  message: 'AGENTS.md must mark the Prisma write actions as [approval required]',
});
// AC-4 honesty: the Prisma action must not be DOCUMENTED as a stub. docs-gen
// emits the per-action marker "[stub — not implemented]" (governanceLines) only
// when an action's execute is `notImplemented`; a real Prisma execute is not a
// stub, so that per-action marker is absent — assert its absence.
// NOTE: the generic "How to act" narrative carries one general sentence about
// how a not-implemented stub action would behave — shared governance prose that
// is byte-identical to every governed server (ONT-008 asserts its PRESENCE).
// That sentence is not a claim about THIS domain's actions, so the check is
// scoped to the per-action `[stub` marker, matching AC-4's actual guarantee.
assert({
  ok: !/\[stub/i.test(nodbDocs),
  message:
    'AGENTS.md must NOT carry a per-action "[stub — not implemented]" marker for the Prisma path — the execute is real (AC-4)',
});

console.log('[phase 2] OK');

// ───────── phase 3 — OpenAPI action output is byte-identical (AC-6) ───────────

console.log(
  '[phase 3] OpenAPI-source action file is byte-identical to the pre-ONT-018 reference (AC-6)',
);

prepareRunDir({ dir: RUN_OPENAPI, fixture: OPENAPI_FIXTURE });

const openapiInit = runCli({ args: ['init', '--no-studio', '--yes'], cwd: RUN_OPENAPI });
assert({
  ok: openapiInit.status === 0,
  message: `openapi init must exit 0, got ${openapiInit.status}:\n${openapiInit.stdout}\n${openapiInit.stderr}`,
});

const emittedOpenApi = readFileSync(
  ontologyPath({ runDir: RUN_OPENAPI, name: 'cancelBooking.mjs' }),
  'utf8',
);
const referenceOpenApi = readFileSync(OPENAPI_REFERENCE, 'utf8');

assert({
  ok: /execute:\s*notImplemented/.test(emittedOpenApi),
  message:
    'the OpenAPI action must remain a notImplemented stub (its real-execution is a follow-up)',
});
assert({
  ok: emittedOpenApi === referenceOpenApi,
  message:
    'the OpenAPI action file changed — the Prisma write-action feature must not touch the OpenAPI emitter (AC-6 byte-identity)',
});

console.log('[phase 3] OK');

console.log(`ONT-018 e2e scenario: all phases passed (${MODEL} governed write loop)`);
process.exit(0);
