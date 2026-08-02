/**
 * ONT-072 e2e driver — a row that does not match its declared shape no longer
 * blanks the studio (ticket section 5).
 *
 * Pure Node stdlib plus the agent-browser CLI (direct Playwright is forbidden
 * repo-wide). It boots the SHIPPED `orangerail studio` over a fixture whose
 * `employee` rows break the declaration `InstanceEmployee` makes, and drives a
 * real browser through agent-browser.
 *
 * Phase 1  the wire: `/api/instances` serves every row and names, in the ONT-071
 *          vocabulary, the fields it could not print. The reason it serves for
 *          `employee[acc_cyd].complexityMix` is captured here and used as the
 *          expected marker text in the browser — that comparison IS AC-4.
 * Phase 2  selecting `Bea`, whose row carries no `complexityMix` at all, renders
 *          the scorecard with that metric named and every other metric intact
 *          (AC-1), while the map, the person nodes and the toolbar stay in the
 *          document and stay interactive (AC-2).
 * Phase 3  `Ann` conforms: the same panel prints her metrics verbatim and shows
 *          no marker anywhere (AC-5's browser-side half; the byte-for-byte
 *          golden lives in `packages/studio/src/app/DetailPanel.test.tsx`).
 * Phase 4  `Dov` breaks three fields in three different ways and is selected
 *          right after `Bea` — a second failing row in one session needs no
 *          reload. Then `Eze`, whose `accountId` is a `BigInt` and therefore
 *          reaches the browser as a marker rather than an id, is still
 *          selectable and still nameable (ticket section 4).
 * Phase 5  a second studio, over a row whose `displayName` is an object, so a
 *          component throws for a reason no metric guard covers. The boundary
 *          names the view that failed, the root survives, and the error is still
 *          on the console (AC-3).
 *
 * RED (against `487e846`): phase 2 blanks the page. `PersonScorecard` derefs
 * `employee.complexityMix.hi`, React unmounts the root, and `[data-testid=
 * "studio-root"]` disappears along with every person node and the toolbar.
 *
 * Browser setup notes (same discipline as the ONT-011 driver):
 *   - HEADLESS: AGENT_BROWSER_HEADED is scrubbed from the child env.
 *   - RESET + FRESH SESSION: `agent-browser close --all` runs first and a unique
 *     per-run `--session` name is used; a spawn failure is retried ONCE, since
 *     agent-browser cold start has shown `spawnSync ETIMEDOUT` under load.
 *   - The only navigation target is http://127.0.0.1:<port>; no external site is
 *     opened and there is no authentication anywhere in this flow.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const CONFIG = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-072', 'config.mjs');
const SHOT_DIR = join(ROOT, '.docs', 'scratch', 'ONT-072-shots');

const METRICS_PORT = 4893;
const BOUNDARY_PORT = 4894;
const SESSION = `ont072-e2e-${process.pid}`;

let failures = 0;

const assert = ({ ac, ok, message }) => {
  if (!ok) {
    failures += 1;
    console.error(`ASSERTION FAILED [${ac}]: ${message}`);
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
    throw new Error(`agent-browser ${args.join(' ')} failed to spawn: ${res.error.message}`);
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
const waitFor = async ({ label, fn, timeoutMs = 25_000, intervalMs = 500 }) => {
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
      throw new Error(`timed out waiting for: ${label}`);
    }

    await sleep(intervalMs);
  }
};

/** Start a studio server in `mode`; resolve once `/api/registry` answers 200. */
const startStudio = async ({ mode, port }) => {
  const child = spawn(
    'node',
    [CLI, 'studio', '--config', CONFIG, '--port', String(port), '--no-open'],
    {
      cwd: ROOT,
      env: { ...process.env, ORANGERAIL_E2E_MODE: mode },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );

  let exitedEarly = false;
  child.on('exit', () => {
    exitedEarly = true;
  });

  await waitFor({
    label: `the ${mode} studio to answer /api/registry`,
    timeoutMs: 30_000,
    fn: async () => {
      if (exitedEarly) {
        throw new Error(`the ${mode} studio exited before it served anything`);
      }

      const res = await fetch(`http://127.0.0.1:${port}/api/registry`).catch(() => undefined);

      return res !== undefined && res.status === 200;
    },
  });

  return child;
};

const stopStudio = async ({ child }) => {
  child.kill('SIGTERM');

  await waitFor({
    label: 'the studio process to exit',
    timeoutMs: 10_000,
    fn: () => child.exitCode !== null || child.signalCode !== null,
  });
};

/**
 * Read the studio shell: the facts that must survive one bad row. `rootPresent`
 * is the whole ticket — on `487e846` this is `false` the moment a bad row is
 * selected, because React unmounted the tree.
 */
const readShell = () =>
  abEval({
    js: `(() => {
      const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
      return {
        rootPresent: !!document.querySelector('[data-testid="studio-root"]'),
        surfacePresent: !!document.querySelector('.react-flow'),
        nodeCount: nodes.length,
        personCount: document.querySelectorAll('[data-instance-kind="person"]').length,
        names: nodes.map((n) => n.textContent).join(' | '),
        toolbarTabs: document.querySelectorAll('[data-testid^="category-tab-"]').length,
        viewErrors: Array.from(document.querySelectorAll('[data-testid="view-error"]')).map((el) => ({
          view: el.getAttribute('data-view'),
          text: el.textContent,
        })),
      };
    })()`,
  });

/** Click the person node whose label contains `name`, by DOM event dispatch. */
const clickPerson = ({ name }) =>
  abEval({
    js: `(() => {
      const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const target = nodes.find((n) => n.textContent.includes(${JSON.stringify(name)}));
      if (!target) return { clicked: false };
      const el = target.querySelector('[data-instance-kind="person"]') || target;
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { clicked: true };
    })()`,
  });

/** Read the scorecard as label -> value, plus which values are markers. */
const readScorecard = () =>
  abEval({
    js: `(() => {
      const panel = document.querySelector('[data-testid="scorecard"]');
      if (!panel) return { open: false, rows: {}, markers: [], title: '' };
      const rows = {};
      for (const row of panel.querySelectorAll('section > div')) {
        const key = row.firstElementChild ? row.firstElementChild.textContent : '';
        rows[key] = row.lastElementChild ? row.lastElementChild.textContent : '';
      }
      return {
        open: true,
        title: panel.querySelector('[title]') ? panel.querySelector('[title]').textContent : '',
        sectionTitle: panel.querySelector('h3') ? panel.querySelector('h3').textContent : '',
        rows,
        markers: Array.from(panel.querySelectorAll('[data-unrenderable="true"]')).map((el) => el.textContent),
      };
    })()`,
  });

/** Wait until the scorecard shows the row for `name`. */
const openScorecard = async ({ name }) => {
  const click = clickPerson({ name });

  assert({
    ac: 'AC-1',
    ok: click.clicked === true,
    message: `could not locate the person node for ${name}`,
  });

  return waitFor({
    label: `the scorecard for ${name}`,
    fn: () => {
      const card = readScorecard();

      return card.open && card.title.length > 0 ? card : undefined;
    },
  });
};

// ---------------------------------------------------------------------------
// Phase 1 (AC-4 anchor): what the server already says about an unshowable field.
// ---------------------------------------------------------------------------
const phase1 = async () => {
  console.log('Phase 1: /api/instances serves every row and names what it could not print');

  const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/api/instances`).catch(() => undefined);

  assert({
    ac: 'AC-4',
    ok: res !== undefined && res.status === 200,
    message: `GET /api/instances did not answer 200 (got ${res ? res.status : 'nothing'})`,
  });

  const body = res === undefined ? {} : await res.json();
  const employees = body.employees ?? [];

  assert({
    ac: 'AC-4',
    ok: employees.length === 5,
    message: `expected 5 rows, got ${employees.length}`,
  });

  // The reported row: the key is not on the wire at all, so the server has
  // nothing to name and the browser is the only place this can be caught.
  const bea = employees.find((row) => row.accountId === 'acc_bea');

  assert({
    ac: 'AC-4',
    ok: bea !== undefined && !('complexityMix' in bea),
    message: `acc_bea was expected to reach the browser without complexityMix: ${JSON.stringify(bea)}`,
  });

  const named = (body.unrenderable ?? []).find(
    (field) => field.path === 'employee[acc_cyd].complexityMix',
  );

  assert({
    ac: 'AC-4',
    ok: named !== undefined,
    message: `the server does not name acc_cyd's complexityMix: ${JSON.stringify(body.unrenderable)}`,
  });

  return named === undefined ? null : `<UNRENDERABLE — ${named.reason}>`;
};

