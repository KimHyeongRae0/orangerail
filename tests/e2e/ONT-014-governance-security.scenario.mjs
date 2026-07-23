/**
 * ONT-014 e2e driver - governance security hardening (ticket AC-1..AC-7).
 *
 * Pure Node stdlib (no Playwright, no browser): it drives the SHIPPED CLI
 * (packages/cli/dist/main.js), speaks newline-delimited JSON-RPC to
 * `orangerail mcp` over stdio exactly like the ONT-003 driver, and reads/mutates
 * the store files directly to replay the audit-truncation PoC.
 *
 * Seven phases, one per AC. Deterministic: no Date.now / random controls flow;
 * control state (the where boom flag, tail truncation) is explicit file I/O.
 *
 * RED (against the pre-fix shipped CLI/MCP) - these assertions FAIL today,
 * proving the security gaps:
 *   - Phase 1/2: tail-truncating a completed run leaves `audit verify` clean
 *     (no anchored head, auto actions have no started->terminal cross-check).
 *   - Phase 4: a no-adapter MCP server treats callers as the all-roles
 *     local-dev identity, so an authenticated read and a governed staging both
 *     succeed instead of being denied.
 *   - Phase 5: core `approve` never compares approver to requester, so a
 *     self-approval succeeds.
 *   - Phase 6: anonymous `check_approval` triggers execution; a throwing
 *     functional `where` escapes uncaught with no resolve_error audit record.
 * Phase 3 and Phase 7 assert clean-stays-clean and pass in both states (no
 * false positive / no regression guards).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-014');

const ADAPTER = join(FIXTURES, 'config-adapter.mjs');
const NOADAPTER = join(FIXTURES, 'config-noadapter.mjs');
const DEVOPTIN = join(FIXTURES, 'config-devoptin.mjs');

let failures = 0;

const fail = ({ ac, message }) => {
  failures += 1;
  console.error(`ASSERTION FAILED [${ac}]: ${message}`);
};

const assert = ({ ac, ok, message }) => {
  if (!ok) {
    fail({ ac, message });
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

/**
 * Minimal MCP stdio client session (copied from the ONT-003 driver). One
 * session per server process; closing the session ends the server. Exposes a
 * `callToolSafe` that never throws so a handler that crashes (an uncaught
 * throw becoming a JSON-RPC error) is observable as `{ error }` rather than
 * aborting the phase.
 */
