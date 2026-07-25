/**
 * ONT-020 e2e driver — agent-fleet governance view + the `agent` source category.
 *
 * Pure Node stdlib plus the agent-browser CLI (direct Playwright is forbidden
 * repo-wide). It runs the SHIPPED pipeline: a run dir is seeded with the ont-010
 * fixture exports, `orangerail init --from-jira --from-slack` generates a bootable
 * config + data/*.json, the canonical agent-fleet sample manifest is dropped in as
 * `data/fleet.json`, then `orangerail studio --no-open` serves it and a real
 * browser is driven through agent-browser to prove the fleet-governance surface.
 *
 * ── UI CONTRACT (the implementer MUST satisfy this exactly) ──────────────────
 *
 * ENDPOINT
 *   GET /api/fleet returns the derived AgentFleetSnapshot JSON:
 *     - agentCount === 12
 *     - authorityOverlaps contains { action:'issueRefund', object:'Refund',
 *       agents:['billing-agent','refund-agent'] }
 *     - blastRadius for 'ops-supervisor' has directObjects.length 1 and
 *       effectiveObjects.length 12 and unbounded === true
 *     - ungatedDestructiveActions === [{ agentId:'data-cleanup-agent',
 *       action:'deleteTicket', object:'Ticket' }]
 *   A project with no data/fleet.json serves the empty snapshot (agentCount 0).
 *
 * CATEGORY TAB + VIEW
 *   [data-testid="category-tab-agent"] is present and selectable; selecting it
 *   renders [data-testid="fleet-view"], which contains:
 *     - one [data-testid="fleet-ungated-row"] (the deleteTicket alert)
 *     - twelve [data-testid="fleet-blast-row"] (one per agent)
 *     - the ops-supervisor blast row text shows "1 direct" and "12 effective"
 *     - two [data-testid="fleet-overlap-row"], one [data-testid="fleet-cycle-row"],
 *       one [data-testid="fleet-spawner-row"]
 *
 * HONESTY
 *   the fleet-view text contains NO match for /overall score|composite score|
 *   rank #?\d/i (counts only, no ranking).
 *
 * RED (pre-implementation): GET /api/fleet 404s and the agent tab / fleet-view
 * testids do not exist, so Phase 1's /api/fleet assertion fails first.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-010');
const SAMPLE_FLEET = join(ROOT, 'packages', 'studio', 'src', 'snapshot', 'agentFleet.sample.json');
const RUN_DIR = join(ROOT, '.docs', 'scratch', 'ont-020-run');
const PORT = 4887;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION = `ont020-e2e-${process.pid}`;

const fail = ({ message }) => {
  console.error(`ONT-020 e2e FAIL: ${message}`);
  throw new Error(message);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const childEnv = () => {
  const env = { ...process.env };
  delete env.AGENT_BROWSER_HEADED;
  return env;
};

const abSpawn = ({ args, input }) =>
  spawnSync('agent-browser', ['--session', SESSION, ...args], {
    cwd: ROOT,
    env: childEnv(),
    encoding: 'utf8',
    input,
    timeout: 90_000,
  });

/** Run an agent-browser subcommand; retry a cold-start spawn failure ONCE. */
const ab = ({ args, input }) => {
  let res = abSpawn({ args, input });

  if (res.error) {
    sleepSync(3000);
    res = abSpawn({ args, input });
  }

  if (res.error) {
    fail({ message: `agent-browser ${args.join(' ')} failed to spawn: ${res.error.message}` });
  }

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** Evaluate JS in the page and JSON.parse the (object/array/scalar) result. */
const abEval = ({ js }) => {
  const { stdout } = ab({ args: ['eval', '--stdin'], input: js });
  const first = stdout.indexOf('{');
  const firstArr = stdout.indexOf('[');
  const start = firstArr !== -1 && (first === -1 || firstArr < first) ? firstArr : first;

  if (start === -1) {
    return JSON.parse(stdout.trim());
  }

  const open = stdout[start];
  const close = open === '{' ? '}' : ']';
  const end = stdout.lastIndexOf(close);

  return JSON.parse(stdout.slice(start, end + 1));
};

const waitFor = async ({ label, fn, timeoutMs = 20_000, intervalMs = 500 }) => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let value;

    try {
      value = await fn();
    } catch {
      value = undefined;
    }

    if (value) {
      return value;
    }

    if (Date.now() > deadline) {
      fail({ message: `timed out waiting for: ${label}` });
    }

    await sleep(intervalMs);
  }
};

const runCli = ({ args }) =>
  spawnSync('node', [CLI, ...args], {
    cwd: RUN_DIR,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 120_000,
  });

const startStudio = async () => {
  const child = spawn(
    'node',
    [CLI, 'studio', '--config', 'orangerail.config.mjs', '--port', String(PORT), '--no-open'],
    { cwd: RUN_DIR, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] },
  );

  let exitedEarly = false;
  child.on('exit', () => {
    exitedEarly = true;
  });

  await waitFor({
    label: 'studio /api/registry to answer 200',
    timeoutMs: 30_000,
    fn: async () => {
      if (exitedEarly) {
        fail({ message: 'studio process exited before the server came up' });
      }

      const res = await fetch(`${BASE}/api/registry`).catch(() => undefined);
      return res && res.status === 200;
    },
  });

  return child;
};

const stopStudio = async ({ child }) => {
  child.kill('SIGTERM');
  await waitFor({
    label: 'studio process to exit',
    timeoutMs: 10_000,
    fn: () => child.exitCode !== null || child.signalCode !== null,
  });
};

