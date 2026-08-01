/**
 * ONT-071 e2e driver — the write that landed and was never recorded says so, and
 * the studio survives a row it cannot print (ticket section 5).
 *
 * Pure Node stdlib: it drives the SHIPPED CLI (packages/cli/dist/main.js), speaks
 * newline-delimited JSON-RPC to `orangerail mcp` over stdio exactly like the
 * ONT-069 driver, and boots the SHIPPED `orangerail studio` over HTTP.
 *
 * Four phases:
 *   1. An UNGOVERNED action whose terminal record cannot be written. The agent
 *      must be told the write happened, that nothing recorded it, and not to
 *      retry — with the correlationId and without the store error.
 *   2. The same outcome on a GATED action, after a human approved it. The
 *      approval is spent and the write is done, so the sentence must not read as
 *      an invitation to stage it again.
 *   3. `orangerail studio` over an ontology whose rows carry a BigInt, a
 *      structure that points at itself, and a BigInt in the field the snapshot
 *      SORTS on. The page must be served, every row must survive, each
 *      unprintable field must be named, and the process must exit 0.
 *   4. The ordinary path is untouched: a plain read tool still answers.
 *
 * RED (against the pre-fix shipped artifacts):
 *   - Phases 1 and 2: `audit_unrecorded` has no branch, so it falls to `default`
 *     and the agent is told `"Unexpected stage/execute result."` with status
 *     `error` — a failure report for a write that already happened, which is an
 *     instruction to retry it.
 *   - Phase 3: `JSON.stringify` throws inside the `/api/instances` handler and
 *     ends the process; and before it gets that far the BigInt sort key throws
 *     in the comparator, emptying the whole snapshot.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const CONFIG = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-071', 'config.mjs');
const PORT = 4891;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;

const assert = ({ ac, ok, message }) => {
  if (!ok) {
    failures += 1;
    console.error(`ASSERTION FAILED [${ac}]: ${message}`);
  }
};

/** Runs an `orangerail` CLI command to completion and captures its output. */
const runCli = ({ args, env }) => {
  const res = spawnSync('node', [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** Minimal MCP stdio client session (one session per server process). */
const openSession = async ({ env }) => {
  const child = spawn('node', [CLI, 'mcp', '--config', CONFIG], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8');
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
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = null;
        }

        if (msg && msg.id !== undefined && pending.has(msg.id)) {
          const resolve = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      }

      idx = buffer.indexOf('\n');
    }
  });

  const send = ({ payload }) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = async ({ method, params }) => {
    const id = nextId;
    nextId += 1;

    const msg = await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ error: { message: `MCP request timed out: ${method}` } }),
        20_000,
      );
      pending.set(id, (received) => {
        clearTimeout(timer);
        resolve(received);
      });
      send({ payload: { jsonrpc: '2.0', id, method, params } });
    });

    if (msg.error) {
      throw new Error(`MCP error for ${method}: ${JSON.stringify(msg.error)}`);
    }

    return msg.result;
  };

  const exited = new Promise((resolve) => child.on('exit', resolve));

  await request({
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ont-071-e2e', version: '0.0.0' },
    },
  });
  send({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  return {
    callTool: async ({ name, args }) =>
      request({ method: 'tools/call', params: { name, arguments: args } }),
    stderr: () => stderrText,
    close: async () => {
      child.stdin.end();
      child.kill('SIGTERM');
      await exited;
    },
  };
};

/** One MCP tool call in its own server process, as `identity`. */
const callAs = async ({ env, identity, name, args }) => {
  const session = await openSession({ env: { ...env, ORANGERAIL_E2E_IDENTITY: identity } });
  const result = await session.callTool({ name, args });
  const stderr = session.stderr();
  await session.close();

  return { result, stderr };
};

const readAudit = ({ storeDir }) =>
  readFileSync(join(storeDir, 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

const readLedger = ({ dataDir }) => {
  const path = join(dataDir, 'side-effects.jsonl');
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
};

const setupPhaseDir = ({ sandbox, phase }) => {
  const storeDir = join(sandbox, `store-${phase}`);
  const dataDir = join(sandbox, `data-${phase}`);
  mkdirSync(dataDir, { recursive: true });

  return {
    storeDir,
    dataDir,
    env: { ORANGERAIL_E2E_STORE: storeDir, ORANGERAIL_E2E_DATA: dataDir },
  };
};

const messageOf = ({ result }) => result?.content?.[0]?.text ?? '';

/**
 * The sentence has to carry BOTH halves and the instruction. Asserted as
 * separate facts so a rewrite that quietly drops one fails on that one.
 */
const assertSaysAllOfIt = ({ ac, message, correlationId }) => {
  assert({
    ac,
    ok: message.includes('already landed'),
    message: `the sentence does not say the write happened: ${message}`,
  });
  assert({
    ac,
    ok: message.includes('NOT recorded'),
    message: `the sentence does not say the chain holds nothing: ${message}`,
  });
  assert({
    ac,
    ok: message.includes('Do NOT retry'),
    message: `the sentence does not tell the agent to stop: ${message}`,
  });
  assert({
    ac: 'AC-2',
    ok: correlationId !== '' && message.includes(correlationId),
    message: `the sentence does not name the correlationId: ${message}`,
  });
  assert({
    ac: 'AC-2',
    ok: !message.includes('EACCES') && !message.includes('audit.jsonl'),
    message: `the sentence leaks store internals: ${message}`,
  });
};

const assertChainHasNoTerminal = ({ ac, storeDir }) => {
  const phases = readAudit({ storeDir }).map((record) => record.phase);

  assert({
    ac,
    ok: phases.includes('execution_started'),
    message: `the attempt is not on the chain at all: ${phases.join(', ')}`,
  });
  assert({
    ac,
    ok: !phases.includes('succeeded') && !phases.includes('terminal_unrecorded'),
    message: `the terminal record landed, so this is not the outcome under test: ${phases.join(', ')}`,
  });
};

// ---------------------------------------------------------------------------
// Phase 1 (AC-1/AC-2): an ungoverned action whose outcome could not be recorded.
// ---------------------------------------------------------------------------
const phase1 = async ({ sandbox }) => {
  console.log('Phase 1 (AC-1/AC-2): an ungoverned write that nothing recorded');
  const { storeDir, dataDir, env } = setupPhaseDir({ sandbox, phase: 'p1' });

  const { result, stderr } = await callAs({
    env,
    identity: 'alice',
    name: 'mark_widget',
    args: { widgetId: 'w-1' },
  });
  chmodSync(join(storeDir, 'audit.jsonl'), 0o644);

  const message = messageOf({ result });
  const structured = result?.structuredContent ?? {};
  const correlationId = String(structured.correlationId ?? '');

  assert({
    ac: 'AC-1',
    ok: readLedger({ dataDir }).length === 1,
    message: 'the side effect did not run exactly once',
  });
  assert({
    ac: 'AC-1',
    ok: structured.status === 'audit_unrecorded',
    message: `expected a distinct status, got ${JSON.stringify(structured)}`,
  });
  assert({
    ac: 'AC-1',
    ok: !message.includes('Unexpected stage result.'),
    message: 'the agent was handed the default branch for a write that happened',
  });
  assert({
    ac: 'AC-1',
    ok: result?.isError === true,
    message: 'the outcome was reported as an ordinary success',
  });
  assertSaysAllOfIt({ ac: 'AC-1', message, correlationId });
  assertChainHasNoTerminal({ ac: 'AC-1', storeDir });

  // The result the action returned comes back, so wanting it is never a reason
  // to run the write a second time.
  assert({
    ac: 'AC-1',
    ok: JSON.stringify(structured.result ?? null) === JSON.stringify({ marked: 'w-1' }),
    message: `the action result was not carried back: ${JSON.stringify(structured)}`,
  });

  // The withheld text survives where an operator can read it, keyed by the id
  // the agent was given. For this status that sink is the ONLY place it can be:
  // the append is what failed.
  assert({
    ac: 'AC-2',
    ok: stderr.includes(correlationId) && stderr.includes('audit_unrecorded'),
    message: `the operator sink did not report the failure: ${stderr}`,
  });
};

// ---------------------------------------------------------------------------
// Phase 2 (section 4): the same outcome on a GATED action, after approval.
// ---------------------------------------------------------------------------
const phase2 = async ({ sandbox }) => {
  console.log('Phase 2 (edge case): a gated write that nothing recorded');
  const { storeDir, dataDir, env } = setupPhaseDir({ sandbox, phase: 'p2' });

  const staged = await callAs({
    env,
    identity: 'alice',
    name: 'apply_widget',
    args: { widgetId: 'w-2' },
  });
  const approvalId = staged.result?.structuredContent?.approvalId;

  assert({
    ac: 'AC-1',
    ok: typeof approvalId === 'string',
    message: `gated staging yielded no approvalId: ${JSON.stringify(staged.result)}`,
  });

  const approve = runCli({
    args: ['approvals', 'approve', String(approvalId), '--config', CONFIG],
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'carol' },
  });
  assert({ ac: 'AC-1', ok: approve.status === 0, message: `approve failed: ${approve.stderr}` });

  const { result } = await callAs({
    env,
    identity: 'alice',
    name: 'check_approval',
    args: { approvalId },
  });
  chmodSync(join(storeDir, 'audit.jsonl'), 0o644);

  const message = messageOf({ result });
  const structured = result?.structuredContent ?? {};

  assert({
    ac: 'AC-1',
    ok: readLedger({ dataDir }).length === 1,
    message: 'the approved write did not run exactly once',
  });
  assert({
    ac: 'AC-1',
    ok: structured.status === 'audit_unrecorded',
    message: `expected a distinct status, got ${JSON.stringify(structured)}`,
  });
  assert({
    ac: 'AC-1',
    ok: !message.includes('Unexpected execute result.'),
    message: 'the agent was handed the default branch for a write that happened',
  });
  assertSaysAllOfIt({
    ac: 'AC-1',
    message,
    correlationId: String(structured.correlationId ?? ''),
  });
  assertChainHasNoTerminal({ ac: 'AC-1', storeDir });

  // The approval is consumed and the write is done. Re-staging is not a retry,
  // it is a second authorization for a second write.
  assert({
    ac: 'AC-1',
    ok: message.includes('do NOT re-stage'),
    message: `the sentence leaves re-staging open: ${message}`,
  });
  assert({
    ac: 'AC-1',
    ok: !message.includes('stage the action again'),
    message: `the sentence invites the approval to be run again: ${message}`,
  });

  const listed = runCli({ args: ['approvals', 'list', '--config', CONFIG], env });
  assert({
    ac: 'AC-1',
    ok: !listed.stdout.includes(String(approvalId)),
    message: 'the consumed approval is still offered as pending',
  });
};

// ---------------------------------------------------------------------------
// Phase 3 (AC-3/AC-4): the studio over rows it cannot print.
// ---------------------------------------------------------------------------
const waitFor = async ({ label, fn, timeoutMs = 30_000 }) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await fn()) {
      return true;
    }
    await new Promise((done) => setTimeout(done, 200));
  }

  assert({ ac: 'AC-3', ok: false, message: `timed out waiting for ${label}` });

  return false;
};