const openSession = async ({ config, env }) => {
  const child = spawn('node', [CLI, 'mcp', '--config', config], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
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

  const requestRaw = ({ method, params }) => {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ error: { message: `MCP request timed out: ${method}` } }),
        20_000,
      );
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      send({ payload: { jsonrpc: '2.0', id, method, params } });
    });
  };

  const request = async ({ method, params }) => {
    const msg = await requestRaw({ method, params });
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
      clientInfo: { name: 'ont-014-e2e', version: '0.0.0' },
    },
  });
  send({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  const close = async () => {
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
  };

  const callTool = async ({ name, args }) =>
    request({ method: 'tools/call', params: { name, arguments: args } });

  /** Like callTool but returns `{ result }` or `{ error }` instead of throwing. */
  const callToolSafe = async ({ name, args }) => {
    const msg = await requestRaw({ method: 'tools/call', params: { name, arguments: args } });
    return msg.error ? { error: msg.error } : { result: msg.result };
  };

  const listTools = async () => request({ method: 'tools/list', params: {} });

  return { callTool, callToolSafe, listTools, close };
};

const readAudit = ({ storeDir }) =>
  readFileSync(join(storeDir, 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

/** Drop the last `drop` non-empty lines from a JSONL file (tail truncation). */
const truncateTail = ({ path, drop }) => {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const kept = lines.slice(0, Math.max(0, lines.length - drop));
  writeFileSync(path, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
};

/** Parse the record count from an `audit verify` OK line. */
const verifyCount = ({ stdout }) => {
  const match = /(\d+) record/.exec(stdout);
  return match ? Number(match[1]) : -1;
};

/** Stage a governed action over MCP as `identity`; return its approvalId. */
const stageGoverned = async ({ config, env, identity, name, args }) => {
  const session = await openSession({
    config,
    env: { ...env, ORANGERAIL_E2E_IDENTITY: identity },
  });
  const staged = await session.callTool({ name, args });
  await session.close();

  return {
    status: staged.structuredContent?.status,
    approvalId: staged.structuredContent?.approvalId,
  };
};

const setupPhaseDir = ({ sandbox, phase, backend }) => {
  const storeDir = join(sandbox, `store-${phase}`);
  const dataDir = join(sandbox, `data-${phase}`);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'backend.json'), JSON.stringify(backend));

  return {
    storeDir,
    dataDir,
    env: { ORANGERAIL_E2E_STORE: storeDir, ORANGERAIL_E2E_DATA: dataDir },
  };
};

const DRAFT_DOC = [{ id: 'doc-1', title: 'Launch plan', status: 'draft' }];

// ---------------------------------------------------------------------------
// Phase 1 (AC-1): audit tail-truncation must be detected (the H-AUDIT PoC).
// ---------------------------------------------------------------------------
const phase1 = async ({ sandbox }) => {
  console.log('Phase 1 (AC-1): audit truncation detection (PoC replay)');
  const { storeDir, env } = setupPhaseDir({ sandbox, phase: 'p1', backend: DRAFT_DOC });

  const staged = await stageGoverned({
    config: ADAPTER,
    env,
    identity: 'alice',
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'ship it' },
  });
  assert({
    ac: 'AC-1',
    ok: staged.status === 'approval_pending' && typeof staged.approvalId === 'string',
    message: `governed staging did not yield an approvalId: ${JSON.stringify(staged)}`,
  });

  // A distinct editor approves (genuine separation of duty), then execution
  // completes on re-check - one linear chain of staged/approved/started/succeeded.
  const approve = runCli({
    args: ['approvals', 'approve', staged.approvalId, '--config', ADAPTER],
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'carol' },
  });
  assert({ ac: 'AC-1', ok: approve.status === 0, message: `approve failed: ${approve.stderr}` });

  const exec = await openSession({
    config: ADAPTER,
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'alice' },
  });
  const checked = await exec.callTool({
    name: 'check_approval',
    args: { approvalId: staged.approvalId },
  });
  await exec.close();
  assert({
    ac: 'AC-1',
    ok: checked.structuredContent?.status === 'executed',
    message: `expected executed, got ${JSON.stringify(checked)}`,
  });

  // Snapshot: a clean, complete run verifies OK.
  const clean = runCli({ args: ['audit', 'verify', '--config', ADAPTER], env });
  assert({
    ac: 'AC-1',
    ok: clean.status === 0,
    message: `clean run failed verify before tampering: ${clean.stderr}`,
  });

  const before = readAudit({ storeDir });
  assert({
    ac: 'AC-1',
    ok: before.length >= 4,
    message: `expected >=4 audit records before truncation, got ${before.length}`,
  });

  // The PoC: drop the execution_started + succeeded tail from audit.jsonl AND
  // the trailing consumed event from approvals.jsonl, consistently.
  truncateTail({ path: join(storeDir, 'audit.jsonl'), drop: 2 });
  truncateTail({ path: join(storeDir, 'approvals.jsonl'), drop: 1 });

  const tampered = runCli({ args: ['audit', 'verify', '--config', ADAPTER], env });
  assert({
    ac: 'AC-1',
    ok: tampered.status !== 0,
    message:
      'audit verify stayed CLEAN after tail-truncating a completed governed run ' +
      '(no anchored head detects the erased execution) - the H-AUDIT gap',
  });
};

