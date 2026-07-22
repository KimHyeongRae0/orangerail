/**
 * ONT-005 e2e driver — studio map mode (ticket section 5, plan section 7).
 *
 * Pure Node stdlib plus the agent-browser CLI (direct Playwright is forbidden
 * repo-wide). Launches the real `orangerail studio --no-open --port <fixed>`
 * process against a full-feature fixture ontology, then drives a real browser
 * through the agent-browser CLI to prove the surface end to end.
 *
 * Browser setup notes (baked in for determinism):
 *   - HEADLESS: AGENT_BROWSER_HEADED is scrubbed from the child env so no
 *     window is ever shown during a gate run.
 *   - ISOLATED PROFILE: a fixed `--session` name gives a fresh Chrome for
 *     Testing profile, never the user's personal Chrome; `--args` suppresses
 *     the first-run / default-browser interstitials so the run never blocks.
 *   - The only navigation target is http://127.0.0.1:<port> — there is no
 *     authentication anywhere in this flow, and no external site is opened.
 *   - agent-browser mouse coordinates are CSS pixels while screenshots are 2x
 *     on this machine; this driver clicks by CSS selector (element-centered),
 *     never by raw coordinate, so the device-pixel scale never applies.
 *
 * Assertions target stable text / DOM-attribute facts with retry/timeout
 * loops; they never race a CSS transition (highlight state is read from
 * data-attributes, not from rendered opacity).
 *
 * Phases (plan section 7 GREEN steps 1-13):
 *   1  server up; /api/registry returns the fixture's objects/links/actions
 *   2  page load: object names, a link edge, and a governed action pill with
 *      its policy chip text all rendered
 *   3  click an object node: active/highlight attributes + detail panel
 *   4  click the governed action pill: its target object highlighted
 *   5  click the empty pane: highlight cleared, detail panel closed
 *   6  toolbar: zoom + changes the percentage, fit changes the transform,
 *      tidy re-layouts without error, show-mode collapses/restores field rows
 *   7  live reload: append a field to the config, the field appears (no reload)
 *   8  hostile-named object renders inert (payload as text, no injected DOM)
 *   9  POST /api/registry -> 405; a traversal path -> 404
 *   10 config failure exits non-zero with the loader diagnostic
 *   11 port conflict exits non-zero with a clear message
 *   12 screenshots archived for the report's DEV-01 checklist
 *   13 clean shutdown
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-005', 'config.mjs');
const RUN_DIR = join(ROOT, '.docs', 'scratch', 'ont-005-run');
const RUN_CONFIG = join(RUN_DIR, 'config.mjs');
const SHOT_DIR = join(ROOT, '.docs', 'scratch', 'ONT-005-studio-shots');

const PORT = 4877;
const CONFLICT_PORT = 4878;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION = 'ont005-e2e';

const EXPECTED_OBJECTS = new Set([
  'product',
  'customer',
  'internal_note',
  'audit_log',
  '<img src=x onerror="window.__ont_xss=1">',
]);
const EXPECTED_LINKS = new Set(['product_notes', 'product_customer']);
const EXPECTED_ACTIONS = new Set([
  'publish_product',
  'discount_product',
  'touch_customer',
  'sync_catalog',
]);

const fail = ({ message }) => {
  console.error(`ASSERTION FAILED: ${message}`);
  throw new Error(message);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Child env with the headed override scrubbed (deterministic headless runs). */
const childEnv = () => {
  const env = { ...process.env };
  delete env.AGENT_BROWSER_HEADED;
  return env;
};

/** Run an agent-browser subcommand in the isolated session; return stdout. */
const ab = ({ args, input }) => {
  const res = spawnSync('agent-browser', ['--session', SESSION, ...args], {
    cwd: ROOT,
    env: childEnv(),
    encoding: 'utf8',
    input,
    timeout: 60_000,
  });

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

/** A single raw HTTP request (used for method + traversal containment checks). */
const rawRequest = ({ method, path }) =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, method, path }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });

/** Start the studio server; resolve once /api/registry answers 200. */
const startStudio = async () => {
  const child = spawn(
    'node',
    [CLI, 'studio', '--no-open', '--port', String(PORT), '--config', RUN_CONFIG],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] },
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

