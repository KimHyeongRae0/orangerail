/**
 * ONT-011 e2e driver — studio instance graph + source-category tabs.
 *
 * Pure Node stdlib plus the agent-browser CLI (direct Playwright is forbidden
 * repo-wide). It runs the SHIPPED ONT-010 -> ONT-011 pipeline end to end: a run
 * dir under .docs/scratch is seeded with the ont-010 fixture Jira/Slack exports,
 * `orangerail init --from-jira --from-slack` generates the human-source config +
 * data/*.json, then `orangerail studio --no-open` serves it and a real browser is
 * driven through agent-browser to prove the instance-view surface.
 *
 * ── UI CONTRACT (the implementer MUST satisfy this exactly) ──────────────────
 *
 * ENDPOINT
 *   GET /api/instances returns JSON:
 *     {
 *       employees: [...],      // length 11; each has accountId, displayName,
 *                              //   storyPointsTotal, helpGiven
 *       services:  [...],
 *       teams:     [...],
 *       incidents: [...],
 *       edges: {
 *         helps:     [{ from, to, weight }, ...],  // non-empty
 *         works_on:  [{ from, to, weight }, ...],
 *         member_of: [{ from, to, weight }, ...],
 *       },
 *     }
 *   Non-GET (e.g. POST /api/instances) -> 405 (ONT-005 read-only invariant).
 *   /api/registry is UNCHANGED for this config (still a GraphSnapshot with
 *   object types present).
 *
 * CATEGORY TABS (in the Toolbar)
 *   [data-testid="category-tab-db"]      selectable; renders the ONT-005 type map
 *   [data-testid="category-tab-human"]   selectable + active/selectable; renders
 *                                        the instance graph
 *   The human tab is present and its graph renders. If the db tab is present it
 *   is selectable without breaking the page (db is NOT required to have nodes).
 *
 * INSTANCE NODES (human view)
 *   document.querySelectorAll('.react-flow__node').length >= 11 (people) + services
 *   person nodes carry attribute  [data-instance-kind="person"]
 *   service nodes carry attribute [data-instance-kind="service"]
 *   the known person name "Felix Braun" appears in the rendered node text.
 *
 * DIRECTED WEIGHTED HELP EDGES (human view)
 *   document.querySelectorAll('.react-flow__edge').length > 0
 *   (the `helps` edges are rendered directed + weight-scaled).
 *
 * WORKS_ON TOGGLE
 *   [data-testid="relationship-tab-works_on"] exists (ONT-017 replaced the
 *   ONT-011 works_on boolean toggle with a single-select relationship control);
 *   selecting it changes the rendered .react-flow__edge count.
 *
 * SCORECARD PANEL
 *   clicking a person node opens [data-testid="scorecard"]; its text contains
 *   the person's displayName and the metric labels (case-insensitive)
 *   "story points", "help given", "reopen". It contains NO element
 *   [data-testid="rank"] and NO text matching /overall score|composite score|
 *   rank #\d/i (honesty: no ranking, no composite score).
 *
 * HOSTILE-STRING SAFETY
 *   instance text renders inert: window.__ont_xss stays unset, zero injected
 *   img[onerror], and document.title is intact (no unexpected dialog).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Browser setup notes (baked in for determinism + robustness):
 *   - HEADLESS: AGENT_BROWSER_HEADED is scrubbed from the child env so no
 *     window is ever shown during a gate run.
 *   - RESET + FRESH SESSION: `agent-browser close --all` runs before the browser
 *     is opened, and a unique per-run `--session` name is used. This session has
 *     shown agent-browser cold-start `spawnSync ETIMEDOUT` under load, so the
 *     ab() wrapper uses a >=90s spawn timeout and retries a spawn failure ONCE
 *     after a short wait before failing. The reset + retry are load-bearing.
 *   - The only navigation target is http://127.0.0.1:<port>; no external site is
 *     opened and there is no authentication anywhere in this flow.
 *
 * RED (pre-implementation): GET /api/instances 404s (no InstanceSnapshot), the
 * category tabs / instance nodes / scorecard testids do not exist, so Phase 1's
 * `/api/instances` assertion fails first with a clear message.
 */
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-010');
const RUN_DIR = join(ROOT, '.docs', 'scratch', 'ont-011-run');
const EMPLOYEE_JSON = join(RUN_DIR, 'data', 'employee.json');
const SHOT_DIR = join(ROOT, '.docs', 'scratch', 'ONT-011-shots');

const PORT = 4885;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION = `ont011-e2e-${process.pid}`;

// A hostile displayName injected into one NON-Felix employee before the studio
// starts, so the instance text-rendering path is exercised against markup.
const HOSTILE = '<img src=x onerror="window.__ont_xss=1">ZedHostile';