// ---------------------------------------------------------------------------
// Phase 2 (AC-2): an auto action's truncated terminal must be flagged.
// ---------------------------------------------------------------------------
const phase2 = async ({ sandbox }) => {
  console.log('Phase 2 (AC-2): auto-action started-without-terminal detection');
  const { storeDir, env } = setupPhaseDir({ sandbox, phase: 'p2', backend: DRAFT_DOC });

  const session = await openSession({
    config: ADAPTER,
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'alice' },
  });
  const ran = await session.callTool({ name: 'touch_counter', args: { label: 'tick' } });
  await session.close();
  assert({
    ac: 'AC-2',
    ok: ran.structuredContent?.status === 'executed',
    message: `auto action did not execute: ${JSON.stringify(ran)}`,
  });

  const before = readAudit({ storeDir });
  assert({
    ac: 'AC-2',
    ok:
      before.some((r) => r.phase === 'execution_started') &&
      before.some((r) => r.phase === 'succeeded'),
    message: `expected execution_started + succeeded auto records, got ${JSON.stringify(before.map((r) => r.phase))}`,
  });

  // Drop the terminal (succeeded) auto record: an execution that started but
  // has no terminal, with NO approvalId to cross-check today.
  truncateTail({ path: join(storeDir, 'audit.jsonl'), drop: 1 });

  const tampered = runCli({ args: ['audit', 'verify', '--config', ADAPTER], env });
  assert({
    ac: 'AC-2',
    ok: tampered.status !== 0,
    message:
      'audit verify stayed CLEAN after truncating an auto action terminal record ' +
      '(auto actions have no started->terminal cross-check) - the H-AUDIT auto gap',
  });
};

// ---------------------------------------------------------------------------
// Phase 3 (AC-3): a valid store verifies clean across restarts; the record
// count advances on legitimate appends (no false positive). Passes in RED too.
// ---------------------------------------------------------------------------
const phase3 = async ({ sandbox }) => {
  console.log('Phase 3 (AC-3): no false positive on repeated valid runs');
  const { env } = setupPhaseDir({ sandbox, phase: 'p3', backend: DRAFT_DOC });

  // A complete governed loop (interleaved MCP + CLI writers).
  const staged = await stageGoverned({
    config: ADAPTER,
    env,
    identity: 'alice',
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'first' },
  });
  runCli({
    args: ['approvals', 'approve', staged.approvalId, '--config', ADAPTER],
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'carol' },
  });
  const exec = await openSession({
    config: ADAPTER,
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'alice' },
  });
  await exec.callTool({ name: 'check_approval', args: { approvalId: staged.approvalId } });
  await exec.close();

  const first = runCli({ args: ['audit', 'verify', '--config', ADAPTER], env });
  assert({
    ac: 'AC-3',
    ok: first.status === 0,
    message: `valid store failed verify: ${first.stderr}`,
  });
  const countA = verifyCount({ stdout: first.stdout });

  // A NEW process appends more legitimate records (an auto action).
  const session = await openSession({
    config: ADAPTER,
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'alice' },
  });
  await session.callTool({ name: 'touch_counter', args: { label: 'again' } });
  await session.close();

  const second = runCli({ args: ['audit', 'verify', '--config', ADAPTER], env });
  assert({
    ac: 'AC-3',
    ok: second.status === 0,
    message: `verify false-positived on a valid appended store: ${second.stderr}`,
  });
  const countB = verifyCount({ stdout: second.stdout });
  assert({
    ac: 'AC-3',
    ok: countB > countA,
    message: `record count did not advance across a restart append (${countA} -> ${countB})`,
  });
};

// ---------------------------------------------------------------------------
// Phase 4 (AC-4): a no-adapter MCP server must deny (secure default).
// ---------------------------------------------------------------------------
const phase4 = async ({ sandbox }) => {
  console.log('Phase 4 (AC-4): no-adapter MCP secure default (deny-first)');
  const { env } = setupPhaseDir({ sandbox, phase: 'p4', backend: DRAFT_DOC });

  const server = await openSession({ config: NOADAPTER, env });

  const read = await server.callTool({ name: 'document_get', args: { id: 'doc-1' } });
  assert({
    ac: 'AC-4',
    ok: read.isError === true,
    message:
      'no-adapter server exposed an authenticated read to an unauthenticated caller ' +
      `(treated caller as authorized local-dev): ${JSON.stringify(read)}`,
  });

  const staged = await server.callTool({
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'no-adapter' },
  });
  await server.close();
  assert({
    ac: 'AC-4',
    ok: staged.isError === true,
    message:
      'no-adapter server staged a governed action for an unauthenticated caller ' +
      `(deny-first did not trigger): ${JSON.stringify(staged)}`,
  });

  // Completeness (passes in both states): dev mode remains available on an
  // explicit opt-in.
  const { env: devEnv } = setupPhaseDir({ sandbox, phase: 'p4-dev', backend: DRAFT_DOC });
  const devServer = await openSession({ config: DEVOPTIN, env: devEnv });
  const devStaged = await devServer.callTool({
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'dev opt-in' },
  });
  await devServer.close();
  assert({
    ac: 'AC-4',
    ok: devStaged.structuredContent?.status === 'approval_pending',
    message: `explicit dev opt-in did not stage: ${JSON.stringify(devStaged)}`,
  });
};