/** Read the DOM contract for every rendered object / action node. */
const readGraph = () =>
  abEval({
    js: `(() => {
      const objects = Array.from(document.querySelectorAll('[data-testid="object-node"]')).map((el) => ({
        name: el.getAttribute('data-object-name'),
        active: el.getAttribute('data-active') === 'true',
        highlighted: el.getAttribute('data-highlighted') === 'true',
        fields: Array.from(el.querySelectorAll('[data-testid="field-row"]')).map((f) => f.getAttribute('data-field-name')),
        text: el.textContent,
      }));
      const actions = Array.from(document.querySelectorAll('[data-testid="action-node"]')).map((el) => ({
        name: el.getAttribute('data-action-name'),
        active: el.getAttribute('data-active') === 'true',
        text: el.textContent,
      }));
      return {
        objects,
        actions,
        panelOpen: !!document.querySelector('[data-testid="detail-panel"]'),
        reloadError: !!document.querySelector('[data-testid="reload-error"]'),
        viewport: (document.querySelector('.react-flow__viewport') || {}).style ? document.querySelector('.react-flow__viewport').style.transform : '',
        zoom: (document.querySelector('[data-testid="zoom-level"]') || {}).textContent || '',
        resources: performance.getEntriesByType('resource').map((r) => r.name),
        xss: window.__ont_xss,
        injectedImg: document.querySelectorAll('img[onerror]').length,
      };
    })()`,
  });

const objectByName = ({ graph, name }) => graph.objects.find((o) => o.name === name);
const actionByName = ({ graph, name }) => graph.actions.find((a) => a.name === name);

