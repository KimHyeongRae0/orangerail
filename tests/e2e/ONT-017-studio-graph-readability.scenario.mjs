/**
 * ONT-017 e2e driver — studio graph-readability overhaul (focus+context network,
 * help adjacency matrix, people<->services ownership bipartite).
 *
 * Pure Node stdlib plus the agent-browser CLI (direct Playwright is forbidden
 * repo-wide). It runs the SHIPPED ONT-010 -> ONT-011 pipeline end to end: a run
 * dir under .docs/scratch is seeded with the ont-010 fixture Jira/Slack exports,
 * `orangerail init --from-jira --from-slack` generates the human-source config +
 * data/*.json, then `orangerail studio --no-open` serves it and a real browser is
 * driven through agent-browser to prove the readability surface. This extends the
 * ONT-011 instance graph; every ONT-011 invariant is re-asserted.
 *
 * ── UI CONTRACT (the implementer MUST satisfy this exactly) ──────────────────
 *
 * ENDPOINT (unchanged from ONT-011 — re-asserted here)
 *   GET /api/instances returns the InstanceSnapshot JSON (employees/services/
 *   teams/incidents + edges.{helps,works_on,member_of}[{from,to,weight}]).
 *   Non-GET (POST) -> 405 on BOTH /api/instances and /api/registry (read-only).
 *   A second fetch of each endpoint is BYTE-IDENTICAL (snapshot determinism).
 *
 * VIEW SWITCHER (human category only — AC-1)
 *   [data-testid="view-tab-network"]     segmented control (role="tab")
 *   [data-testid="view-tab-matrix"]      "  , marks active via data-active /
 *   [data-testid="view-tab-ownership"]   "    aria-selected (the e2e reads either)
 *   Default active view is "network". Clicking a tab round-trips the choice into
 *   the URL as `?view=network|matrix|ownership` (mirroring `?category=`).
 *   Network + Ownership render `.react-flow__node`; Matrix renders
 *   [data-testid="help-matrix"] with a grid of [data-testid="matrix-cell"].
 *   The db category is UNAFFECTED and shows NONE of the human-only controls.
 *
 * NETWORK — declutter + focus+context (AC-2)
 *   Node size is CAPPED: every rendered [data-instance-kind="person"] element has
 *   an intrinsic box (offsetWidth) <= 2 * RADIUS_MAX, with RADIUS_MAX = 40 (so the
 *   cap is 80px; ONT-011 shipped a 64px radius -> 128px box, so this is a genuine
 *   change). NO two rendered `.react-flow__node` bounding boxes overlap (the
 *   collision-free invariant). By default only ONE relationship family renders
 *   (`helps`): the rendered `.react-flow__edge` count equals edges.helps.length.
 *   A relationship segmented control switches the single family:
 *     [data-testid="relationship-tab-helps"] (default)
 *     [data-testid="relationship-tab-works_on"]
 *     [data-testid="relationship-tab-member_of"]
 *   Selecting works_on makes the edge count equal edges.works_on.length.
 *   A weight-threshold stepper [data-testid="weight-threshold"] with an increment
 *   button [data-testid="weight-threshold-inc"] (and a decrement
 *   [data-testid="weight-threshold-dec"]) raises the minimum edge weight; raising
 *   it strictly REDUCES the rendered edge count (weak ties drop out).
 *   FOCUS MODE: clicking a person marks every non-ego node `data-dim="true"` and
 *   leaves the ego node undimmed; the ego's works_on service(s) appear even under
 *   the `helps` relationship; a pane click clears the selection and removes every
 *   `data-dim` (overview restored).
 *
 * MATRIX — person x person `helps` adjacency (AC-3)
 *   [data-testid="help-matrix"] root; [data-testid="matrix-row"] rows;
 *   [data-testid="matrix-col-header"] column headers; [data-testid="matrix-cell"]
 *   cells carrying data-from / data-to / data-weight. Cell intensity encodes
 *   weight (no edges -> crossing-free by construction). Degree-ordered so a help
 *   hub reads as a dense row: the account with the most weighted cells is the
 *   snapshot's top help out-degree account, and its weighted-cell count exceeds a
 *   low-degree account's. Hovering a row/column sets data-hover="true". Every
 *   label/header is React text only (no dangerouslySetInnerHTML) — a hostile
 *   displayName renders inert. NO [data-testid="rank"] and NO composite-score /
 *   ranking text (honesty).
 *
 * OWNERSHIP — people <-> services bipartite (AC-4)
 *   `.react-flow__node` people and services in two DISJOINT x-ranges (bipartite
 *   columns); the person nodes' max x is left of the service nodes' min x (or
 *   vice-versa) with no overlap, and `works_on` edges connect them.
 *
 * INVARIANTS (AC-5) — the injected hostile displayName renders inert in a Network
 *   node AND a Matrix header/cell (window.__ont_xss unset, zero img[onerror]);
 *   POST -> 405 and byte-stable refetch on both endpoints; the person scorecard
 *   still shows evidence metrics with NO rank/score; the db map still renders.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Browser setup notes (baked in for determinism + robustness, copied from ONT-011):
 *   - HEADLESS: AGENT_BROWSER_HEADED is scrubbed from the child env so no window
 *     is ever shown during a gate run.
 *   - RESET + FRESH SESSION: `agent-browser close --all` runs before the browser
 *     is opened, and a unique per-run `--session` name is used. This session has
 *     shown agent-browser cold-start `spawnSync ETIMEDOUT` under load, so the
 *     ab() wrapper uses a >=90s spawn timeout and retries a spawn failure ONCE
 *     after a short wait before failing. A screenshot ETIMEDOUT triggers a
 *     `close --all` reset + one retry. The reset + retry are load-bearing.
 *   - The only navigation target is http://127.0.0.1:<port>; no external site is
 *     opened and there is no authentication anywhere in this flow.
 *
 * RED (pre-implementation): the human category has no view switcher, so Phase 2's
 * assertion that [data-testid="view-tab-matrix"] / -ownership exist fails first
 * with a clear message — none of the readability surface is built yet.
 */
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-010');
const RUN_DIR = join(ROOT, '.docs', 'scratch', 'ont-017-run');
const EMPLOYEE_JSON = join(RUN_DIR, 'data', 'employee.json');
const SHOT_DIR = join(ROOT, '.docs', 'scratch', 'ONT-017-shots');