// ---------------------------------------------------------------------------
// Phase 2 (AC-1/AC-2/AC-4): the row that used to take the application down.
// ---------------------------------------------------------------------------
const phase2 = async ({ expectedMarker }) => {
  console.log('Phase 2 (AC-1/AC-2/AC-4): selecting a row with no complexityMix');

  ab({
    args: [
      '--args',
      '--no-first-run,--no-default-browser-check',
      'open',
      `http://127.0.0.1:${METRICS_PORT}/?category=human`,
    ],
  });

  const before = await waitFor({
    label: 'the human view to render its person nodes',
    fn: () => {
      const shell = readShell();

      return shell.personCount >= 5 ? shell : undefined;
    },
  });

  const card = await openScorecard({ name: 'Bea' });

  ab({ args: ['screenshot', join(SHOT_DIR, 'bea-scorecard.png')] });

  const mix = card.rows['Complexity mix (hi/med/lo)'] ?? '';

  assert({
    ac: 'AC-1',
    ok: mix === expectedMarker,
    message: `the missing metric is not named as the server names it: got ${JSON.stringify(mix)}, expected ${JSON.stringify(expectedMarker)}`,
  });
  assert({
    ac: 'AC-1',
    ok: card.title === 'Bea',
    message: `the panel is not the one that was asked for: ${JSON.stringify(card.title)}`,
  });

  // Every other metric on the SAME panel still renders: the named absence must
  // not take its siblings with it.
  for (const [label, expected] of [
    ['Ticket count', '4'],
    ['Story points', '12'],
    ['Help given', '3'],
    ['Help received', '5'],
    ['Reopen rate', 'unavailable'],
  ]) {
    assert({
      ac: 'AC-1',
      ok: card.rows[label] === expected,
      message: `${label} should still read ${expected}, got ${JSON.stringify(card.rows[label])}`,
    });
  }

  assert({
    ac: 'AC-1',
    ok: card.markers.length === 1,
    message: `exactly one metric should be marked unrenderable: ${JSON.stringify(card.markers)}`,
  });

  // AC-2: the rest of the application is untouched and still interactive.
  const after = readShell();

  assert({
    ac: 'AC-2',
    ok: after.rootPresent,
    message: 'the React root is gone — the whole application unmounted on one bad row',
  });
  assert({
    ac: 'AC-2',
    ok: after.surfacePresent && after.nodeCount === before.nodeCount,
    message: `the map lost nodes (before ${before.nodeCount}, after ${after.nodeCount})`,
  });
  assert({
    ac: 'AC-2',
    ok: after.personCount >= 5,
    message: `every other person should still be on the map, got ${after.personCount}`,
  });
  assert({
    ac: 'AC-2',
    ok: after.toolbarTabs > 0,
    message: 'the navigation is gone',
  });
  assert({
    ac: 'AC-2',
    ok: after.viewErrors.length === 0,
    message: `no view should have failed at all: ${JSON.stringify(after.viewErrors)}`,
  });

  // Interactive, not merely present: the toolbar still drives the view.
  ab({ args: ['click', '[data-testid="view-tab-matrix"]'] });

  const matrix = await waitFor({
    label: 'the toolbar to switch the human view to the matrix',
    fn: () => {
      const found = abEval({
        js: `(() => ({ matrix: !!document.querySelector('[data-testid="help-matrix"]') }))()`,
      });

      return found.matrix ? found : undefined;
    },
  });

  assert({
    ac: 'AC-2',
    ok: matrix.matrix === true,
    message: 'the toolbar did not respond after a bad row was selected',
  });

  ab({ args: ['click', '[data-testid="view-tab-network"]'] });
  await waitFor({
    label: 'the network view to come back',
    fn: () => {
      const shell = readShell();

      return shell.personCount >= 5 ? shell : undefined;
    },
  });
};

