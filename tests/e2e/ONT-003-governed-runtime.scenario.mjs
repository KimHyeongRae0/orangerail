/**
 * ONT-003 e2e driver — cross-process governed runtime (ticket §5, plan §8).
 *
 * Pure Node stdlib: speaks newline-delimited JSON-RPC to `orangerail mcp` over
 * stdio (a deliberate wire-protocol check — no SDK client), and runs the
 * `orangerail` CLI as separate processes, exactly like a human approver would.
 *
 * Phases:
 *   A (dev mode)  tools listed → read tool → stage (approval_pending, no side
 *                 effect) → server exits → CLI list/approve → NEW server
 *                 session check_approval → executed + side effect + devMode
 *                 stamped in audit.jsonl → audit verify green.
 *   B (RBAC)      static adapter: anonymous staging denied over stdio;
 *                 wrong-role approver rejected; editor approves; executed.
 *   C (tamper)    flip one byte in audit.jsonl → audit verify exits non-zero.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-003');

const fail = ({ message }) => {
  console.error(`ASSERTION FAILED: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
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
 * Minimal MCP stdio client session. Spawns `orangerail mcp` as a child, does
 * the initialize handshake, then exposes request(). One session per server
 * process — closing the session ends the server.
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
      clientInfo: { name: 'ont-003-e2e', version: '0.0.0' },
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

  const listTools = async () => request({ method: 'tools/list', params: {} });

  return { request, callTool, listTools, close };
};

const readAudit = ({ storeDir }) =>
  readFileSync(join(storeDir, 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

const main = async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ont-003-'));
  const dataDir = join(sandbox, 'data');
  const devStore = join(sandbox, 'store-dev');
  const rbacStore = join(sandbox, 'store-rbac');
  mkdirSync(dataDir);

  writeFileSync(
    join(dataDir, 'backend.json'),
    JSON.stringify([{ id: 'doc-1', title: 'Launch plan', status: 'draft' }]),
  );

  const devEnv = { ORANGERAIL_E2E_STORE: devStore, ORANGERAIL_E2E_DATA: dataDir };
  const devConfig = join(FIXTURES, 'config-dev.mjs');

  // ---- Phase A: dev-mode lifecycle across two server incarnations ----
  console.log('Phase A: dev-mode lifecycle');

  const s1 = await openSession({ config: devConfig, env: devEnv });

  const tools = await s1.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of [
    'document_get',
    'document_list',
    'publish_document',
    'touch_counter',
    'check_approval',
  ]) {
    assert({ ok: names.includes(expected), message: `tools/list missing ${expected}` });
  }

  const got = await s1.callTool({ name: 'document_get', args: { id: 'doc-1' } });
  assert({ ok: got.isError !== true, message: 'document_get returned isError' });
  assert({
    ok: JSON.stringify(got).includes('Launch plan'),
    message: 'document_get result does not contain the document',
  });

  const staged = await s1.callTool({
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'ship it' },
  });
  const stagedStatus = staged.structuredContent?.status;
  const approvalId = staged.structuredContent?.approvalId;
  assert({
    ok: stagedStatus === 'approval_pending' && typeof approvalId === 'string',
    message: `expected approval_pending + approvalId, got ${JSON.stringify(staged)}`,
  });
  assert({
    ok: !existsSync(join(dataDir, 'side-effect.json')),
    message: 'side effect exists before approval',
  });

  await s1.close();

  const list = runCli({ args: ['approvals', 'list', '--config', devConfig], env: devEnv });
  assert({ ok: list.status === 0, message: `approvals list failed: ${list.stderr}` });
  assert({
    ok: list.stdout.includes(approvalId),
    message: `approvals list does not show ${approvalId}`,
  });

  const approve = runCli({
    args: ['approvals', 'approve', approvalId, '--config', devConfig],
    env: devEnv,
  });
  assert({ ok: approve.status === 0, message: `approve failed: ${approve.stderr}` });

  // New server process: the approval must have survived the restart.
  const s2 = await openSession({ config: devConfig, env: devEnv });
  const checked = await s2.callTool({ name: 'check_approval', args: { approvalId } });
  assert({
    ok: checked.structuredContent?.status === 'executed',
    message: `expected executed, got ${JSON.stringify(checked)}`,
  });
  assert({
    ok: existsSync(join(dataDir, 'side-effect.json')),
    message: 'side effect missing after execution',
  });
  const payload = JSON.parse(readFileSync(join(dataDir, 'side-effect.json'), 'utf8'));
  assert({ ok: payload.documentId === 'doc-1', message: 'side effect payload mismatch' });

  const rechecked = await s2.callTool({ name: 'check_approval', args: { approvalId } });
  assert({
    ok: rechecked.structuredContent?.status === 'consumed',
    message: `expected consumed on re-poll, got ${JSON.stringify(rechecked)}`,
  });
  await s2.close();

  const devAudit = readAudit({ storeDir: devStore });
  assert({
    ok: devAudit.some((record) => record.phase === 'staged' && record.devMode === true),
    message: 'no devMode-stamped staged record in audit.jsonl',
  });
  assert({
    ok: devAudit.some((record) => record.phase === 'succeeded'),
    message: 'no succeeded record in audit.jsonl',
  });

  const verify = runCli({ args: ['audit', 'verify', '--config', devConfig], env: devEnv });
  assert({ ok: verify.status === 0, message: `audit verify failed: ${verify.stderr}` });

  // ---- Phase B: static-adapter RBAC + anonymous deny over stdio ----
  console.log('Phase B: RBAC + anonymous deny');

  const rbacEnv = { ORANGERAIL_E2E_STORE: rbacStore, ORANGERAIL_E2E_DATA: dataDir };
  const rbacConfig = join(FIXTURES, 'config-rbac.mjs');

  const anon = await openSession({
    config: rbacConfig,
    env: { ...rbacEnv, ORANGERAIL_E2E_IDENTITY: 'anon' },
  });
  const denied = await anon.callTool({
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'sneaky' },
  });
  assert({
    ok: denied.isError === true,
    message: `anonymous staging was not denied: ${JSON.stringify(denied)}`,
  });
  await anon.close();

  const editorSession = await openSession({
    config: rbacConfig,
    env: { ...rbacEnv, ORANGERAIL_E2E_IDENTITY: 'editor' },
  });
  const rbacStaged = await editorSession.callTool({
    name: 'publish_document',
    args: { documentId: 'doc-1', note: 'governed' },
  });
  const rbacApprovalId = rbacStaged.structuredContent?.approvalId;
  assert({
    ok: rbacStaged.structuredContent?.status === 'approval_pending',
    message: `expected approval_pending in RBAC phase, got ${JSON.stringify(rbacStaged)}`,
  });

  const wrongRole = runCli({
    args: ['approvals', 'approve', rbacApprovalId, '--config', rbacConfig],
    env: { ...rbacEnv, ORANGERAIL_E2E_IDENTITY: 'viewer' },
  });
  assert({
    ok: wrongRole.status !== 0,
    message: 'viewer (wrong role) approve unexpectedly succeeded',
  });

  const rightRole = runCli({
    args: ['approvals', 'approve', rbacApprovalId, '--config', rbacConfig],
    env: { ...rbacEnv, ORANGERAIL_E2E_IDENTITY: 'editor' },
  });
  assert({ ok: rightRole.status === 0, message: `editor approve failed: ${rightRole.stderr}` });

  const rbacChecked = await editorSession.callTool({
    name: 'check_approval',
    args: { approvalId: rbacApprovalId },
  });
  assert({
    ok: rbacChecked.structuredContent?.status === 'executed',
    message: `expected executed in RBAC phase, got ${JSON.stringify(rbacChecked)}`,
  });
  await editorSession.close();

  // ---- Phase C: tamper detection ----
  console.log('Phase C: tamper detection');

  const auditPath = join(devStore, 'audit.jsonl');
  const original = readFileSync(auditPath, 'utf8');
  const tampered = original.replace('"phase":"staged"', '"phase":"staged?"');
  assert({ ok: tampered !== original, message: 'tamper substitution found nothing to flip' });
  writeFileSync(auditPath, tampered);

  const verifyTampered = runCli({
    args: ['audit', 'verify', '--config', devConfig],
    env: devEnv,
  });
  assert({
    ok: verifyTampered.status !== 0,
    message: 'audit verify passed on a tampered chain',
  });

  console.log('ONT-003 governed-runtime scenario: all assertions passed');
};

await main();