const PORT = 4887;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION = `ont017-e2e-${process.pid}`;

// The RADIUS_MAX the plan (section 3.2a) reduces the person radius clamp to; the
// rendered person box must be capped at twice this. ONT-011 shipped 64.
const RADIUS_MAX = 40;

// A hostile displayName injected into one NON-Felix employee before the studio
// starts, so the instance text-rendering path is exercised against markup in
// both the Network node and the Matrix header/cell.
const HOSTILE = '<img src=x onerror="window.__ont_xss=1">ZedHostile';

const fail = ({ message }) => {
  console.error(`ONT-017 e2e FAIL: ${message}`);
  throw new Error(message);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Synchronous sleep for the ab() retry backoff (ab is spawnSync-based). */
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Child env with the headed override scrubbed (deterministic headless runs). */
const childEnv = () => {
  const env = { ...process.env };
  delete env.AGENT_BROWSER_HEADED;
  return env;
};

/** Reset agent-browser (close every session); ignore failure (best-effort). */
const closeAll = () => {
  spawnSync('agent-browser', ['close', '--all'], {
    env: childEnv(),
    encoding: 'utf8',
    timeout: 90_000,
  });
};

const abSpawn = ({ args, input }) =>
  spawnSync('agent-browser', ['--session', SESSION, ...args], {
    cwd: ROOT,
    env: childEnv(),
    encoding: 'utf8',
    input,
    timeout: 90_000,
  });

/**
 * Run an agent-browser subcommand in the isolated session; return stdout.
 * Retries a spawn failure (e.g. cold-start ETIMEDOUT under load) ONCE.
 */
const ab = ({ args, input }) => {
  let res = abSpawn({ args, input });

  if (res.error) {
    console.error(
      `agent-browser ${args.join(' ')} spawn error (${res.error.code ?? res.error.message}); retrying once`,
    );
    sleepSync(3000);
    res = abSpawn({ args, input });
  }

  if (res.error) {
    fail({ message: `agent-browser ${args.join(' ')} failed to spawn: ${res.error.message}` });
  }

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/**
 * Take a screenshot, tolerating the long-session ETIMEDOUT flake: on a spawn
 * error, reset agent-browser (`close --all`) and retry once. A screenshot is a
 * DEV-01 archival artifact, never an assertion, so a residual failure is logged
 * and swallowed rather than aborting the gate.
 */
const abShot = ({ path }) => {
  let res = abSpawn({ args: ['screenshot', path] });

  if (res.error) {
    console.error(
      `screenshot ${path} spawn error (${res.error.code ?? res.error.message}); reset + retry once`,
    );
    closeAll();
    sleepSync(3000);
    res = abSpawn({ args: ['screenshot', path] });
  }

  if (res.error) {
    console.error(`screenshot ${path} still failing after reset; continuing (archival only)`);
  }
};

/** Evaluate JS in the page and JSON.parse the result (object/array/scalar). */
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

/** Poll an async predicate until it returns truthy or the timeout elapses. */
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

/** A single raw HTTP request (used for the non-GET -> 405 check). */
const rawRequest = ({ method, path }) =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, method, path }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });

/** Run an `orangerail` command to completion inside the run dir. */
const runCli = ({ args }) =>
  spawnSync('node', [CLI, ...args], {
    cwd: RUN_DIR,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 120_000,
  });

/** Start the studio server in the run dir; resolve once /api/registry answers 200. */
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

/** Ensure a category tab is selected. */
const selectCategory = ({ category }) => {
  ab({ args: ['click', `[data-testid="category-tab-${category}"]`] });
};

/** Select a view mode (network / matrix / ownership) via the view switcher. */
const selectView = ({ view }) => {
  ab({ args: ['click', `[data-testid="view-tab-${view}"]`] });
};

/** Read whether the human-category view switcher exists and which view is active. */
const readViewTabs = () =>
  abEval({
    js: `(() => {
      const tab = (v) => document.querySelector('[data-testid="view-tab-' + v + '"]');
      const active = (el) => !!el && (el.getAttribute('data-active') === 'true' || el.getAttribute('aria-selected') === 'true');
      return {
        network: !!tab('network'),
        matrix: !!tab('matrix'),
        ownership: !!tab('ownership'),
        networkActive: active(tab('network')),
        matrixActive: active(tab('matrix')),
        ownershipActive: active(tab('ownership')),
        view: new URLSearchParams(window.location.search).get('view'),
      };
    })()`,
  });

/**
 * Read the network-view DOM: node/edge counts, the largest intrinsic person box
 * (offsetWidth, which is unaffected by the React Flow viewport zoom, so the cap
 * is measured in graph units), and the number of overlapping node bounding-box
 * pairs (client rects — overlap is invariant under the shared uniform viewport
 * transform, so a screen-space test answers the graph-space question).
 */
const readNetwork = () =>
  abEval({
    js: `(() => {
      const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const persons = Array.from(document.querySelectorAll('[data-instance-kind="person"]'));
      const services = Array.from(document.querySelectorAll('[data-instance-kind="service"]'));
      const maxPersonBox = persons.reduce((m, el) => Math.max(m, el.offsetWidth, el.offsetHeight), 0);

      const rects = nodes.map((n) => n.getBoundingClientRect());
      let overlaps = 0;
      let sample = '';
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 1 && oy > 1) {
            overlaps++;
            if (!sample) {
              sample = (nodes[i].getAttribute('data-id') || i) + ' <> ' + (nodes[j].getAttribute('data-id') || j);
            }
          }
        }
      }

      const graphText = nodes.map((n) => n.textContent).join(' \\u241F ');
      return {
        nodeCount: nodes.length,
        personCount: persons.length,
        serviceCount: services.length,
        edgeCount: document.querySelectorAll('.react-flow__edge').length,
        maxPersonBox,
        overlaps,
        overlapSample: sample,
        dimmedCount: document.querySelectorAll('[data-dim="true"]').length,
        felixDimmed: (() => {
          const felix = persons.find((p) => /Felix Braun/.test(p.textContent));
          return felix ? felix.getAttribute('data-dim') === 'true' : null;
        })(),
        hasFelix: /Felix Braun/.test(graphText),
        hostileAsText: graphText.includes('ZedHostile'),
        reloadError: !!document.querySelector('[data-testid="reload-error"]'),
        xss: window.__ont_xss,
        injectedImg: document.querySelectorAll('img[onerror]').length,
        title: document.title,
      };
    })()`,
  });