// ---------------------------------------------------------------------------
// Phase 3 (AC-5): a conforming row is untouched.
// ---------------------------------------------------------------------------
const phase3 = async () => {
  console.log('Phase 3 (AC-5): a conforming row still renders its values verbatim');

  const card = await openScorecard({ name: 'Ann' });

  assert({
    ac: 'AC-5',
    ok: card.markers.length === 0,
    message: `a conforming row must carry no markers: ${JSON.stringify(card.markers)}`,
  });

  for (const [label, expected] of [
    ['Ticket count', '4'],
    ['Story points', '12'],
    ['Complexity mix (hi/med/lo)', '1 / 1 / 2'],
    ['Median cycle days (first half)', '2'],
    ['Median cycle days (second half)', '1'],
    ['Reopen rate', 'unavailable'],
    ['Reassignments given', '0'],
    ['Reassignments received', '0'],
    ['Help given', '3'],
    ['Help received', '5'],
    ['Weekend / off-hours share', '0'],
  ]) {
    assert({
      ac: 'AC-5',
      ok: card.rows[label] === expected,
      message: `${label} should read ${expected}, got ${JSON.stringify(card.rows[label])}`,
    });
  }
};

// ---------------------------------------------------------------------------
// Phase 4 (section 4): a second failing row, in the same session, with no reload.
// ---------------------------------------------------------------------------
const phase4 = async ({ expectedMarker }) => {
  console.log('Phase 4 (edge case): a different failing row selected right after the first');

  await openScorecard({ name: 'Bea' });

  const card = await waitFor({
    label: "Dov's scorecard to replace Bea's",
    fn: () => {
      clickPerson({ name: 'Dov' });
      const found = readScorecard();

      return found.open && found.title === 'Dov' ? found : undefined;
    },
  });

  assert({
    ac: 'AC-1',
    ok: card.rows['Ticket count'] === expectedMarker,
    message: `a missing count is not named: ${JSON.stringify(card.rows['Ticket count'])}`,
  });
  assert({
    ac: 'AC-1',
    ok:
      card.rows['Complexity mix (hi/med/lo)'] ===
      '<UNRENDERABLE — a string ("lots") where the row declares an object with hi / med / lo>',
    message: `a mix that is not an object is not named: ${JSON.stringify(card.rows['Complexity mix (hi/med/lo)'])}`,
  });
  assert({
    ac: 'AC-1',
    ok:
      card.rows['Story points'] ===
      '<UNRENDERABLE — null where the row declares a number or "unavailable">',
    message: `a null metric is not named: ${JSON.stringify(card.rows['Story points'])}`,
  });
  assert({
    ac: 'AC-1',
    ok: card.rows['Help given'] === '3' && card.sectionTitle === 'Evidence metrics',
    message: 'the panel did not render as a panel with its surviving metrics',
  });

  const shell = readShell();

  assert({
    ac: 'AC-2',
    ok: shell.rootPresent && shell.personCount >= 5 && shell.viewErrors.length === 0,
    message: `the second failing row disturbed the application: ${JSON.stringify(shell)}`,
  });

  ab({ args: ['screenshot', join(SHOT_DIR, 'dov-scorecard.png')] });

  // The row whose identity field is itself unrenderable: it reaches the browser
  // keyed by a marker instead of by an id, and it must still be a person a
  // reader can pick out of the fleet and read a panel for.
  const keyed = await waitFor({
    label: "the marker-keyed row's scorecard",
    fn: () => {
      clickPerson({ name: 'Eze' });
      const found = readScorecard();

      return found.open && found.title === 'Eze' ? found : undefined;
    },
  });

  assert({
    ac: 'AC-1',
    ok: keyed.rows['Complexity mix (hi/med/lo)'] === '1 / 1 / 2',
    message: `a row with no printable id lost its metrics: ${JSON.stringify(keyed.rows)}`,
  });
};