const phase3 = async ({ sandbox }) => {
  console.log('Phase 3 (AC-3/AC-4): the studio serves a row JSON.stringify throws on');
  const { env } = setupPhaseDir({ sandbox, phase: 'p3' });

  const child = spawn(
    'node',
    [CLI, 'studio', '--config', CONFIG, '--port', String(PORT), '--no-open'],
    { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] },
  );

  let exitedEarly = false;
  child.on('exit', () => {
    exitedEarly = true;
  });

  const up = await waitFor({
    label: 'the studio to answer /api/registry',
    fn: async () => {
      if (exitedEarly) {
        return true;
      }

      const res = await fetch(`${BASE}/api/registry`).catch(() => undefined);

      return res !== undefined && res.status === 200;
    },
  });

  if (!up || exitedEarly) {
    assert({ ac: 'AC-3', ok: false, message: 'the studio exited before it served anything' });
    return;
  }

  const res = await fetch(`${BASE}/api/instances`).catch(() => undefined);
  assert({
    ac: 'AC-3',
    ok: res !== undefined && res.status === 200,
    message: `GET /api/instances did not answer 200 (got ${res ? res.status : 'nothing'})`,
  });

  const body = res === undefined ? {} : await res.json();
  const employees = body.employees ?? [];
  const listed = body.unrenderable ?? [];
  const named = ({ path }) => listed.some((field) => field.path === path);

  // Every row survives — including the one whose SORT KEY could not be printed,
  // which used to empty the entire snapshot.
  assert({
    ac: 'AC-3',
    ok: employees.length === 3,
    message: `expected 3 rows, got ${employees.length}: ${JSON.stringify(employees)}`,
  });
  assert({
    ac: 'AC-3',
    ok: JSON.stringify(employees).includes('UNRENDERABLE'),
    message: 'no row names the field it could not show',
  });
  assert({
    ac: 'AC-3',
    ok: named({ path: 'employee[acc_a].storyPointsTotal' }),
    message: `the bigint column is not named: ${JSON.stringify(listed)}`,
  });
  assert({
    ac: 'AC-3',
    ok: named({ path: 'employee[acc_b].self' }),
    message: `the circular field is not named: ${JSON.stringify(listed)}`,
  });
  // Named positionally, because the key is the very thing that could not be
  // printed — there is no other honest handle for that row.
  assert({
    ac: 'AC-3',
    ok: named({ path: 'employee[#2].accountId' }),
    message: `the unprintable sort key is not named: ${JSON.stringify(listed)}`,
  });

  // The fields that WERE printable are still there verbatim, so a marker never
  // takes its siblings with it.
  assert({
    ac: 'AC-3',
    ok: employees.some((row) => row.displayName === 'Ann' && row.ticketCount === 4),
    message: `a row lost the fields that were printable: ${JSON.stringify(employees)}`,
  });

  // The page itself is served, which is the thing an operator opens.
  const page = await fetch(BASE).catch(() => undefined);
  assert({
    ac: 'AC-3',
    ok: page !== undefined && page.status === 200,
    message: `the studio page did not render (got ${page ? page.status : 'nothing'})`,
  });
  assert({
    ac: 'AC-3',
    ok: page !== undefined && (await page.text()).includes('<div id="root">'),
    message: 'the served page is not the studio app',
  });

  child.kill('SIGTERM');
  await waitFor({
    label: 'the studio process to exit',
    timeoutMs: 10_000,
    fn: () => child.exitCode !== null || child.signalCode !== null,
  });

  assert({
    ac: 'AC-3',
    ok: child.exitCode === 0,
    message: `the studio did not exit 0 (code ${child.exitCode}, signal ${child.signalCode})`,
  });
};

const main = async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ont-071-e2e-'));

  await phase1({ sandbox });
  await phase2({ sandbox });
  await phase3({ sandbox });

  if (failures > 0) {
    console.error(`\nONT-071 e2e: ${failures} assertion(s) failed`);
    process.exit(1);
  }

  console.log('\nONT-071 e2e: all assertions passed');
};

await main();