/** Click the person node named "Felix Braun" via a synthetic DOM click. */
const clickFelix = () =>
  abEval({
    js: `(() => {
      const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const withKind = nodes.filter((n) => n.querySelector('[data-instance-kind="person"]') || n.matches('[data-instance-kind="person"]'));
      const pool = withKind.length ? withKind : nodes;
      const target = pool.find((n) => /Felix Braun/.test(n.textContent));
      if (!target) return { clicked: false };
      const el = target.querySelector('[data-instance-kind="person"]') || target;
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { clicked: true };
    })()`,
  });

/** Click the empty canvas to clear the selection (restore the overview). */
const clickPane = () =>
  abEval({
    js: `(() => {
      const pane = document.querySelector('.react-flow__pane');
      if (!pane) return { clicked: false };
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        pane.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { clicked: true };
    })()`,
  });

/** Read the help-matrix DOM contract (grid, per-account weighted cell counts). */
const readMatrix = () =>
  abEval({
    js: `(() => {
      const root = document.querySelector('[data-testid="help-matrix"]');
      const cells = Array.from(document.querySelectorAll('[data-testid="matrix-cell"]'));
      const rows = document.querySelectorAll('[data-testid="matrix-row"]').length;
      const headers = document.querySelectorAll('[data-testid="matrix-col-header"]').length;

      const weightedByFrom = {};
      for (const c of cells) {
        const w = Number(c.getAttribute('data-weight'));
        if (Number.isFinite(w) && w > 0) {
          const from = c.getAttribute('data-from') || '';
          weightedByFrom[from] = (weightedByFrom[from] || 0) + 1;
        }
      }

      const text = root ? root.textContent : '';
      return {
        present: !!root,
        cellCount: cells.length,
        rows,
        headers,
        weightedByFrom,
        hostileAsText: text.includes('ZedHostile'),
        rankEl: document.querySelectorAll('[data-testid="rank"]').length,
        hasScoreText: /overall score|composite score|rank #\\d/i.test(text),
        xss: window.__ont_xss,
        injectedImg: document.querySelectorAll('img[onerror]').length,
      };
    })()`,
  });

/** Hover the first matrix row and report whether it gained data-hover. */
const hoverFirstMatrixRow = () =>
  abEval({
    js: `(() => {
      const row = document.querySelector('[data-testid="matrix-row"]');
      if (!row) return { hovered: false, has: false };
      for (const type of ['pointerover', 'mouseover', 'mouseenter']) {
        row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { hovered: true, has: row.getAttribute('data-hover') === 'true' };
    })()`,
  });

/** Read the ownership bipartite layout: people vs service node x-ranges. */
const readOwnership = () =>
  abEval({
    js: `(() => {
      const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const boxOf = (sel) =>
        nodes
          .filter((n) => n.querySelector(sel) || n.matches(sel))
          .map((n) => n.getBoundingClientRect());
      const persons = boxOf('[data-instance-kind="person"]');
      const services = boxOf('[data-instance-kind="service"]');
      const centre = (r) => (r.left + r.right) / 2;
      const pxs = persons.map(centre);
      const sxs = services.map(centre);
      return {
        nodeCount: nodes.length,
        personCount: persons.length,
        serviceCount: services.length,
        edgeCount: document.querySelectorAll('.react-flow__edge').length,
        personMaxX: pxs.length ? Math.max(...pxs) : null,
        personMinX: pxs.length ? Math.min(...pxs) : null,
        serviceMaxX: sxs.length ? Math.max(...sxs) : null,
        serviceMinX: sxs.length ? Math.min(...sxs) : null,
      };
    })()`,
  });

/** Read the scorecard panel contract (text + negative ranking assertions). */
const readScorecard = () =>
  abEval({
    js: `(() => {
      const panel = document.querySelector('[data-testid="scorecard"]');
      const text = panel ? panel.textContent : '';
      return {
        open: !!panel,
        text,
        rankEl: document.querySelectorAll('[data-testid="rank"]').length,
      };
    })()`,
  });