// ---------------------------------------------------------------------------
// Phase 5 (AC-5): core must reject a self-approval; a distinct approver works.
// ---------------------------------------------------------------------------
const phase5 = async ({ sandbox }) => {
  console.log('Phase 5 (AC-5): requester != approver enforced in core');
  const { env } = setupPhaseDir({ sandbox, phase: 'p5', backend: DRAFT_DOC });

  const selfStaged = await stageGoverned({
    config: ADAPTER,
    env,
    identity: 'alice',
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'self' },
  });
  assert({
    ac: 'AC-5',
    ok: selfStaged.status === 'approval_pending',
    message: `self-approval phase staging failed: ${JSON.stringify(selfStaged)}`,
  });

  // alice tries to approve alice's own staging.
  const selfApprove = runCli({
    args: ['approvals', 'approve', selfStaged.approvalId, '--config', ADAPTER],
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'alice' },
  });
  assert({
    ac: 'AC-5',
    ok: selfApprove.status !== 0,
    message:
      'core approved a SELF-approval (approver subject == requester subject); ' +
      'separation of duty rests only on the transport - the M-SELFAPPROVE gap',
  });

  // A distinct editor approving the same staging must still succeed.
  const distinctApprove = runCli({
    args: ['approvals', 'approve', selfStaged.approvalId, '--config', ADAPTER],
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'carol' },
  });
  assert({
    ac: 'AC-5',
    ok: distinctApprove.status === 0,
    message: `distinct-subject approver was wrongly rejected: ${distinctApprove.stderr}`,
  });
};

// ---------------------------------------------------------------------------
// Phase 6 (AC-6): anonymous check_approval denied; throwing where fails closed.
// ---------------------------------------------------------------------------
const phase6 = async ({ sandbox }) => {
  console.log('Phase 6 (AC-6): anonymous check_approval + fail-closed where');

  // (a) anonymous check_approval must be denied.
  const a = setupPhaseDir({ sandbox, phase: 'p6a', backend: DRAFT_DOC });
  const staged = await stageGoverned({
    config: ADAPTER,
    env: a.env,
    identity: 'alice',
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'for anon' },
  });
  runCli({
    args: ['approvals', 'approve', staged.approvalId, '--config', ADAPTER],
    env: { ...a.env, ORANGERAIL_E2E_IDENTITY: 'carol' },
  });

  const anon = await openSession({
    config: ADAPTER,
    env: { ...a.env, ORANGERAIL_E2E_IDENTITY: 'anon' },
  });
  const anonChecked = await anon.callToolSafe({
    name: 'check_approval',
    args: { approvalId: staged.approvalId },
  });
  await anon.close();
  const anonStatus = anonChecked.result?.structuredContent?.status;
  assert({
    ac: 'AC-6',
    ok: anonChecked.result?.isError === true || anonStatus === 'denied',
    message:
      'anonymous check_approval TRIGGERED execution instead of being denied ' +
      `(no caller check) - the L-CHECKAPPROVAL-ID gap: ${JSON.stringify(anonChecked)}`,
  });
  assert({
    ac: 'AC-6',
    ok: anonStatus !== 'executed',
    message: 'anonymous caller completed a governed execution via check_approval',
  });

  // (b) a throwing functional where at execute-time must fail closed to a
  // resolve_error with an audit record (not an uncaught crash / silent orphan).
  const b = setupPhaseDir({ sandbox, phase: 'p6b', backend: DRAFT_DOC });
  const riskyStaged = await stageGoverned({
    config: ADAPTER,
    env: b.env,
    identity: 'alice',
    name: 'risky_action',
    args: { note: 'boom' },
  });
  assert({
    ac: 'AC-6',
    ok: riskyStaged.status === 'approval_pending',
    message: `risky_action did not stage (where should pass at stage time): ${JSON.stringify(riskyStaged)}`,
  });

  // The where predicate starts throwing between stage and execute.
  writeFileSync(join(b.dataDir, 'boom.flag'), 'x');

  runCli({
    args: ['approvals', 'approve', riskyStaged.approvalId, '--config', ADAPTER],
    env: { ...b.env, ORANGERAIL_E2E_IDENTITY: 'carol' },
  });

  const execSession = await openSession({
    config: ADAPTER,
    env: { ...b.env, ORANGERAIL_E2E_IDENTITY: 'alice' },
  });
  const execResult = await execSession.callToolSafe({
    name: 'check_approval',
    args: { approvalId: riskyStaged.approvalId },
  });
  await execSession.close();

  assert({
    ac: 'AC-6',
    ok:
      execResult.error === undefined &&
      execResult.result?.structuredContent?.status === 'resolve_error',
    message:
      'a throwing functional where did not fail closed to resolve_error ' +
      `(escaped uncaught) - the L-WHERE-THROW gap: ${JSON.stringify(execResult)}`,
  });

  const audit = readAudit({ storeDir: b.storeDir });
  assert({
    ac: 'AC-6',
    ok: audit.some((r) => r.phase === 'resolve_error'),
    message: 'no resolve_error audit record after a throwing where (silent orphan)',
  });
};

