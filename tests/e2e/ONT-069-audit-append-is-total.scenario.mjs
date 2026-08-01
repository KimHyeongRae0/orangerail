/**
 * ONT-069 e2e driver — hashing and audit-appending are total, and an approval
 * that could not be executed stays executable (ticket section 5).
 *
 * Pure Node stdlib: it drives the SHIPPED CLI (packages/cli/dist/main.js) and
 * speaks newline-delimited JSON-RPC to `orangerail mcp` over stdio, exactly like
 * the ONT-014 driver. Every unserializable value here is refused for a reason
 * that is NOT `BigInt` — a structure that points at itself — so this scenario
 * and the `BigInt` contract are independently verifiable.
 *
 * Three phases:
 *   1. An AUTO action returns a circular structure. The chain must carry a
 *      terminal record for it, with a stated fallback rendering, and verify OK.
 *   2. A GATED action whose TARGET ROW is circular, so `execution_started`
 *      carries a prior the chain has to render. It must execute, and the
 *      approval must not end up consumed-with-nothing-recorded.
 *   3. The audit log is made unwritable between approval and execution. The call
 *      must refuse (audit_blocked) AND leave the approval executable: once the
 *      log is writable again the same approvalId completes, exactly once.
 *
 * RED (against the pre-fix shipped artifacts):
 *   - Phase 1: `JSON.stringify` throws inside `appendAudit`, the terminal append
 *     is swallowed, and `audit verify` reports "incomplete execution".
 *   - Phase 2: the `execution_started` append throws AFTER the consume CAS, so
 *     the call answers audit_blocked, the approval is spent, and verify reports
 *     an orphaned consumed approval.
 *   - Phase 3: the approval is consumed by the refused attempt, so the retry
 *     answers "Already executed (consumed)." for an execution that never ran and
 *     the side effect never happens.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const CONFIG = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-069', 'config.mjs');

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
      clientInfo: { name: 'ont-069-e2e', version: '0.0.0' },
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

/** One MCP tool call in its own server process, as `identity`. */
const callAs = async ({ env, identity, name, args }) => {
  const session = await openSession({ env: { ...env, ORANGERAIL_E2E_IDENTITY: identity } });
  const result = await session.callTool({ name, args });
  await session.close();

  return result;
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
  writeFileSync(join(dataDir, 'label.txt'), 'plain row');

  return {
    storeDir,
    dataDir,
    env: { ORANGERAIL_E2E_STORE: storeDir, ORANGERAIL_E2E_DATA: dataDir },
  };
};

/** Stage a gated action as alice, approve it as carol; returns its approvalId. */
const stageAndApprove = async ({ env, name, args }) => {
  const staged = await callAs({ env, identity: 'alice', name, args });
  const approvalId = staged.structuredContent?.approvalId;

  if (typeof approvalId !== 'string') {
    return { approvalId: null, staged };
  }

  const approve = runCli({
    args: ['approvals', 'approve', approvalId, '--config', CONFIG],
    env: { ...env, ORANGERAIL_E2E_IDENTITY: 'carol' },
  });

  return { approvalId, staged, approve };
};

// ---------------------------------------------------------------------------
// Phase 1 (AC-2): an auto action returning a circular structure.
// ---------------------------------------------------------------------------
const phase1 = async ({ sandbox }) => {
  console.log('Phase 1 (AC-2): a terminal record for a result JSON refuses');
  const { storeDir, dataDir, env } = setupPhaseDir({ sandbox, phase: 'p1' });

  // What the TOOL answers for a circular result is the transport rendering its
  // own reply (`orangerail-mcp` stringifies `result` for the agent), which is
  // ONT-068's file and deliberately not asserted here. This ticket is about what
  // the chain says, so the assertions below read the chain.
  await callAs({ env, identity: 'alice', name: 'record_reading', args: { id: 'r-1' } });

  assert({
    ac: 'AC-2',
    ok: readLedger({ dataDir }).length === 1,
    message: 'the side effect did not run exactly once',
  });

  const records = readAudit({ storeDir });
  const terminal = records.find((record) => record.phase === 'succeeded');

  assert({
    ac: 'AC-2',
    ok: terminal !== undefined,
    message: `the write landed and the chain has no terminal record: ${records
      .map((record) => record.phase)
      .join(', ')}`,
  });
  assert({
    ac: 'AC-2',
    ok: terminal?.result?.self === '[unserializable: circular reference]',
    message: `the terminal record does not state its fallback rendering: ${JSON.stringify(
      terminal?.result,
    )}`,
  });
  assert({
    ac: 'AC-2',
    ok: terminal?.result?.label === 'reading r-1',
    message: 'the fallback rendering dropped the fields that WERE serializable',
  });

  const verify = runCli({ args: ['audit', 'verify', '--config', CONFIG], env });
  assert({
    ac: 'AC-2',
    ok: verify.status === 0,
    message: `audit verify failed after an auto write: ${verify.stderr.trim()}`,
  });
};

