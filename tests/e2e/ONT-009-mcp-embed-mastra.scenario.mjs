/**
 * ONT-009 e2e driver — real Mastra MCP client seam (ticket section 5, plan T2).
 *
 * Pure Node stdlib. This scenario ORCHESTRATES the governed-write loop but never
 * speaks MCP itself — a separate Mastra harness (fixtures/ont-009/harness) owns
 * the `@mastra/mcp` client and spawns `orangerail mcp` over stdio. Each harness
 * phase is a distinct child process that prints EXACTLY ONE JSON line to stdout;
 * this driver freezes that contract in assertions and runs the human-side
 * `orangerail` CLI (approvals + audit verify) as separate processes between phases.
 *
 * Phase contract (frozen here):
 *   discover  {"phase":"discover","toolKeys":[...],"listItems":[...]}
 *   stage     {"phase":"stage","publish":{"status":"approval_pending","approvalId":"..."},"auto":{"touched":"<label>"}}
 *   check     {"phase":"check","status":"executed"}   (extra keys allowed)
 *
 * Flow: sandbox setup -> discover -> stage -> CLI approvals list/approve ->
 * check -> per-phase no-orphan sweep -> DESIGN.md section 9-9 decision stamp.
 *
 * RED (pre-implementation): the harness directory
 * (tests/e2e/fixtures/ont-009/harness) does not exist yet, so the harness-absent
 * assertion fails before any phase runs; the DESIGN.md item-9 stamp is also
 * still unchecked. verify.sh stays green (no packages/ change).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-009');
const CONFIG = join(FIXTURE, 'config.mjs');
const HARNESS = join(FIXTURE, 'harness');
const RUN_PHASE = join(HARNESS, 'run-phase.mjs');
const DESIGN = join(ROOT, 'DESIGN.md');

const fail = ({ message }) => {
  console.error(`ONT-009 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const deepEqual = ({ a, b }) => JSON.stringify(a) === JSON.stringify(b);

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
 * Runs one harness phase as a child process and returns its exit status plus the
 * single JSON contract line it printed to stdout (parsed).
 */
const runPhase = ({ phase, env }) => {
  const res = spawnSync('node', [RUN_PHASE, phase], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });

  const stdout = res.stdout ?? '';
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  let contract = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.phase === phase) {
        contract = parsed;
      }
    } catch {
      /* not a JSON line — harness diagnostics are allowed on stdout/stderr */
    }
  }

  return { status: res.status, stdout, stderr: res.stderr ?? '', contract };
};

/**
 * Asserts no leftover MCP server child matches the unique fixture config path.
 * pgrep exits 1 when nothing matches (tolerated); >1 is a real pgrep error.
 */
const assertNoOrphan = ({ label }) => {
  const res = spawnSync('pgrep', ['-f', CONFIG], { encoding: 'utf8' });

  assert({
    ok: res.status === 0 || res.status === 1,
    message: `pgrep errored while sweeping for orphans after ${label} (status ${res.status})`,
  });

  const pids = (res.stdout ?? '')
    .split('\n')
    .map((pid) => pid.trim())
    .filter((pid) => pid !== '');
  assert({
    ok: pids.length === 0,
    message: `orphan process(es) survived ${label} matching ${CONFIG}: ${pids.join(', ')}`,
  });
};

let sandbox = null;