const fail = ({ message }) => {
  console.error(`ONT-011 e2e FAIL: ${message}`);
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

/** Ensure a category tab is selected, then read the human-view DOM contract. */
const selectCategory = ({ category }) => {
  ab({ args: ['click', `[data-testid="category-tab-${category}"]`] });
};

/** Read the human instance-graph DOM contract. */
const readHuman = () =>
  abEval({
    js: `(() => {
      const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const persons = Array.from(document.querySelectorAll('[data-instance-kind="person"]'));
      const services = Array.from(document.querySelectorAll('[data-instance-kind="service"]'));
      const graphText = nodes.map((n) => n.textContent).join(' \\u241F ');
      return {
        nodeCount: nodes.length,
        personCount: persons.length,
        serviceCount: services.length,
        edgeCount: document.querySelectorAll('.react-flow__edge').length,
        hasFelix: /Felix Braun/.test(graphText),
        hostileAsText: graphText.includes('ZedHostile'),
        reloadError: !!document.querySelector('[data-testid="reload-error"]'),
        xss: window.__ont_xss,
        injectedImg: document.querySelectorAll('img[onerror]').length,
        title: document.title,
        hasReactFlow: !!document.querySelector('.react-flow'),
      };
    })()`,
  });

/** Read whether the category tabs exist and which is active. */
const readTabs = () =>
  abEval({
    js: `(() => {
      const tab = (c) => document.querySelector('[data-testid="category-tab-' + c + '"]');
      const active = (el) => !!el && (el.getAttribute('data-active') === 'true' || el.getAttribute('aria-selected') === 'true');
      return {
        db: !!tab('db'),
        human: !!tab('human'),
        humanActive: active(tab('human')),
      };
    })()`,
  });

/** Click the person node named "Felix Braun" (specific person) via a DOM click. */
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
  spawnSync('agent-browser', ['close', '--all'], {
    env: childEnv(),
    encoding: 'utf8',
    timeout: 90_000,
  });

  const child = await startStudio();

  try {
    // ---- Phase 1: /api/instances wire contract (the first RED) ----
    console.log('Phase 1: GET /api/instances wire contract');
    const instRes = await fetch(`${BASE}/api/instances`).catch(() => undefined);
    assert({
      ok: !!instRes && instRes.status === 200,
      message: `GET /api/instances must return 200 (got ${instRes ? instRes.status : 'no response'}) — endpoint not implemented`,
    });

    const instances = await instRes.json();
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
    for (const emp of instances.employees) {
      assert({
        ok:
          typeof emp.accountId === 'string' &&
          typeof emp.displayName === 'string' &&
          'storyPointsTotal' in emp &&
          'helpGiven' in emp,
        message: `each employee must carry accountId/displayName/storyPointsTotal/helpGiven (got ${JSON.stringify(Object.keys(emp))})`,
      });
    }

    const edges = instances.edges ?? {};
    for (const key of ['helps', 'works_on', 'member_of']) {
      assert({
        ok: Array.isArray(edges[key]),
        message: `/api/instances edges.${key} must be an array`,
      });
    }
    assert({
      ok: edges.helps.length > 0,
      message: '/api/instances edges.helps must be non-empty',
    });
    for (const e of edges.helps) {
      assert({
        ok: e && 'from' in e && 'to' in e && 'weight' in e,
        message: `each helps edge must be { from, to, weight } (got ${JSON.stringify(e)})`,
      });
    }

    // Non-GET -> 405 (read-only invariant, ONT-005 AC-7).
    const post = await rawRequest({ method: 'POST', path: '/api/instances' });
    assert({
      ok: post.status === 405,
      message: `POST /api/instances must be 405 (got ${post.status})`,
    });

    // /api/registry unchanged: still a GraphSnapshot with object types.
    const registry = await (await fetch(`${BASE}/api/registry`)).json();
    assert({
      ok: Array.isArray(registry.objects) && registry.objects.length > 0,
      message: '/api/registry must still return a GraphSnapshot with object types',
    });

    // ---- Phase 2: page load + category tabs ----
    console.log('Phase 2: page load, category tabs present');
    ab({ args: ['--args', '--no-first-run,--no-default-browser-check', 'open', `${BASE}/`] });

    await waitFor({
      label: 'the human category tab to render',
      fn: () => {
        const t = readTabs();
        return t.human ? t : undefined;
      },
    });

    let tabs = readTabs();
    assert({ ok: tabs.human, message: 'category-tab-human must be present' });

    // ---- Phase 3: human instance graph renders ----
    console.log('Phase 3: human instance graph — person + service nodes, help edges');
    selectCategory({ category: 'human' });

    // Wait for the edges and the person text too, not just the node counts.
    // React Flow renders an edge only after both its endpoints have been
    // measured, asynchronously, one pass after those nodes are already in the
    // DOM — so a predicate that stops at the node counts can be satisfied on a
    // frame where `edgeCount` is still 0 and the assertion below fails on a
    // perfectly healthy app. (Same defect ONT-054 fixed in ONT-005 phase 2.)
    const human = await waitFor({
      label: 'the human view to render its person and service nodes AND their help edges',
      fn: () => {
        const g = readHuman();

        return g.personCount >= 11 &&
          g.serviceCount >= 1 &&
          g.nodeCount >= g.personCount + g.serviceCount &&
          g.hasFelix &&
          g.edgeCount > 0
          ? g
          : undefined;
      },
    });

    assert({
      ok: human.personCount >= 11,
      message: `human view must render >= 11 person nodes (got ${human.personCount})`,
    });
    assert({
      ok: human.serviceCount >= 1,
      message: `human view must render service nodes (got ${human.serviceCount})`,
    });
    assert({
      ok: human.nodeCount >= human.personCount + human.serviceCount,
      message: `.react-flow__node count must include people + services (got ${human.nodeCount})`,
    });
    assert({
      ok: human.hasFelix,
      message: 'a known person name "Felix Braun" must appear in the rendered node text',
    });
    assert({
      ok: human.edgeCount > 0,
      message: 'the human view must render help edges (.react-flow__edge count > 0)',
    });

    ab({ args: ['screenshot', join(SHOT_DIR, 'human-overview.png')] });

    // ---- Phase 4: the relationship select changes the edge set ----
    // (ONT-017 superseded the ONT-011 works_on boolean toggle with a
    // single-select relationship control; switching the active family changes
    // the rendered edge count — the same observable behaviour, new contract.)
    console.log('Phase 4: relationship select changes the edge set (helps -> works_on)');
    const edgesBefore = readHuman().edgeCount;
    ab({ args: ['click', '[data-testid="relationship-tab-works_on"]'] });

    const edgesAfter = await waitFor({
      label: 'the relationship switch to works_on to change the rendered edge count',
      fn: () => {
        const g = readHuman();
        return g.edgeCount !== edgesBefore ? g.edgeCount : undefined;
      },
    });
    assert({
      ok: edgesAfter !== edgesBefore,
      message: `switching the relationship must change the edge count (before ${edgesBefore}, after ${edgesAfter})`,
    });

    // Restore helps so the remaining phases run against the default family.
    ab({ args: ['click', '[data-testid="relationship-tab-helps"]'] });

    // ---- Phase 5: db tab is selectable without breaking the page ----
    console.log('Phase 5: db category tab selectable without breaking the page');
    tabs = readTabs();
    if (tabs.db) {
      selectCategory({ category: 'db' });
      await waitFor({
        label: 'the db view to render without a reload error',
        fn: () => {
          const g = abEval({
            js: `(() => ({
              hasReactFlow: !!document.querySelector('.react-flow'),
              reloadError: !!document.querySelector('[data-testid="reload-error"]'),
            }))()`,
          });
          return g.hasReactFlow && !g.reloadError ? g : undefined;
        },
      });

      // Return to the human view for the remaining phases.
      selectCategory({ category: 'human' });
      await waitFor({
        label: 'person nodes to return after switching back to human',
        fn: () => {
          const g = readHuman();
          return g.personCount >= 11 ? g : undefined;
        },
      });
    } else {
      console.log('  (db tab absent — db category has no data; degrade is acceptable)');
    }

    // ---- Phase 6: scorecard panel opens with metrics, no ranking ----
    console.log('Phase 6: scorecard panel — metrics + honesty (no rank/score)');
    const felixClick = clickFelix();
    assert({
      ok: felixClick.clicked,
      message: 'could not locate the Felix Braun person node to click',
    });

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
      ok: /help given/i.test(scorecard.text),
      message: 'scorecard must show a "help given" metric label',
    });
    assert({
      ok: /reopen/i.test(scorecard.text),
      message: 'scorecard must show a "reopen" metric label',
    });
    assert({
      ok: scorecard.rankEl === 0,
      message: 'scorecard must contain NO [data-testid="rank"] element (honesty: no ranking)',
    });
    assert({
      ok: !/overall score|composite score|rank #\d/i.test(scorecard.text),
      message: 'scorecard must contain NO composite-score / ranking text (honesty contract)',
    });

    ab({ args: ['screenshot', join(SHOT_DIR, 'scorecard.png')] });

    // ---- Phase 7: hostile-string safety ----
    console.log('Phase 7: hostile instance string renders inert');
    const safety = readHuman();
    assert({
      ok: safety.xss === undefined || safety.xss === null,
      message: 'hostile instance string executed (window.__ont_xss set)',
    });
    assert({
      ok: safety.injectedImg === 0,
      message: 'hostile instance string injected an <img onerror> element',
    });
    assert({
      ok: typeof safety.title === 'string' && safety.title.length > 0,
      message: 'document.title must remain intact after rendering hostile instance text',
    });

    // ---- Phase 8: clean shutdown ----
    console.log('Phase 8: clean browser + server shutdown');
    ab({ args: ['close'] });
    await stopStudio({ child });
  } catch (err) {
    ab({ args: ['close'] });
    child.kill('SIGKILL');
    throw err;
  }

  rmSync(RUN_DIR, { recursive: true, force: true });
  console.log('ONT-011 studio instance-graph scenario: all assertions passed');
};

await main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