// ---------------------------------------------------------------------------
// Phase 5 (AC-3): a component that throws for a reason no field guard covers.
// ---------------------------------------------------------------------------
const phase5 = async () => {
  console.log('Phase 5 (AC-3): a throwing component is caught, named, and logged');

  ab({ args: ['console', '--clear'] });
  ab({ args: ['open', `http://127.0.0.1:${BOUNDARY_PORT}/?category=human`] });

  const shell = await waitFor({
    label: 'the boundary to name the view that failed',
    fn: () => {
      const found = readShell();

      return found.viewErrors.length > 0 ? found : undefined;
    },
  });

  ab({ args: ['screenshot', join(SHOT_DIR, 'boundary.png')] });

  assert({
    ac: 'AC-3',
    ok: shell.viewErrors.some((view) => view.view === 'The ontology map'),
    message: `the boundary does not name the view that failed: ${JSON.stringify(shell.viewErrors)}`,
  });
  assert({
    ac: 'AC-3',
    ok: shell.viewErrors.some((view) => view.text.includes('could not be rendered')),
    message: `the boundary does not say what happened: ${JSON.stringify(shell.viewErrors)}`,
  });
  assert({
    ac: 'AC-3',
    ok: shell.rootPresent,
    message: 'the root did not survive a throwing component',
  });
  assert({
    ac: 'AC-3',
    ok: shell.toolbarTabs > 0,
    message: 'the navigation went down with the view that failed',
  });

  const console_ = ab({ args: ['console'] });

  assert({
    ac: 'AC-3',
    ok: console_.stdout.includes('The ontology map failed to render'),
    message: `the boundary swallowed the failure instead of reporting it: ${console_.stdout.slice(0, 600)}`,
  });
  // The shipped studio is a production React build, so React's own text arrives
  // minified with the link that decodes it (`#31` is "Objects are not valid as
  // a React child"). Either spelling proves the same thing: the error the
  // boundary caught is on the console, not swallowed by it.
  assert({
    ac: 'AC-3',
    ok: /Minified React error|Objects are not valid as a React child/.test(console_.stdout),
    message: `the underlying error never reached the console: ${console_.stdout.slice(0, 600)}`,
  });
};