const cleanup = () => {
  // Best-effort: reap any server child still matching the fixture config, then
  // remove the sandbox. Runs on normal exit and after fail()'s process.exit.
  const found = spawnSync('pgrep', ['-f', CONFIG], { encoding: 'utf8' });
  if (found.status === 0) {
    for (const pid of (found.stdout ?? '')
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  if (sandbox) {
    rmSync(sandbox, { recursive: true, force: true });
  }
};

process.on('exit', cleanup);

const main = async () => {
  // ---- Sandbox setup ----
  sandbox = mkdtempSync(join(tmpdir(), 'ont-009-'));
  const dataDir = join(sandbox, 'data');
  const storeDir = join(sandbox, 'store');
  mkdirSync(dataDir);

  const backendRows = [
    { id: 'doc-1', title: 'Launch plan', status: 'draft' },
    { id: 'doc-2', title: 'Shipped notes', status: 'published' },
  ];
  writeFileSync(join(dataDir, 'backend.json'), JSON.stringify(backendRows));

  const draftId = 'doc-1';
  const note = 'ship it';
  const label = 'tick';

  const baseEnv = {
    ORANGERAIL_E2E_STORE: storeDir,
    ORANGERAIL_E2E_DATA: dataDir,
    ORANGERAIL_E2E_CONFIG: CONFIG,
    ORANGERAIL_E2E_CLI: CLI,
    ORANGERAIL_E2E_MARKER: sandbox,
  };

  // ---- Harness install step ----
  assert({
    ok: existsSync(HARNESS),
    message: `harness directory absent: ${HARNESS} — build the ONT-009 Mastra MCP harness (fixtures/ont-009/harness with package.json + run-phase.mjs) before this scenario can run`,
  });

  if (!existsSync(join(HARNESS, 'node_modules'))) {
    console.log('Installing harness dependencies (standalone, ignore-workspace)');
    const hasLock = existsSync(join(HARNESS, 'pnpm-lock.yaml'));
    const installArgs = hasLock
      ? ['install', '--ignore-workspace', '--frozen-lockfile']
      : ['install', '--ignore-workspace'];
    const install = spawnSync('pnpm', installArgs, {
      cwd: HARNESS,
      env: { ...process.env },
      stdio: 'inherit',
      timeout: 600_000,
    });
    assert({
      ok: install.status === 0,
      message: `harness pnpm install failed (status ${install.status})`,
    });
  }

  // ---- Phase: discover ----
  console.log('Phase: discover');

  const discover = runPhase({ phase: 'discover', env: baseEnv });
  assert({
    ok: discover.status === 0,
    message: `discover phase exited ${discover.status}\nstdout: ${discover.stdout}\nstderr: ${discover.stderr}`,
  });
  assert({
    ok: discover.contract !== null,
    message: `discover phase printed no {"phase":"discover",...} JSON line\nstdout: ${discover.stdout}`,
  });

  const toolKeys = discover.contract.toolKeys ?? [];
  for (const expected of [
    'orangerail_document_get',
    'orangerail_document_list',
    'orangerail_publish_document',
    'orangerail_touch_counter',
    'orangerail_check_approval',
  ]) {
    assert({
      ok: Array.isArray(toolKeys) && toolKeys.includes(expected),
      message: `discover toolKeys missing ${expected} — got ${JSON.stringify(toolKeys)}`,
    });
  }

  assert({
    ok: deepEqual({ a: discover.contract.listItems, b: backendRows }),
    message: `discover listItems do not deep-equal the backend rows — got ${JSON.stringify(discover.contract.listItems)}`,
  });

  assertNoOrphan({ label: 'discover' });

  // ---- Phase: stage ----
  console.log('Phase: stage');

  const stage = runPhase({
    phase: 'stage',
    env: {
      ...baseEnv,
      ORANGERAIL_E2E_DOC_ID: draftId,
      ORANGERAIL_E2E_NOTE: note,
      ORANGERAIL_E2E_LABEL: label,
    },
  });
  // A thrown Mastra tool error would exit non-zero; approval_pending is DATA.
  assert({
    ok: stage.status === 0,
    message: `stage phase exited ${stage.status} — approval_pending must surface as DATA, not a thrown tool error\nstdout: ${stage.stdout}\nstderr: ${stage.stderr}`,
  });
  assert({
    ok: stage.contract !== null,
    message: `stage phase printed no {"phase":"stage",...} JSON line\nstdout: ${stage.stdout}`,
  });

  const publish = stage.contract.publish ?? {};
  const approvalId = publish.approvalId;
  assert({
    ok: publish.status === 'approval_pending',
    message: `expected publish.status approval_pending, got ${JSON.stringify(publish)}`,
  });
  assert({
    ok: typeof approvalId === 'string' && approvalId !== '',
    message: `expected a non-empty publish.approvalId, got ${JSON.stringify(publish)}`,
  });

  const auto = stage.contract.auto ?? {};
  assert({
    ok: auto.touched === label,
    message: `expected auto.touched to round-trip ${label}, got ${JSON.stringify(auto)}`,
  });

  assert({
    ok: !existsSync(join(dataDir, 'side-effect.json')),
    message: 'side-effect.json exists after staging but before approval',
  });

  assertNoOrphan({ label: 'stage' });

  // ---- CLI bridge: human approves the staged action ----
  console.log('CLI bridge: approvals list + approve');

  const list = runCli({ args: ['approvals', 'list', '--config', CONFIG], env: baseEnv });
  assert({ ok: list.status === 0, message: `approvals list failed: ${list.stderr}` });
  assert({
    ok: list.stdout.includes(approvalId),
    message: `approvals list does not show ${approvalId}\nstdout: ${list.stdout}`,
  });

  const approve = runCli({
    args: ['approvals', 'approve', approvalId, '--config', CONFIG],
    env: baseEnv,
  });
  assert({ ok: approve.status === 0, message: `approve failed: ${approve.stderr}` });

  // ---- Phase: check ----
  console.log('Phase: check');

  const check = runPhase({
    phase: 'check',
    env: { ...baseEnv, ORANGERAIL_E2E_APPROVAL_ID: approvalId },
  });
  assert({
    ok: check.status === 0,
    message: `check phase exited ${check.status}\nstdout: ${check.stdout}\nstderr: ${check.stderr}`,
  });
  assert({
    ok: check.contract !== null,
    message: `check phase printed no {"phase":"check",...} JSON line\nstdout: ${check.stdout}`,
  });
  assert({
    ok: check.contract.status === 'executed',
    message: `expected check status executed, got ${JSON.stringify(check.contract)}`,
  });

  assert({
    ok: existsSync(join(dataDir, 'side-effect.json')),
    message: 'side-effect.json missing after approved execution',
  });
  const payload = JSON.parse(readFileSync(join(dataDir, 'side-effect.json'), 'utf8'));
  assert({
    ok: payload.documentId === draftId && payload.note === note,
    message: `side-effect payload mismatch — got ${JSON.stringify(payload)}`,
  });

  const verify = runCli({ args: ['audit', 'verify', '--config', CONFIG], env: baseEnv });
  assert({ ok: verify.status === 0, message: `audit verify failed: ${verify.stderr}` });

  assertNoOrphan({ label: 'check' });

  // ---- Decision stamp: DESIGN.md section 9-9 (ASCII-only structural match) ----
  console.log('Decision stamp: DESIGN.md item 9 + parking-lot invariant');

  const designLines = readFileSync(DESIGN, 'utf8').split('\n');
  assert({
    ok: designLines.some((line) => /^9\. \[x\]/.test(line)),
    message:
      'DESIGN.md v0 checklist item 9 is not checked ([x]) — the section 9-9 decision stamp is missing',
  });

  const elicitationLines = designLines.filter((line) => line.includes('MCP Elicitation'));
  assert({
    ok: elicitationLines.length >= 2,
    message: `expected "MCP Elicitation" on at least 2 distinct DESIGN.md lines (design section + parking-lot entry), found ${elicitationLines.length}`,
  });

  console.log('ONT-009 mcp-embed-mastra scenario: all assertions passed');
};

await main();