/** True when the human-only view switcher is absent (db category must hide it). */
const readDbControls = () =>
  abEval({
    js: `(() => ({
      objectNode: document.querySelectorAll('[data-testid="object-node"]').length,
      hasReactFlow: !!document.querySelector('.react-flow'),
      reloadError: !!document.querySelector('[data-testid="reload-error"]'),
      viewSwitcher: !!document.querySelector('[data-testid="view-tab-matrix"]'),
    }))()`,
  });

/** Out-degree (distinct weighted targets) per help giver, from the wire snapshot. */
const helpOutDegree = ({ helps }) => {
  const byFrom = new Map();
  for (const e of helps) {
    if (e.weight > 0) {
      const set = byFrom.get(e.from) ?? new Set();
      set.add(e.to);
      byFrom.set(e.from, set);
    }
  }
  return byFrom;
};

const main = async () => {
  // ---- Setup: seed run dir + generate the human-source config via the CLI ----
  console.log('Setup: seed run dir and run `orangerail init --from-jira --from-slack`');
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });

  copyFileSync(join(FIXTURE, 'jira-export.json'), join(RUN_DIR, 'jira-export.json'));
  copyFileSync(join(FIXTURE, 'slack-export.json'), join(RUN_DIR, 'slack-export.json'));

  const init = runCli({
    args: [
      'init',
      '--yes',
      '--no-studio',
      '--no-docs',
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

  // Inject a hostile displayName into one NON-Felix employee (safety phase).
  const employees = JSON.parse(readFileSync(EMPLOYEE_JSON, 'utf8'));
  const victim = employees.find((e) => e.displayName !== 'Felix Braun');
  assert({ ok: !!victim, message: 'no non-Felix employee to inject a hostile name into' });
  victim.displayName = HOSTILE;
  writeFileSync(EMPLOYEE_JSON, JSON.stringify(employees, null, 2), 'utf8');

  // Reset agent-browser before opening (cold-start robustness); ignore failure.
  closeAll();

  const child = await startStudio();

  try {
    // ---- Phase 1: wire contract + ONT-011 read-only / byte-stability invariants ----
    console.log('Phase 1: /api/instances wire contract + read-only invariants');
    const instText1 = await (await fetch(`${BASE}/api/instances`)).text();
    const instances = JSON.parse(instText1);
    for (const key of ['employees', 'services', 'teams', 'incidents']) {
      assert({
        ok: Array.isArray(instances[key]),
        message: `/api/instances must expose an array "${key}"`,
      });
    }
    assert({
      ok: instances.employees.length === 11,
      message: `/api/instances employees length must be 11 (got ${instances.employees.length})`,
    });

    const edges = instances.edges ?? {};
    for (const key of ['helps', 'works_on', 'member_of']) {
      assert({
        ok: Array.isArray(edges[key]),
        message: `/api/instances edges.${key} must be an array`,
      });
    }
    assert({ ok: edges.helps.length > 0, message: '/api/instances edges.helps must be non-empty' });
    assert({
      ok: edges.works_on.length > 0,
      message: '/api/instances edges.works_on must be non-empty',
    });

    // Non-GET -> 405 on BOTH read-only endpoints.
    for (const path of ['/api/instances', '/api/registry']) {
      const post = await rawRequest({ method: 'POST', path });
      assert({ ok: post.status === 405, message: `POST ${path} must be 405 (got ${post.status})` });
    }

    // Byte-identical refetch (snapshot determinism) for BOTH endpoints.
    const instText2 = await (await fetch(`${BASE}/api/instances`)).text();
    assert({
      ok: instText1 === instText2,
      message: '/api/instances must be byte-identical on a second fetch (snapshot determinism)',
    });
    const regText1 = await (await fetch(`${BASE}/api/registry`)).text();
    const regText2 = await (await fetch(`${BASE}/api/registry`)).text();
    assert({
      ok: regText1 === regText2,
      message: '/api/registry must be byte-identical on a second fetch',
    });
    const registry = JSON.parse(regText1);
    assert({
      ok: Array.isArray(registry.objects) && registry.objects.length > 0,
      message: '/api/registry must still return a GraphSnapshot with object types',
    });

    // ---- Phase 2: page load + human view switcher (AC-1) ----
    console.log('Phase 2: view switcher — Network / Matrix / Ownership + ?view round-trip');
    ab({ args: ['--args', '--no-first-run,--no-default-browser-check', 'open', `${BASE}/`] });

    await waitFor({
      label: 'the human category tab to render',
      fn: () => {
        const t = abEval({
          js: `(() => ({ human: !!document.querySelector('[data-testid="category-tab-human"]') }))()`,
        });
        return t.human ? t : undefined;
      },
    });
    selectCategory({ category: 'human' });

    const tabs = await waitFor({
      label: 'the human-category view switcher (network/matrix/ownership tabs)',
      fn: () => {
        const t = readViewTabs();
        return t.network && t.matrix && t.ownership ? t : undefined;
      },
    });
    assert({
      ok: tabs.network && tabs.matrix && tabs.ownership,
      message: 'the human category must expose view-tab-network / -matrix / -ownership',
    });
    assert({
      ok: tabs.networkActive,
      message: 'the default active view must be "network"',
    });

    // ?view round-trip: switching to matrix writes ?view=matrix.
    selectView({ view: 'matrix' });
    const matrixUrl = await waitFor({
      label: 'the ?view=matrix URL round-trip',
      fn: () => {
        const t = readViewTabs();
        return t.view === 'matrix' && t.matrixActive ? t : undefined;
      },
    });
    assert({
      ok: matrixUrl.view === 'matrix',
      message: `switching to the matrix view must round-trip ?view=matrix (got ?view=${matrixUrl.view})`,
    });

    // Back to network for the declutter phase.
    selectView({ view: 'network' });
    await waitFor({
      label: 'the network view to become active again',
      fn: () => {
        const t = readViewTabs();
        return t.networkActive && t.view === 'network' ? t : undefined;
      },
    });

    // ---- Phase 3: Network declutter (AC-2) ----
    console.log(
      'Phase 3: Network — node-size cap, collision-free layout, one relationship, threshold',
    );
    const net = await waitFor({
      label: 'the network view to render person + service nodes',
      fn: () => {
        const g = readNetwork();
        return g.personCount >= 11 && g.edgeCount > 0 ? g : undefined;
      },
    });

    assert({
      ok: net.maxPersonBox > 0 && net.maxPersonBox <= 2 * RADIUS_MAX + 1,
      message: `person node box must be capped at 2*RADIUS_MAX (${2 * RADIUS_MAX}px); largest is ${net.maxPersonBox}px`,
    });
    assert({
      ok: net.overlaps === 0,
      message: `no two network nodes may overlap; found ${net.overlaps} overlapping pair(s) (e.g. ${net.overlapSample})`,
    });
    assert({
      ok: net.edgeCount === edges.helps.length,
      message: `only the default helps family must render (expected ${edges.helps.length} edges, got ${net.edgeCount})`,
    });

    abShot({ path: join(SHOT_DIR, 'network-overview.png') });

    // Relationship single-select: switch to works_on.
    ab({ args: ['click', '[data-testid="relationship-tab-works_on"]'] });
    const worksOnEdges = await waitFor({
      label: 'the relationship switch to works_on to change the edge set',
      fn: () => {
        const g = readNetwork();
        return g.edgeCount === edges.works_on.length ? g.edgeCount : undefined;
      },
    });
    assert({
      ok: worksOnEdges === edges.works_on.length,
      message: `selecting works_on must render exactly ${edges.works_on.length} edges (got ${worksOnEdges})`,
    });

    // Back to helps for the threshold + focus phases.
    ab({ args: ['click', '[data-testid="relationship-tab-helps"]'] });
    const helpsAgain = await waitFor({
      label: 'the relationship switch back to helps',
      fn: () => {
        const g = readNetwork();
        return g.edgeCount === edges.helps.length ? g.edgeCount : undefined;
      },
    });

    // Weight-threshold stepper: raising the threshold reduces the edge count.
    ab({ args: ['click', '[data-testid="weight-threshold-inc"]'] });
    const thresholded = await waitFor({
      label: 'the weight-threshold increment to reduce the edge count',
      fn: () => {
        const g = readNetwork();
        return g.edgeCount < helpsAgain ? g.edgeCount : undefined;
      },
    });
    assert({
      ok: thresholded < helpsAgain,
      message: `raising the weight threshold must reduce the edge count (before ${helpsAgain}, after ${thresholded})`,
    });

    // Restore the threshold for the focus phase (helps overview).
    ab({ args: ['click', '[data-testid="weight-threshold-dec"]'] });
    await waitFor({
      label: 'the weight-threshold decrement to restore the helps overview',
      fn: () => {
        const g = readNetwork();
        return g.edgeCount === edges.helps.length ? g : undefined;
      },
    });

    // ---- Phase 4: Network focus mode (AC-2) ----
    console.log('Phase 4: Network focus mode — select a person, non-ego nodes fade');
    const felixClick = clickFelix();
    assert({
      ok: felixClick.clicked,
      message: 'could not locate the Felix Braun person node to click',
    });

    const focused = await waitFor({
      label: 'focus mode to dim the non-ego nodes',
      fn: () => {
        const g = readNetwork();
        return g.dimmedCount > 0 ? g : undefined;
      },
    });
    assert({
      ok: focused.dimmedCount > 0,
      message: 'selecting a person must dim non-ego nodes (data-dim="true" count > 0)',
    });
    assert({
      ok: focused.felixDimmed === false,
      message: 'the selected ego (Felix Braun) node must NOT be dimmed',
    });
    assert({
      ok: focused.serviceCount >= 1,
      message: 'the ego works_on service(s) must appear in focus even under the helps relationship',
    });

    abShot({ path: join(SHOT_DIR, 'network-focus.png') });

    // Clearing the selection restores the overview (no dim).
    clickPane();
    await waitFor({
      label: 'a pane click to clear the focus (no dimmed nodes)',
      fn: () => {
        const g = readNetwork();
        return g.dimmedCount === 0 ? g : undefined;
      },
    });

    // ---- Phase 5: Matrix view (AC-3) ----
    console.log('Phase 5: Matrix — person x person helps adjacency, degree-ordered hub');
    selectView({ view: 'matrix' });

    const matrix = await waitFor({
      label: 'the help-matrix grid to render',
      fn: () => {
        const m = readMatrix();
        return m.present && m.cellCount > 0 ? m : undefined;
      },
    });
    assert({
      ok: matrix.present,
      message: 'the matrix view must render [data-testid="help-matrix"]',
    });
    assert({
      ok: matrix.rows >= 11,
      message: `the matrix must render a row per person (got ${matrix.rows})`,
    });
    assert({
      ok: matrix.headers >= 11,
      message: `the matrix must render a column header per person (got ${matrix.headers})`,
    });

    // Degree-ordered: the densest row is the snapshot's top help out-degree account.
    const outDegree = helpOutDegree({ helps: edges.helps });
    let topFrom = null;
    let topDeg = -1;
    for (const [from, set] of outDegree) {
      if (set.size > topDeg) {
        topDeg = set.size;
        topFrom = from;
      }
    }
    const domCounts = matrix.weightedByFrom;
    let domTopFrom = null;
    let domTopCount = -1;
    for (const [from, count] of Object.entries(domCounts)) {
      if (count > domTopCount) {
        domTopCount = count;
        domTopFrom = from;
      }
    }
    assert({
      ok: domTopFrom === topFrom,
      message: `the densest matrix row must be the top help-giver ${topFrom} (DOM densest was ${domTopFrom})`,
    });
    const lowFrom = [...outDegree.entries()].sort((a, b) => a[1].size - b[1].size)[0]?.[0];
    assert({
      ok: lowFrom !== undefined && (domCounts[domTopFrom] ?? 0) > (domCounts[lowFrom] ?? 0),
      message: 'a help hub must read as a denser row than a low-degree person',
    });

    // Row/column hover highlight.
    const hover = hoverFirstMatrixRow();
    assert({
      ok: hover.hovered && hover.has,
      message: 'hovering a matrix row must set data-hover="true"',
    });

    // Honesty: no rank element, no composite-score text.
    assert({
      ok: matrix.rankEl === 0,
      message: 'the matrix must contain NO [data-testid="rank"] element',
    });
    assert({
      ok: !matrix.hasScoreText,
      message: 'the matrix must contain NO composite-score / ranking text (honesty)',
    });

    // Hostile displayName inert in a matrix header/cell.
    assert({
      ok: matrix.hostileAsText,
      message: 'the injected hostile name must render as inert matrix text',
    });
    assert({ ok: !matrix.xss, message: 'hostile matrix string executed (window.__ont_xss set)' });
    assert({
      ok: matrix.injectedImg === 0,
      message: 'hostile matrix string injected an <img onerror> element',
    });

    abShot({ path: join(SHOT_DIR, 'matrix.png') });

    // ---- Phase 6: Ownership view (AC-4) ----
    console.log('Phase 6: Ownership — people <-> services bipartite columns');
    selectView({ view: 'ownership' });

    const own = await waitFor({
      label: 'the ownership bipartite view to render people + service nodes',
      fn: () => {
        const o = readOwnership();
        return o.personCount >= 11 && o.serviceCount >= 1 ? o : undefined;
      },
    });
    const peopleLeft = own.personMaxX < own.serviceMinX;
    const peopleRight = own.serviceMaxX < own.personMinX;
    assert({
      ok: peopleLeft || peopleRight,
      message: `people and services must occupy two disjoint x-ranges (people [${own.personMinX}, ${own.personMaxX}], services [${own.serviceMinX}, ${own.serviceMaxX}])`,
    });
    assert({
      ok: own.edgeCount > 0,
      message: 'the ownership view must render works_on edges between the two columns',
    });

    abShot({ path: join(SHOT_DIR, 'ownership.png') });

    // ---- Phase 7: scorecard honesty + hostile inert in a network node (AC-5) ----
    console.log('Phase 7: scorecard metrics with no rank/score + hostile inert in Network');
    selectView({ view: 'network' });
    await waitFor({
      label: 'the network view to render again for the scorecard check',
      fn: () => {
        const g = readNetwork();
        return g.personCount >= 11 ? g : undefined;
      },
    });

    const netSafety = readNetwork();
    assert({
      ok: netSafety.hostileAsText,
      message: 'the injected hostile name must render as inert Network node text',
    });
    assert({
      ok: !netSafety.xss,
      message: 'hostile Network string executed (window.__ont_xss set)',
    });
    assert({
      ok: netSafety.injectedImg === 0,
      message: 'hostile Network string injected an <img onerror> element',
    });
    assert({
      ok: typeof netSafety.title === 'string' && netSafety.title.length > 0,
      message: 'document.title must remain intact after rendering hostile instance text',
    });

    clickFelix();
    const scorecard = await waitFor({
      label: 'the scorecard panel to open on person click',
      fn: () => {
        const s = readScorecard();
        return s.open ? s : undefined;
      },
    });
    assert({
      ok: /Felix Braun/.test(scorecard.text),
      message: 'scorecard must show the clicked person displayName (Felix Braun)',
    });
    assert({
      ok: /story points/i.test(scorecard.text),
      message: 'scorecard must show a "story points" metric label',
    });
    assert({
      ok: scorecard.rankEl === 0,
      message: 'scorecard must contain NO [data-testid="rank"] element',
    });
    assert({
      ok: !/overall score|composite score|rank #\d/i.test(scorecard.text),
      message: 'scorecard must contain NO composite-score / ranking text (honesty contract)',
    });
    clickPane();

    // ---- Phase 8: db category is unaffected (AC-1 / AC-5) ----
    console.log('Phase 8: db category renders the type map without the human-only switcher');
    selectCategory({ category: 'db' });
    const db = await waitFor({
      label: 'the db type map to render without a reload error',
      fn: () => {
        const g = readDbControls();
        return g.hasReactFlow && !g.reloadError && g.objectNode > 0 ? g : undefined;
      },
    });
    assert({
      ok: db.objectNode > 0,
      message: 'the db category must still render the type map (object nodes)',
    });
    assert({
      ok: !db.viewSwitcher,
      message: 'the db category must NOT show the human-only view switcher',
    });

    // ---- Phase 9: clean shutdown ----
    console.log('Phase 9: clean browser + server shutdown');
    ab({ args: ['close'] });
    await stopStudio({ child });
  } catch (err) {
    closeAll();
    child.kill('SIGKILL');
    throw err;
  }

  rmSync(RUN_DIR, { recursive: true, force: true });
  console.log('ONT-017 studio graph-readability scenario: all assertions passed');
};

await main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