const main = async () => {
  mkdirSync(SHOT_DIR, { recursive: true });

  // Reset agent-browser before opening (cold-start robustness); ignore failure.
  spawnSync('agent-browser', ['close', '--all'], {
    env: childEnv(),
    encoding: 'utf8',
    timeout: 90_000,
  });

  const metrics = await startStudio({ mode: 'metrics', port: METRICS_PORT });
  const boundary = await startStudio({ mode: 'boundary', port: BOUNDARY_PORT });

  try {
    const expectedMarker = await phase1();

    if (expectedMarker === null) {
      throw new Error('phase 1 produced no marker text to compare against');
    }

    await phase2({ expectedMarker });
    await phase3();
    await phase4({ expectedMarker });
    await phase5();

    ab({ args: ['close'] });
    await stopStudio({ child: metrics });
    await stopStudio({ child: boundary });
  } catch (error) {
    ab({ args: ['close'] });
    metrics.kill('SIGKILL');
    boundary.kill('SIGKILL');
    throw error;
  }

  assert({
    ac: 'AC-7',
    ok: metrics.exitCode === 0 && boundary.exitCode === 0,
    message: `a studio process did not exit 0 (${metrics.exitCode} / ${boundary.exitCode})`,
  });

  if (failures > 0) {
    console.error(`\nONT-072 e2e: ${failures} assertion(s) failed`);
    process.exit(1);
  }

  console.log('\nONT-072 e2e: all assertions passed');
};

await main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