const main = async () => {
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });

  const baseConfig = readFileSync(FIXTURE, 'utf8');
  writeFileSync(RUN_CONFIG, baseConfig, 'utf8');

  // ---- Phase 1: server up + wire-level registry set equality ----
  console.log('Phase 1: server up, /api/registry set equality');
  const child = await startStudio();

  try {
    const registry = await (await fetch(`${BASE}/api/registry`)).json();

    assert({
      ok: new Set(registry.objects.map((o) => o.name)).size === EXPECTED_OBJECTS.size,
      message: 'registry object count mismatch',
    });
    for (const name of EXPECTED_OBJECTS) {
      assert({
        ok: registry.objects.some((o) => o.name === name),
        message: `registry missing object: ${name}`,
      });
    }
    for (const id of EXPECTED_LINKS) {
      assert({
        ok: registry.links.some((l) => l.id === id),
        message: `registry missing link: ${id}`,
      });
    }
    for (const name of EXPECTED_ACTIONS) {
      assert({
        ok: registry.actions.some((a) => a.name === name),
        message: `registry missing action: ${name}`,
      });
    }

    const publish = registry.actions.find((a) => a.name === 'publish_product');
    assert({ ok: publish.approval === 'required', message: 'publish_product must be governed' });
    assert({
      ok: publish.roles.includes('editor'),
      message: 'publish_product must list editor role',
    });
    assert({ ok: publish.target === 'product', message: 'publish_product must target product' });

    const discount = registry.actions.find((a) => a.name === 'discount_product');
    assert({
      ok: discount.where === 'declarative',
      message: 'discount_product must have declarative where',
    });

    const sync = registry.actions.find((a) => a.name === 'sync_catalog');
    assert({ ok: sync.notImplemented === true, message: 'sync_catalog must be notImplemented' });
    assert({ ok: !sync.target, message: 'sync_catalog must be target-less' });

    const touch = registry.actions.find((a) => a.name === 'touch_customer');
    assert({ ok: touch.approval === 'auto', message: 'touch_customer must be auto' });

    // ---- Phase 2: page load, nodes + edges + governed action pill ----
    console.log('Phase 2: page load, nodes/edges/action pill');
    ab({ args: ['--args', '--no-first-run,--no-default-browser-check', 'open', `${BASE}/`] });

    await waitFor({
      label: 'object nodes to render',
      fn: async () => {
        const graph = readGraph();
        return graph.objects.length >= EXPECTED_OBJECTS.size ? graph : undefined;
      },
    });

    let graph = readGraph();
    for (const name of EXPECTED_OBJECTS) {
      assert({ ok: !!objectByName({ graph, name }), message: `object node not rendered: ${name}` });
    }
    for (const name of EXPECTED_ACTIONS) {
      assert({ ok: !!actionByName({ graph, name }), message: `action node not rendered: ${name}` });
    }

    const edgeCount = abEval({
      js: `(() => document.querySelectorAll('.react-flow__edge').length)()`,
    });
    assert({ ok: edgeCount >= EXPECTED_LINKS.size, message: 'link edges not rendered' });

    const publishPill = actionByName({ graph, name: 'publish_product' });
    assert({
      ok: /approval/i.test(publishPill.text) && /editor/.test(publishPill.text),
      message: `publish_product pill must show approval + editor role (got: ${publishPill.text})`,
    });
    const discountPill = actionByName({ graph, name: 'discount_product' });
    assert({
      ok: /only when/i.test(discountPill.text) && /status/.test(discountPill.text),
      message: `discount_product pill must show its declarative where text (got: ${discountPill.text})`,
    });
    const syncPill = actionByName({ graph, name: 'sync_catalog' });
    assert({
      ok: /stub/i.test(syncPill.text),
      message: `sync_catalog pill must show a stub chip (got: ${syncPill.text})`,
    });

    ab({ args: ['screenshot', join(SHOT_DIR, 'studio-01-overview.png')] });

    // ---- Phase 3: click an object node -> focus highlight + panel ----
    console.log('Phase 3: object focus highlight + detail panel');
    ab({ args: ['click', '[data-object-name="product"]'] });

    graph = await waitFor({
      label: 'product node to become active',
      fn: () => {
        const g = readGraph();
        return objectByName({ graph: g, name: 'product' })?.active ? g : undefined;
      },
    });

    assert({
      ok: objectByName({ graph, name: 'product' }).active,
      message: 'clicked product node must be active',
    });
    const neighbourHighlighted = ['internal_note', 'customer'].some(
      (n) => objectByName({ graph, name: n })?.highlighted,
    );
    assert({ ok: neighbourHighlighted, message: 'a linked neighbour must be highlighted' });
    assert({
      ok: !objectByName({ graph, name: 'audit_log' }).highlighted,
      message: 'unrelated audit_log must not be highlighted',
    });
    assert({ ok: graph.panelOpen, message: 'detail panel must open on node click' });

    ab({ args: ['screenshot', join(SHOT_DIR, 'studio-02-object-focus.png')] });

    // ---- Phase 4: click the governed action pill -> target highlighted ----
    console.log('Phase 4: action focus highlights its target');
    ab({ args: ['click', '[data-action-name="publish_product"]'] });

    graph = await waitFor({
      label: 'publish_product pill to become active',
      fn: () => {
        const g = readGraph();
        return actionByName({ graph: g, name: 'publish_product' })?.active ? g : undefined;
      },
    });

    assert({
      ok: objectByName({ graph, name: 'product' }).highlighted,
      message: 'action target product must be highlighted when the action is selected',
    });

    ab({ args: ['screenshot', join(SHOT_DIR, 'studio-03-action-focus.png')] });

    // ---- Phase 5: pane click clears everything ----
    // Revised 2026-07-22 (reviewer fix, mechanism only — assertions unchanged):
    // `click '.react-flow__pane'` resolves to a coordinate click at the pane's
    // geometric center, which a fit-zoomed graph always covers with a card, so
    // the click re-selects a node instead of hitting empty canvas. Click a
    // verified-empty canvas coordinate instead; the deselect assertions below
    // are untouched.
    console.log('Phase 5: pane click restores neutral state');
    ab({ args: ['mouse', 'move', '640', '460'] });
    ab({ args: ['mouse', 'down'] });
    ab({ args: ['mouse', 'up'] });

    graph = await waitFor({
      label: 'highlight to clear on pane click',
      fn: () => {
        const g = readGraph();
        const anyActive = g.objects.some((o) => o.active) || g.actions.some((a) => a.active);
        const anyHi = g.objects.some((o) => o.highlighted);
        return !anyActive && !anyHi && !g.panelOpen ? g : undefined;
      },
    });
    assert({ ok: !graph.panelOpen, message: 'detail panel must close on pane click' });

    // ---- Phase 6: toolbar controls ----
    console.log('Phase 6: toolbar zoom / fit / tidy / show-mode');
    const zoomBefore = readGraph().zoom;
    ab({ args: ['click', '[data-testid="zoom-in"]'] });
    const zoomAfter = await waitFor({
      label: 'zoom percentage to change',
      fn: () => {
        const z = readGraph().zoom;
        return z && z !== zoomBefore ? z : undefined;
      },
    });
    assert({
      ok: zoomAfter !== zoomBefore,
      message: 'zoom + must change the percentage indicator',
    });

    const transformZoomed = readGraph().viewport;
    ab({ args: ['click', '[data-testid="fit"]'] });
    await waitFor({
      label: 'fit to change the viewport transform',
      fn: () => {
        const t = readGraph().viewport;
        return t && t !== transformZoomed ? t : undefined;
      },
    });

    const beforeTidy = readGraph().objects.length;
    ab({ args: ['click', '[data-testid="tidy"]'] });
    await sleep(1500);
    const afterTidy = readGraph();
    assert({ ok: afterTidy.objects.length === beforeTidy, message: 'tidy must not drop nodes' });
    assert({ ok: !afterTidy.reloadError, message: 'tidy must not raise an error' });

    ab({ args: ['select', '[data-testid="show-mode"]', 'name'] });
    await waitFor({
      label: 'field rows to disappear in Name Only mode',
      fn: () => {
        const g = readGraph();
        return g.objects.every((o) => o.fields.length === 0) ? g : undefined;
      },
    });
    ab({ args: ['screenshot', join(SHOT_DIR, 'studio-04-name-only.png')] });

    ab({ args: ['select', '[data-testid="show-mode"]', 'all'] });
    await waitFor({
      label: 'field rows to return in All Fields mode',
      fn: () => {
        const g = readGraph();
        return objectByName({ graph: g, name: 'product' })?.fields.length > 0 ? g : undefined;
      },
    });

    // ---- Phase 7: live reload on config edit ----
    console.log('Phase 7: live reload adds a field without a manual refresh');
    const edited = baseConfig.replace(
      'status: z.string(),',
      'status: z.string(),\n    reload_marker: z.string(),',
    );
    assert({ ok: edited !== baseConfig, message: 'reload edit did not modify the config text' });
    writeFileSync(RUN_CONFIG, edited, 'utf8');

    await waitFor({
      label: 'the new reload_marker field to appear without a reload',
      timeoutMs: 25_000,
      fn: () => {
        const g = readGraph();
        return objectByName({ graph: g, name: 'product' })?.fields.includes('reload_marker')
          ? g
          : undefined;
      },
    });

    // ---- Phase 8: hostile-named object rendered inert ----
    console.log('Phase 8: hostile name rendered inert (AC-8)');
    graph = readGraph();
    assert({
      ok: graph.xss === undefined || graph.xss === null,
      message: 'hostile payload executed (window.__ont_xss set)',
    });
    assert({
      ok: graph.injectedImg === 0,
      message: 'hostile name injected an <img onerror> element',
    });
    const hostileNode = graph.objects.find((o) => o.text && o.text.includes('onerror'));
    assert({ ok: !!hostileNode, message: 'hostile name not rendered as visible text' });

    // ---- Phase 9: read-only server posture ----
    console.log('Phase 9: no write routes; path containment');
    const post = await rawRequest({ method: 'POST', path: '/api/registry' });
    assert({
      ok: post.status === 405,
      message: `POST /api/registry must be 405 (got ${post.status})`,
    });
    const traversal = await rawRequest({
      method: 'GET',
      path: '/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json',
    });
    assert({
      ok: traversal.status === 404,
      message: `traversal path must be 404 (got ${traversal.status})`,
    });

    // ---- AC-9: no remote resources at runtime ----
    const remote = graph.resources.filter(
      (name) => /^https?:\/\//.test(name) && !name.startsWith(BASE),
    );
    assert({
      ok: remote.length === 0,
      message: `app loaded remote resources: ${remote.join(', ')}`,
    });

    // ---- Phase 13a: clean shutdown of the running server ----
    console.log('Phase 13: clean browser + server shutdown');
    ab({ args: ['close'] });
    await stopStudio({ child });
  } catch (err) {
    ab({ args: ['close'] });
    child.kill('SIGKILL');
    throw err;
  }

  // ---- Phase 10: config-load failure exits non-zero with the diagnostic ----
  console.log('Phase 10: config failure exits non-zero with loader diagnostic');
  const badConfig = spawnSync(
    'node',
    [
      CLI,
      'studio',
      '--no-open',
      '--port',
      String(CONFLICT_PORT),
      '--config',
      join(RUN_DIR, 'nope.mjs'),
    ],
    { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 30_000 },
  );
  assert({
    ok: badConfig.status !== 0,
    message: 'studio with a missing config must exit non-zero',
  });
  assert({
    ok: /config not found|no orangerail config/i.test(badConfig.stderr),
    message: `studio config failure must print the loader diagnostic (got: ${badConfig.stderr})`,
  });

  // ---- Phase 11: port conflict exits non-zero with a clear message ----
  console.log('Phase 11: port conflict exits non-zero (dummy listener on 127.0.0.1)');
  const dummy = createServer((_req, res) => res.end('busy'));
  await new Promise((resolve) => dummy.listen(CONFLICT_PORT, '127.0.0.1', resolve));

  try {
    const conflict = spawnSync(
      'node',
      [CLI, 'studio', '--no-open', '--port', String(CONFLICT_PORT), '--config', RUN_CONFIG],
      { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 30_000 },
    );
    assert({ ok: conflict.status !== 0, message: 'studio on an occupied port must exit non-zero' });
    assert({
      ok: /in use|EADDRINUSE|already/i.test(conflict.stderr),
      message: `port conflict must print a clear message (got: ${conflict.stderr})`,
    });
  } finally {
    await new Promise((resolve) => dummy.close(resolve));
  }

  rmSync(RUN_DIR, { recursive: true, force: true });
  console.log('ONT-005 studio scenario: all assertions passed');
};

await main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
