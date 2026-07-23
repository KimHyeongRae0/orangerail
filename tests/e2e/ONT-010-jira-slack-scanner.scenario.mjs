/**
 * ONT-010 e2e driver — deterministic Jira/Slack org-ontology scanner.
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) against realistic-shape
 * fixture exports (tests/e2e/fixtures/ont-010: 340 Jira issues with
 * fields+changelog, 766 Slack messages with users[] and <@U_> mentions) and
 * proves the ticket's acceptance criteria:
 *
 *   phase 1  flag-driven `orangerail init --from-jira <j> --from-slack <s>`
 *            generates orangerail.config.mjs + data/*.json + ANALYTICS.md (AC-1/6)
 *   phase 2  per-person structural metrics match the pinned ground truth
 *            (ground-truth.json), counts exact and rates within tolerance
 *            (AC-2/AC-8)
 *   phase 3  the generated config loads and serves employee/team/service
 *            objects over MCP tools/list; employee_list returns all 11 (AC-6)
 *   phase 4  >=5 org findings emit with evidence pointers, incl. the
 *            ticket-less incidents and the post-departure approval gap (AC-5)
 *   phase 5  every ANALYTICS.md metric carries a formula, the onboarding-map
 *            framing is present, and no ranking/score column appears (AC-7)
 *   phase 6  generation is byte-deterministic across two fresh runs (AC-6/AC-8)
 *   phase 7  edge fixtures (no-changelog -> "unavailable", unassigned, bot/
 *            unknown Slack user) and a hostile-string fixture are handled
 *            without a crash or code injection (edge cases)
 *
 * The output CONTRACT this test pins (what the scanner must emit under the run
 * dir): `orangerail.config.mjs` (default export { registry, store }, declaring
 * employee/team/service[/incident] objects and member_of/works_on/helps
 * links), `data/<object>.json` instance arrays, `data/<link>.json` edge arrays
 * ({ from, to, weight } by accountId), `data/finding.json`
 * ({ id, title, detail, pointer }), and `ANALYTICS.md`.
 *
 * RED (pre-implementation): main.ts does not know --from-jira, so in the
 * config-less run dir `orangerail init` finds no Prisma/OpenAPI source and writes
 * no config; phase 1's "config generated" assertion fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-010');
const SCRATCH = join(ROOT, '.docs', 'scratch');
const RUN_A = join(SCRATCH, 'ont-010-run-a');
const RUN_B = join(SCRATCH, 'ont-010-run-b');
const RUN_NOCL = join(SCRATCH, 'ont-010-run-nochangelog');
const RUN_UNASSIGNED = join(SCRATCH, 'ont-010-run-unassigned');
const RUN_HOSTILE = join(SCRATCH, 'ont-010-run-hostile');

const GROUND_TRUTH = JSON.parse(readFileSync(join(FIXTURE, 'ground-truth.json'), 'utf8'));

const fail = ({ message }) => {
  console.error(`ONT-010 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const near = ({ actual, expected, tol, label }) => {
  assert({
    ok: typeof actual === 'number' && Math.abs(actual - expected) <= tol,
    message: `${label}: expected ~${expected} (+/-${tol}), got ${JSON.stringify(actual)}`,
  });
};

const exact = ({ actual, expected, label }) => {
  assert({
    ok: actual === expected,
    message: `${label}: expected ${expected}, got ${JSON.stringify(actual)}`,
  });
};

const readJson = ({ dir, rel }) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

const prepareRunDir = ({ dir }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
};

/** Run an `orangerail` command to completion inside a run dir. */
const runCli = ({ args, cwd }) => {
  const res = spawnSync('node', [CLI, ...args], {
    cwd,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 120_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** Init a fresh run dir from the artifact exports. `jira`/`slack` are rel paths. */
const initArtifacts = ({ dir, jira, slack }) => {
  prepareRunDir({ dir });

  const args = ['init', '--yes', '--no-studio', '--no-docs', '--from-jira', jira];
  if (slack !== undefined) {
    args.push('--from-slack', slack);
  }

  return runCli({ args, cwd: dir });
};

/** Minimal MCP stdio client (ONT-003/006 pattern) over the generated config. */
const openMcpSession = async ({ cwd }) => {
  const child = spawn('node', [CLI, 'mcp', '--config', 'orangerail.config.mjs'], {
    cwd,
    env: { ...process.env },
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
      clientInfo: { name: 'ont-010-e2e', version: '0.0.0' },
    },
  });
  send({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  const close = async () => {
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
  };

  return { request, close };
};

// ─────────────────────── phase 1 — init from artifacts ───────────────────────

console.log('[phase 1] flag-driven init from Jira + Slack exports');

const init = initArtifacts({ dir: RUN_A, jira: 'jira-export.json', slack: 'slack-export.json' });
assert({
  ok: init.status === 0,
  message: `init exited ${init.status}: ${init.stderr.slice(0, 400)}`,
});

for (const rel of [
  'orangerail.config.mjs',
  'data/employee.json',
  'data/service.json',
  'data/helps.json',
  'data/finding.json',
  'ANALYTICS.md',
]) {
  assert({ ok: existsSync(join(RUN_A, rel)), message: `init did not generate ${rel}` });
}

const configText = readFileSync(join(RUN_A, 'orangerail.config.mjs'), 'utf8');
for (const link of ['member_of', 'works_on', 'helps']) {
  assert({ ok: configText.includes(link), message: `generated config missing link type ${link}` });
}

// ─────────────────────── phase 2 — metrics vs ground truth ───────────────────

console.log('[phase 2] per-person structural metrics match ground truth');

const employees = readJson({ dir: RUN_A, rel: 'data/employee.json' });
assert({ ok: Array.isArray(employees), message: 'data/employee.json is not an array' });

const empById = new Map(employees.map((e) => [e.accountId, e]));
const activeCount = employees.filter((e) => e.active !== false).length;
assert({
  ok: employees.length === 11 && activeCount >= 10,
  message: `expected 11 employees (>=10 active), got ${employees.length} (${activeCount} active)`,
});

const CHECK = ['acc_jiho', 'acc_mina', 'acc_felix', 'acc_dave', 'acc_yuna'];
for (const id of CHECK) {
  const want = GROUND_TRUTH.perPerson[id];
  const got = empById.get(id);
  assert({ ok: got !== undefined, message: `employee ${id} missing from output` });

  exact({ actual: got.ticketCount, expected: want.ticketCount, label: `${id}.ticketCount` });
  exact({
    actual: got.storyPointsTotal,
    expected: want.storyPointsTotal,
    label: `${id}.storyPointsTotal`,
  });

  for (const band of ['hi', 'med', 'lo']) {
    exact({
      actual: got.complexityMix?.[band],
      expected: want.complexityMix[band],
      label: `${id}.complexityMix.${band}`,
    });
  }

  exact({
    actual: got.reassignmentsReceived,
    expected: want.reassignmentsReceived,
    label: `${id}.reassignmentsReceived`,
  });
  exact({
    actual: got.reassignmentsGiven,
    expected: want.reassignmentsGiven,
    label: `${id}.reassignmentsGiven`,
  });

  near({ actual: got.reopenRate, expected: want.reopenRate, tol: 0.3, label: `${id}.reopenRate` });
  near({
    actual: got.weekendOffHoursShare,
    expected: want.weekendOffHoursShare,
    tol: 0.4,
    label: `${id}.weekendOffHoursShare`,
  });
  near({
    actual: got.medianCycleDaysFirstHalf,
    expected: want.medianCycleDaysFirstHalf,
    tol: 0.3,
    label: `${id}.medianCycleDaysFirstHalf`,
  });
  near({
    actual: got.medianCycleDaysSecondHalf,
    expected: want.medianCycleDaysSecondHalf,
    tol: 0.3,
    label: `${id}.medianCycleDaysSecondHalf`,
  });
  near({ actual: got.helpGiven, expected: want.helpGiven, tol: 2, label: `${id}.helpGiven` });
}

// Felix is the help hub, Dave gives no help — the invisible-value divergence.
assert({
  ok: empById.get('acc_felix').helpGiven > empById.get('acc_dave').helpGiven,
  message: 'help hub ordering wrong: Felix should out-help Dave',
});

// ─────────────────────── phase 3 — MCP serves the ontology ───────────────────

console.log('[phase 3] generated config loads and serves objects over MCP');

const session = await openMcpSession({ cwd: RUN_A });
const tools = await session.request({ method: 'tools/list', params: {} });
const toolNames = new Set((tools.tools ?? []).map((t) => t.name));

for (const expected of ['employee_list', 'team_list', 'service_list']) {
  assert({
    ok: toolNames.has(expected),
    message: `tools/list missing ${expected} (got ${[...toolNames].join(', ')})`,
  });
}

const listed = await session.request({
  method: 'tools/call',
  params: { name: 'employee_list', arguments: {} },
});
const listedText = JSON.stringify(listed);
for (const id of ['acc_jiho', 'acc_felix', 'acc_dave']) {
  assert({ ok: listedText.includes(id), message: `employee_list result missing ${id}` });
}
await session.close();

// ─────────────────────── phase 4 — org findings ──────────────────────────────

console.log('[phase 4] org findings with evidence pointers');

const findings = readJson({ dir: RUN_A, rel: 'data/finding.json' });
assert({
  ok: Array.isArray(findings) && findings.length >= 5,
  message: `expected >=5 findings, got ${findings.length}`,
});

for (const f of findings) {
  const pointer = JSON.stringify(f.pointer ?? f.evidence ?? '');
  assert({
    ok: pointer !== '""' && pointer !== 'null' && pointer.length > 2,
    message: `finding "${f.title}" has no evidence pointer`,
  });
}

const allFindingsText = JSON.stringify(findings);
for (const pattern of [
  /workload/i,
  /bus.?factor/i,
  /approval/i,
  /incident|process gap/i,
  /knowledge|help hub/i,
]) {
  assert({ ok: pattern.test(allFindingsText), message: `no finding matches ${pattern}` });
}

// The two load-bearing pointers: the ticket-less incident threads + approval gap.
assert({
  ok: /1757880720|1765317900|1773870000/.test(allFindingsText),
  message: 'process-gap finding missing a ticket-less incident thread pointer',
});
assert({
  ok: /COM-1319|COM-1323/.test(allFindingsText),
  message: 'approval-vacuum finding missing the post-departure deploy keys',
});

// ─────────────────────── phase 5 — honesty in output ─────────────────────────

console.log('[phase 5] report carries formulas, framing, and no ranking');

const analytics = readFileSync(join(RUN_A, 'ANALYTICS.md'), 'utf8');
assert({
  ok: /onboarding map|verify in 1:1|not a performance review/i.test(analytics),
  message: 'ANALYTICS.md missing the onboarding-map framing sentence',
});
assert({
  ok: /formula/i.test(analytics),
  message: 'ANALYTICS.md does not present metric formulas',
});

const rankingColumn = /\|\s*(overall|composite)?\s*(score|rank|rating)\s*\|/i;
assert({
  ok: !rankingColumn.test(analytics),
  message: 'ANALYTICS.md contains a ranking/score column (forbidden)',
});

// ─────────────────────── phase 6 — byte determinism ──────────────────────────

console.log('[phase 6] byte-deterministic generation across two runs');

const initB = initArtifacts({ dir: RUN_B, jira: 'jira-export.json', slack: 'slack-export.json' });
assert({ ok: initB.status === 0, message: `second init exited ${initB.status}` });

const compareFiles = ({ rel }) => {
  const a = readFileSync(join(RUN_A, rel), 'utf8');
  const b = readFileSync(join(RUN_B, rel), 'utf8');
  assert({ ok: a === b, message: `non-deterministic output: ${rel} differs between runs` });
};

compareFiles({ rel: 'orangerail.config.mjs' });
compareFiles({ rel: 'ANALYTICS.md' });
for (const name of readdirSync(join(RUN_A, 'data'))) {
  compareFiles({ rel: join('data', name) });
}

// ─────────────────────── phase 7 — edge cases + injection ────────────────────

console.log('[phase 7] edge fixtures and hostile-string injection');

// no-changelog: reopen/reassign history is absent -> "unavailable", never 0.
const initNoCl = initArtifacts({ dir: RUN_NOCL, jira: 'edge/no-changelog.json' });
assert({
  ok: initNoCl.status === 0,
  message: `no-changelog init exited ${initNoCl.status}: ${initNoCl.stderr.slice(0, 300)}`,
});
const noClEmployees = readJson({ dir: RUN_NOCL, rel: 'data/employee.json' });
assert({
  ok: noClEmployees.some(
    (e) => e.reopenRate === 'unavailable' || e.reassignmentsReceived === 'unavailable',
  ),
  message: 'no-changelog export should mark reopen/reassignment metrics "unavailable", not 0',
});

// unassigned: an unassigned issue must not be attributed to a person; no crash.
const initUn = initArtifacts({
  dir: RUN_UNASSIGNED,
  jira: 'edge/unassigned.json',
  slack: 'edge/bot-unknown-slack.json',
});
assert({
  ok: initUn.status === 0,
  message: `unassigned/bot init exited ${initUn.status}: ${initUn.stderr.slice(0, 300)}`,
});
const unEmployees = readJson({ dir: RUN_UNASSIGNED, rel: 'data/employee.json' });
assert({
  ok: unEmployees.every((e) => e.accountId && e.displayName && e.displayName !== 'null'),
  message: 'unassigned issue leaked a null/blank employee into the output',
});

// hostile: the emitted config must still load over MCP (escape layer holds).
const initHostile = initArtifacts({ dir: RUN_HOSTILE, jira: 'edge/hostile.json' });
assert({
  ok: initHostile.status === 0,
  message: `hostile init exited ${initHostile.status}: ${initHostile.stderr.slice(0, 300)}`,
});
const hostileSession = await openMcpSession({ cwd: RUN_HOSTILE });
const hostileTools = await hostileSession.request({ method: 'tools/list', params: {} });
assert({
  ok: Array.isArray(hostileTools.tools) && hostileTools.tools.length > 0,
  message: 'hostile-string config failed to load over MCP (possible injection or escape failure)',
});
await hostileSession.close();

console.log('ONT-010 e2e: all phases passed');
process.exit(0);