// ---------------------------------------------------------------------------
// Phase 2 (AC-3): a gated action whose PRIOR row is unserializable.
// ---------------------------------------------------------------------------
const phase2 = async ({ sandbox }) => {
  console.log('Phase 2 (AC-3): a gated write whose prior row JSON refuses');
  const { storeDir, dataDir, env } = setupPhaseDir({ sandbox, phase: 'p2' });

  const { approvalId, approve } = await stageAndApprove({
    env,
    name: 'apply_reading',
    args: { id: 'r-2' },
  });

  assert({ ac: 'AC-3', ok: approvalId !== null, message: 'gated staging yielded no approvalId' });
  assert({ ac: 'AC-3', ok: approve?.status === 0, message: `approve failed: ${approve?.stderr}` });

  const checked = await callAs({
    env,
    identity: 'alice',
    name: 'check_approval',
    args: { approvalId },
  });

  assert({
    ac: 'AC-3',
    ok: checked.structuredContent?.status === 'executed',
    message: `check_approval did not execute: ${JSON.stringify(checked.structuredContent)}`,
  });
  assert({
    ac: 'AC-3',
    ok: readLedger({ dataDir }).length === 1,
    message: 'the approved write did not run exactly once',
  });

  const started = readAudit({ storeDir }).find((record) => record.phase === 'execution_started');
  assert({
    ac: 'AC-3',
    ok: started?.prior?.value?.self === '[unserializable: circular reference]',
    message: `the started record does not carry a rendered prior: ${JSON.stringify(started?.prior)}`,
  });

  const verify = runCli({ args: ['audit', 'verify', '--config', CONFIG], env });
  assert({
    ac: 'AC-3',
    ok: verify.status === 0,
    message: `audit verify failed after a gated write: ${verify.stderr.trim()}`,
  });
  assert({
    ac: 'AC-3',
    ok: !verify.stderr.includes('orphaned consumed approval'),
    message: 'the approval was consumed with nothing recorded against it',
  });
};

// ---------------------------------------------------------------------------
// Phase 3 (AC-3/AC-4): an approval survives an append that fails.
// ---------------------------------------------------------------------------
const phase3 = async ({ sandbox }) => {
  console.log('Phase 3 (AC-3/AC-4): an unwritable audit log leaves the approval executable');
  const { storeDir, dataDir, env } = setupPhaseDir({ sandbox, phase: 'p3' });

  const { approvalId, approve } = await stageAndApprove({
    env,
    name: 'apply_plain',
    args: { id: 'p-1' },
  });

  assert({ ac: 'AC-3', ok: approvalId !== null, message: 'gated staging yielded no approvalId' });
  assert({ ac: 'AC-3', ok: approve?.status === 0, message: `approve failed: ${approve?.stderr}` });

  // The store is fine; its audit log is not writable. Only `appendAudit` fails,
  // which is exactly the failure the ordering has to survive.
  const auditPath = join(storeDir, 'audit.jsonl');
  chmodSync(auditPath, 0o444);

  const blocked = await callAs({
    env,
    identity: 'alice',
    name: 'check_approval',
    args: { approvalId },
  });

  assert({
    ac: 'AC-3',
    ok: blocked.structuredContent?.status === 'audit_blocked',
    message: `expected audit_blocked, got ${JSON.stringify(blocked.structuredContent)}`,
  });
  assert({
    ac: 'AC-3',
    ok: readLedger({ dataDir }).length === 0,
    message: 'the write ran even though its audit record could not be written',
  });

  chmodSync(auditPath, 0o644);

  const retried = await callAs({
    env,
    identity: 'alice',
    name: 'check_approval',
    args: { approvalId },
  });

  assert({
    ac: 'AC-4',
    ok: retried.structuredContent?.status === 'executed',
    message: `the approval was not executable after the refusal: ${JSON.stringify(
      retried.structuredContent,
    )}`,
  });
  assert({
    ac: 'AC-4',
    ok: !JSON.stringify(retried).includes('Already executed'),
    message: 'check_approval reported an execution that never ran',
  });
  assert({
    ac: 'AC-3',
    ok: readLedger({ dataDir }).length === 1,
    message: 'the recovered approval did not run exactly once',
  });

  const verify = runCli({ args: ['audit', 'verify', '--config', CONFIG], env });
  assert({
    ac: 'AC-3',
    ok: verify.status === 0,
    message: `audit verify failed after the recovery: ${verify.stderr.trim()}`,
  });
};

const main = async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ont-069-e2e-'));
  console.log(`sandbox: ${sandbox}`);

  await phase1({ sandbox });
  await phase2({ sandbox });
  await phase3({ sandbox });

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }

  console.log('\nall ONT-069 assertions passed');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