const main = async () => {
  // ---- Setup: seed run dir, generate a bootable config, drop in the fleet ----
  console.log('Setup: seed run dir, run `orangerail init`, add data/fleet.json');
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  copyFileSync(join(FIXTURE, 'jira-export.json'), join(RUN_DIR, 'jira-export.json'));
  copyFileSync(join(FIXTURE, 'slack-export.json'), join(RUN_DIR, 'slack-export.json'));

  const init = runCli({
    args: [
      'init',
      '--config',
      'orangerail.config.mjs',
      '--no-studio',
      '--from-jira',
      'jira-export.json',
      '--from-slack',
      'slack-export.json',
    ],
  });
  assert({
    ok: init.status === 0,
    message: `init exited ${init.status}: ${(init.stderr ?? '').slice(0, 400)}`,
  });

  // The agent fleet manifest is the between-agent metadata a scan would emit; drop
  // the canonical sample beside the config as data/fleet.json.
  mkdirSync(join(RUN_DIR, 'data'), { recursive: true });
  copyFileSync(SAMPLE_FLEET, join(RUN_DIR, 'data', 'fleet.json'));

  const studio = await startStudio();

  try {
    // ---- Phase 1: the derived /api/fleet snapshot ----
    console.log('Phase 1: GET /api/fleet derives the governance snapshot');
    const fleet = await (await fetch(`${BASE}/api/fleet`)).json();

    assert({ ok: fleet.agentCount === 12, message: `agentCount ${fleet.agentCount} !== 12` });

    const refundOverlap = fleet.authorityOverlaps.find(
      (o) => o.action === 'issueRefund' && o.object === 'Refund',
    );
    assert({
      ok:
        refundOverlap &&
        JSON.stringify(refundOverlap.agents) === JSON.stringify(['billing-agent', 'refund-agent']),
      message: `issueRefund/Refund overlap missing or wrong: ${JSON.stringify(refundOverlap)}`,
    });

    const supervisor = fleet.blastRadius.find((b) => b.agentId === 'ops-supervisor');
    assert({
      ok:
        supervisor &&
        supervisor.directObjects.length === 1 &&
        supervisor.effectiveObjects.length === 12 &&
        supervisor.unbounded === true,
      message: `ops-supervisor blast radius wrong: ${JSON.stringify(supervisor)}`,
    });

    assert({
      ok:
        JSON.stringify(fleet.ungatedDestructiveActions) ===
        JSON.stringify([
          { agentId: 'data-cleanup-agent', action: 'deleteTicket', object: 'Ticket' },
        ]),
      message: `ungated destructive wrong: ${JSON.stringify(fleet.ungatedDestructiveActions)}`,
    });
    console.log('  Phase 1 OK — snapshot derives the 1→12 headline, overlap, and ungated delete');

    // ---- Phase 2: the agent category renders the fleet-governance view ----
    console.log('Phase 2: the agent category renders the fleet-view surface');
    ab({ args: ['close', '--all'] });
    ab({ args: ['open', `${BASE}/?category=agent`] });

    const dom = await waitFor({
      label: 'fleet-view to render its sections',
      fn: () => {
        const read = abEval({
          js: `(() => {
            const view = document.querySelector('[data-testid="fleet-view"]');
            if (!view) return { ready: false };
            const text = view.textContent || '';
            const blastRows = Array.from(document.querySelectorAll('[data-testid="fleet-blast-row"]'));
            const supervisor = blastRows.find((r) => r.getAttribute('data-agent-id') === 'ops-supervisor');
            return {
              ready: true,
              tabActive: document.querySelector('[data-testid="category-tab-agent"]')?.getAttribute('data-active'),
              ungated: document.querySelectorAll('[data-testid="fleet-ungated-row"]').length,
              blast: blastRows.length,
              overlaps: document.querySelectorAll('[data-testid="fleet-overlap-row"]').length,
              cycles: document.querySelectorAll('[data-testid="fleet-cycle-row"]').length,
              spawners: document.querySelectorAll('[data-testid="fleet-spawner-row"]').length,
              supervisorText: supervisor ? supervisor.textContent : '',
              dishonest: /overall score|composite score|rank #?\\d/i.test(text),
            };
          })()`,
        });
        return read.ready ? read : undefined;
      },
    });

    assert({ ok: dom.tabActive === 'true', message: `agent tab not active: ${dom.tabActive}` });
    assert({ ok: dom.ungated === 1, message: `expected 1 ungated row, got ${dom.ungated}` });
    assert({ ok: dom.blast === 12, message: `expected 12 blast rows, got ${dom.blast}` });
    assert({ ok: dom.overlaps === 2, message: `expected 2 overlap rows, got ${dom.overlaps}` });
    assert({ ok: dom.cycles === 1, message: `expected 1 cycle row, got ${dom.cycles}` });
    assert({ ok: dom.spawners === 1, message: `expected 1 spawner row, got ${dom.spawners}` });
    assert({
      ok: /1 direct/.test(dom.supervisorText) && /12 effective/.test(dom.supervisorText),
      message: `ops-supervisor blast row text missing 1→12: ${dom.supervisorText}`,
    });
    assert({ ok: dom.dishonest === false, message: 'fleet-view leaked a score/ranking' });
    console.log('  Phase 2 OK — agent tab active, all sections render, no score/ranking');

    ab({ args: ['close', '--all'] });
  } finally {
    await stopStudio({ child: studio });
  }

  console.log('ONT-020 agent-fleet-governance scenario: all assertions passed');
};

main().catch(() => process.exit(1));