// ---------------------------------------------------------------------------
// Phase 7 (AC-7): the sound governed loop still completes and verifies clean.
// Passes in both states (no-regression guard).
// ---------------------------------------------------------------------------
const phase7 = async ({ sandbox }) => {
  console.log('Phase 7 (AC-7): governed loop no-regression');
  const { dataDir, env } = setupPhaseDir({ sandbox, phase: 'p7', backend: DRAFT_DOC });

  const staged = await stageGoverned({
    config: ADAPTER,
    env,
    identity: 'alice',
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'sound path' },
  });
  assert({
    ac: 'AC-7',
    ok: staged.status === 'approval_pending',
    message: `sound-path staging failed: ${JSON.stringify(staged)}`,
  });

  const approve = runCli({
    args: ['approvals', 'approve', staged.approvalId, '--config', ADAPTER],
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'carol' },
  });
  assert({
    ac: 'AC-7',
    ok: approve.status === 0,
    message: `sound-path approve failed: ${approve.stderr}`,
  });

  const exec = await openSession({
    config: ADAPTER,
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'alice' },
  });
  const checked = await exec.callTool({
    name: 'check_approval',
    args: { approvalId: staged.approvalId },
  });
  await exec.close();
  assert({
    ac: 'AC-7',
    ok: checked.structuredContent?.status === 'executed',
    message: `sound-path execution did not complete: ${JSON.stringify(checked)}`,
  });
  assert({
    ac: 'AC-7',
    ok: existsSync(join(dataDir, 'side-effect.json')),
    message: 'sound-path side effect missing after execution',
  });

  const verify = runCli({ args: ['audit', 'verify', '--config', ADAPTER], env });
  assert({
    ac: 'AC-7',
    ok: verify.status === 0,
    message: `sound-path audit verify failed on a clean run: ${verify.stderr}`,
  });
};

const main = async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ont-014-'));

  await phase1({ sandbox });
  await phase2({ sandbox });
  await phase3({ sandbox });
  await phase4({ sandbox });
  await phase5({ sandbox });
  await phase6({ sandbox });
  await phase7({ sandbox });

  if (failures > 0) {
    console.error(`\nONT-014 governance-security scenario: ${failures} assertion(s) failed`);
    process.exit(1);
  }

  console.log('\nONT-014 governance-security scenario: all assertions passed');
};

await main();
