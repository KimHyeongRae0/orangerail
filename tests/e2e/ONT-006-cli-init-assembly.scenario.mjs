/**
 * ONT-006 e2e driver — init assembly + sync drift (ticket section 5).
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) against a copied fixture
 * repo (tests/e2e/fixtures/ont-006: Prisma schema + OpenAPI JSON, hostile
 * strings included) and proves the whole flagship flow:
 *
 *   1. flag-driven `orangerail init` generates ontology/ + config +
 *      .orangerail/generated docs, auto-starts the studio (asserted via a real
 *      browser through agent-browser — direct Playwright is forbidden), and
 *      honors --no-open;
 *   2. re-running init refuses and modifies nothing (AC-6);
 *   3. `orangerail mcp` boots on the generated output unmodified and tools/list
 *      matches the fixture (AC-5) — read tools for every model, governed
 *      action tools for every write operation, hostile names sanitized well
 *      enough that the server's build-time tool-name validation passes, and
 *      (ONT-053) each read tool describing the object it reads — the scanned
 *      columns and the ProductStatus members as the `filter` schema, the
 *      derived links as a relation sentence — and (ONT-061) each generated
 *      `update*` action describing its own input: a type on every optional
 *      column, optionality in `required`, and a refusal that names the field;
 *   4. generation is byte-deterministic across two fresh runs (AC-9);
 *   5. `orangerail sync` is clean right after init, reports drift (new model
 *      proposal + field drift) after the schema mutates, creates ONLY the new
 *      file under --accept-new, and warns about unregistered ontology files
 *      (AC-7) — never editing an existing file. ONT-050 adds the governance
 *      half: init records the baseline, deleting an approval gate from a
 *      generated action makes `sync` name it and exit 1, and `orangerail mcp`
 *      then refuses to serve that one action while serving the rest.
 *
 * RED (pre-implementation): `main.ts` loads the config before dispatch, so in
 * the config-less fixture copy `orangerail init --yes ...` exits 1 with the
 * loader's "no orangerail config found" diagnostic; the studio never comes up
 * and phase 1 fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-006');
const SCRATCH = join(ROOT, '.docs', 'scratch');
const RUN_A = join(SCRATCH, 'ont-006-run-a');
const RUN_B = join(SCRATCH, 'ont-006-run-b');
const RUN_C = join(SCRATCH, 'ont-006-run-c');
const SHOT_DIR = join(SCRATCH, 'ONT-006-init-shots');

const PORT = 4879;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION = 'ont006-e2e';

const MODELS = ['Product', 'Customer', 'Order', 'OrderItem', 'AuditNote'];
const EXPECTED_READ_TOOLS = new Set(MODELS.flatMap((m) => [`${m}_get`, `${m}_list`]));
// OpenAPI write actions: placeOrder, issueRefund, derived DELETE /products/{id},
// sanitized hostile coupon op.
const EXPECTED_OPENAPI_ACTIONS = 4;
// Prisma write actions (ONT-018): every fixture model declares a single `@id`,
// so each yields create/update/delete — derived from the model set, not a
// magic number. If a model without a single @id were added, this would need a
// per-model breakdown (create-only for the keyless one).
const EXPECTED_PRISMA_ACTIONS = MODELS.length * 3;
const EXPECTED_ACTION_COUNT = EXPECTED_OPENAPI_ACTIONS + EXPECTED_PRISMA_ACTIONS; // 4 + 15 = 19

const fail = ({ message }) => {
  console.error(`ONT-006 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the predicate returns something truthy, and hand that value back.
 *
 * Returning the winning sample matters: a wait predicate must cover every fact
 * the assertions after it read, and the cheapest way to keep the two in step is
 * for the assertions to judge the very sample the wait accepted, rather than
 * re-reading a page that has moved on.
 */
const waitFor = async ({ label, fn, timeoutMs = 30_000, intervalMs = 500 }) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await fn();

    if (value) {
      return value;
    }

    await sleep(intervalMs);
  }

  fail({ message: `timed out waiting for: ${label}` });
  return undefined;
};

/** Runs an `orangerail` CLI command to completion inside a run dir. */
const runCli = ({ args, cwd }) => {
  const res = spawnSync('node', [CLI, ...args], {
    cwd,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

const ab = ({ args, input }) => {
  const res = spawnSync('agent-browser', ['--session', SESSION, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    ...(input === undefined ? {} : { input }),
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/**
 * Evaluate JS in the page and return the eval result as a string. The evaled
 * expressions in this scenario all `JSON.stringify(...)` their payload, and
 * agent-browser (0.27.0) JSON-encodes the string eval result onto stdout — so
 * one parse here unwraps the transport encoding and yields the inner JSON
 * string, which callers `JSON.parse` into the payload object.
 * (Test-harness fix by the scenario author after RED: the original `{`-slice
 * dropped the transport quoting and could never satisfy the callers'
 * double-parse — a helper bug, not an assertion change; disclosed in the
 * report.)
 */
const abEval = ({ js }) => {
  const { stdout } = ab({ args: ['eval', '--stdin'], input: js });
  const trimmed = stdout.trim();

  if (trimmed === '') {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

/** Every file (relative path -> content) under a directory, sorted. */
const snapshotDir = ({ dir }) => {
  const out = new Map();

  const walk = ({ rel }) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk({ rel: childRel });
      } else {
        out.set(childRel, readFileSync(join(dir, childRel), 'utf8'));
      }
    }
  };

  walk({ rel: '' });
  return out;
};

const prepareRunDir = ({ dir }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
};

/** Minimal MCP stdio client (ONT-003 pattern) over the generated config. */
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
      clientInfo: { name: 'ont-006-e2e', version: '0.0.0' },
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

// ───────────────────────── phase 1 — init full flow ─────────────────────────

console.log('[phase 1] flag-driven init with studio handoff');

prepareRunDir({ dir: RUN_A });
mkdirSync(SHOT_DIR, { recursive: true });

const init = spawn(
  'node',
  [CLI, 'init', '--yes', '--preset=approval-for-writes', '--port', String(PORT), '--no-open'],
  { cwd: RUN_A, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
);

let initOut = '';
init.stdout.on('data', (c) => {
  initOut += c.toString('utf8');
});
init.stderr.on('data', (c) => {
  initOut += c.toString('utf8');
});
let initExited = false;
init.on('exit', () => {
  initExited = true;
});

await waitFor({
  label: 'init-launched studio serving /api/registry',
  fn: async () => {
    if (initExited) {
      fail({ message: `init exited before the studio came up.\n--- init output ---\n${initOut}` });
    }
    const res = await fetch(`${BASE}/api/registry`).catch(() => undefined);
    return res !== undefined && res.ok;
  },
  timeoutMs: 60_000,
});

// generated file set
const ontologyDir = join(RUN_A, 'ontology');
assert({ ok: existsSync(ontologyDir), message: 'ontology/ directory was not generated' });
const ontologyFiles = readdirSync(ontologyDir).filter((f) => f.endsWith('.mjs'));
assert({
  ok: ontologyFiles.length >= MODELS.length + EXPECTED_ACTION_COUNT,
  message: `expected at least ${MODELS.length + EXPECTED_ACTION_COUNT} generated ontology/*.mjs files, got ${ontologyFiles.length}`,
});

const ontologyText = ontologyFiles
  .map((f) => readFileSync(join(ontologyDir, f), 'utf8'))
  .join('\n');
for (const model of MODELS) {
  assert({
    ok: ontologyText.includes(model),
    message: `generated ontology does not mention model ${model}`,
  });
}
assert({
  ok: /orangerail sync/i.test(ontologyText),
  message: 'generated ontology files must state the ownership contract (mention `orangerail sync`)',
});
assert({
  ok: !/do[ -]?not[ -]?edit/i.test(ontologyText),
  message: 'user-owned ontology files must NOT carry a do-not-edit marker',
});
assert({
  ok: /approval:\s*['"]required['"]/.test(ontologyText),
  message: 'write operations must be generated with approval: "required"',
});

assert({
  ok: existsSync(join(RUN_A, 'orangerail.config.mjs')),
  message: 'orangerail.config.mjs was not generated',
});

const agentsMd = join(RUN_A, '.orangerail', 'generated', 'AGENTS.md');
assert({ ok: existsSync(agentsMd), message: '.orangerail/generated/AGENTS.md was not generated' });
assert({
  ok: /do[ -]?not[ -]?edit/i.test(readFileSync(agentsMd, 'utf8')),
  message: 'generated AGENTS.md must carry the do-not-edit header',
});

// studio serves the generated graph — real browser via agent-browser
const RENDERED_MODELS = ['Product', 'Customer', 'Order'];
const PAGE_PROBE_JS = `JSON.stringify({ nodes: document.querySelectorAll('.react-flow__node').length, text: document.body.innerText.slice(0, 4000) })`;

ab({ args: ['open', BASE] });

// Wait for the TEXT the assertions read, not merely for nodes to exist in the
// DOM. `innerText` is defined over rendered text and skips any `visibility:
// hidden` subtree, and React Flow marks a node hidden until it has measured it
// — asynchronously, one pass after the node is already in the DOM and already
// counted by `.react-flow__node`. Measured against this very project, the nodes
// are in the DOM at 69-434ms while `innerText` still holds 58-90 characters and
// no model name at all; with the measurement pass stalled, the names only land
// ~3.1s in. Counting nodes therefore released the probe below into a page whose
// cards were all still invisible, which is the `studio page does not show
// generated object Product` failure seen in CI on a markdown-only PR.
const pageProbe = await waitFor({
  label: 'studio to render the generated object cards as visible text',
  fn: () => {
    const res = abEval({ js: PAGE_PROBE_JS });

    if (res === undefined) {
      return undefined;
    }

    const probe = JSON.parse(res);

    return probe.nodes >= MODELS.length && RENDERED_MODELS.every((m) => probe.text.includes(m))
      ? probe
      : undefined;
  },
  timeoutMs: 30_000,
});

for (const model of RENDERED_MODELS) {
  assert({
    ok: pageProbe.text.includes(model),
    message: `studio page does not show generated object ${model}`,
  });
}
ab({ args: ['screenshot', join(SHOT_DIR, 'init-01-studio-overview.png')] });

// Close the browser as soon as the scenario is done with it. Leaving it open
// leaked a Chrome process per run, and — because agent-browser reuses a live
// session — carried one run's browser into the next, which quietly defeats any
// per-run browser configuration.
ab({ args: ['close'] });

console.log(
  `[phase 1] OK — ${ontologyFiles.length} ontology files, studio up with ${pageProbe.nodes} nodes`,
);

// ─────────────────────── phase 2 — re-run init refuses ───────────────────────

console.log('[phase 2] init re-run refusal (AC-6)');

const beforeRerun = snapshotDir({ dir: ontologyDir });
const rerun = runCli({ args: ['init', '--yes', '--no-studio', '--no-open'], cwd: RUN_A });
assert({
  ok: rerun.status !== 0,
  message: `re-running init where a config exists must fail, got exit ${rerun.status}`,
});
assert({
  ok: /sync/i.test(rerun.stdout + rerun.stderr),
  message: 're-run refusal must point the user to `orangerail sync`',
});
const afterRerun = snapshotDir({ dir: ontologyDir });
assert({
  ok:
    beforeRerun.size === afterRerun.size &&
    [...beforeRerun].every(([k, v]) => afterRerun.get(k) === v),
  message: 'a refused init re-run must not modify any ontology file',
});

console.log('[phase 2] OK');

// stop the init-launched studio before booting MCP on the same output
init.kill('SIGTERM');
await waitFor({ label: 'init process exit', fn: () => initExited, timeoutMs: 15_000 });

// ─────────────────── phase 3 — MCP boots on generated output ───────────────────

console.log('[phase 3] orangerail mcp on the generated ontology (AC-5)');

const session = await openMcpSession({ cwd: RUN_A });
const toolsResult = await session.request({ method: 'tools/list', params: {} });
const toolNames = toolsResult.tools.map((t) => t.name);

for (const expected of EXPECTED_READ_TOOLS) {
  assert({
    ok: toolNames.includes(expected),
    message: `tools/list missing generated read tool ${expected}`,
  });
}
for (const expected of ['placeOrder', 'issueRefund']) {
  assert({
    ok: toolNames.includes(expected),
    message: `tools/list missing generated action tool ${expected}`,
  });
}

const actionTools = toolNames.filter((n) => !EXPECTED_READ_TOOLS.has(n) && n !== 'check_approval');
assert({
  ok: actionTools.length === EXPECTED_ACTION_COUNT,
  message: `expected ${EXPECTED_ACTION_COUNT} generated action tools, got ${actionTools.length}: ${actionTools.join(', ')}`,
});

// ONT-053: the read tools carry the domain, end to end from the Prisma schema.
// Everything below is derived from `prisma/schema.prisma` through the IR, the
// emitted zod, `ontology/_links.mjs` and the live registry — nothing in the
// server is hard-coded per object, so this is the only place the whole chain is
// proven at once.
const toolByName = new Map(toolsResult.tools.map((t) => [t.name, t]));

const customerFilter = toolByName.get('Customer_list')?.inputSchema?.properties?.filter ?? {};
assert({
  ok:
    JSON.stringify(Object.keys(customerFilter.properties ?? {})) ===
    JSON.stringify(['email', 'id', 'name']),
  message: `Customer_list filter must name exactly the scanned columns, got ${JSON.stringify(customerFilter)}`,
});
assert({
  ok: customerFilter.additionalProperties === false,
  message: 'the filter object must be CLOSED — the server refuses what it does not advertise',
});
// The OPTIONAL `name String?` column is unwrapped past `.optional()` and admits null.
assert({
  ok:
    JSON.stringify(customerFilter.properties?.name?.anyOf?.[0]?.type) ===
    JSON.stringify(['string', 'null']),
  message: `Customer_list must type the nullable "name" column as string|null, got ${JSON.stringify(customerFilter.properties?.name)}`,
});

// `enum ProductStatus { DRAFT ACTIVE ARCHIVED }` reaches the agent as legal values.
const productStatus =
  toolByName.get('Product_list')?.inputSchema?.properties?.filter?.properties?.status ?? {};
assert({
  ok:
    JSON.stringify(productStatus.anyOf?.[0]?.enum) ===
    JSON.stringify(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  message: `Product_list filter must publish the ProductStatus members in declared order, got ${JSON.stringify(productStatus)}`,
});

// The gate, on the real generated Prisma resolver. `Order` IS exposed here, so
// this is not an exfiltration — it is the proof that the shape is refused at the
// transport before it can ever become a `where` clause.
const relationFilter = await session.request({
  method: 'tools/call',
  params: {
    name: 'Customer_list',
    arguments: { filter: { orders: { some: { total: { gt: 0 } } } } },
  },
});
assert({
  ok:
    relationFilter.isError === true && relationFilter.structuredContent?.status === 'invalid_input',
  message: `a relation filter must be REFUSED, got ${JSON.stringify(relationFilter).slice(0, 300)}`,
});
assert({
  ok: (relationFilter.structuredContent?.issues ?? []).some((issue) =>
    issue.includes('"orders" is not a filterable field'),
  ),
  message: `the refusal must name the offending key, got ${JSON.stringify(relationFilter.structuredContent)}`,
});

// ...and the grammar it DOES advertise gets PAST the gate, so the schema is true
// in both directions rather than merely restrictive. This fixture has no
// database — it is a codegen + tools/list scenario — so the call then fails in
// the resolver on a missing Prisma client. That is the proof: reaching the
// resolver at all means the filter was admitted, and the status distinguishes
// the two outcomes precisely (`invalid_input` is the gate, `resolve_error` is
// everything past it).
const scalarFilter = await session.request({
  method: 'tools/call',
  params: {
    name: 'Product_list',
    arguments: { filter: { status: 'DRAFT', price: { gte: 0 }, title: { contains: '' } } },
  },
});
assert({
  ok: scalarFilter.structuredContent?.status !== 'invalid_input',
  message: `a filter the schema advertises must reach the resolver, got ${JSON.stringify(scalarFilter.structuredContent)}`,
});

// `model Customer { orders Order[] }` -> a link -> a sentence on BOTH read tools.
for (const readTool of ['Customer_get', 'Customer_list']) {
  assert({
    ok: (toolByName.get(readTool)?.description ?? '').includes('Relations: has many Order.'),
    message: `${readTool} must name the Customer -> Order relation, got "${toolByName.get(readTool)?.description}"`,
  });
}
assert({
  ok: (toolByName.get('Order_list')?.description ?? '').includes('belongs to Customer'),
  message: 'Order_list must name the inbound side of the same relation',
});
// AuditNote has no relations, so it pays nothing and reads exactly as before.
assert({
  ok: toolByName.get('AuditNote_get')?.description === 'Fetch a single AuditNote by id.',
  message: `an object with no links must keep its original description, got "${toolByName.get('AuditNote_get')?.description}"`,
});

// ONT-061: the WRITE surface has to describe itself as honestly as the read one.
// This is the only fence that watches a GENERATED action's published contract —
// the defect it guards (every optional field publishing `{}`, so every generated
// `update*` was fully type-erased) survived every unit test in the repo, because
// every one of them builds its zod in-process instead of reading it back off the
// wire.
const updateProduct = toolByName.get('updateProduct')?.inputSchema ?? {};

assert({
  ok:
    JSON.stringify(updateProduct.properties?.price) === JSON.stringify({ type: 'number' }) &&
    JSON.stringify(updateProduct.properties?.title) === JSON.stringify({ type: 'string' }),
  message: `updateProduct must publish a type for its OPTIONAL columns, got ${JSON.stringify(updateProduct.properties)}`,
});
assert({
  ok: JSON.stringify(updateProduct.required) === JSON.stringify(['id']),
  message: `optionality belongs in "required", not in an emptied property — got required=${JSON.stringify(updateProduct.required)}`,
});
assert({
  ok:
    JSON.stringify(updateProduct.properties?.status?.enum) ===
    JSON.stringify(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  message: `updateProduct must publish the ProductStatus members, got ${JSON.stringify(updateProduct.properties?.status)}`,
});
// OPEN, unlike the filter object, and deliberately: a zod object is non-strict,
// so an undeclared key is accepted and stripped. `false` would advertise a
// refusal this surface does not perform.
assert({
  ok: updateProduct.additionalProperties === true,
  message: 'an action input must stay open — no checker here refuses an undeclared key',
});

// The refusal has to be actionable. Blind, it cost 4 of 12 items in an
// unattended-queue run: the agent guessed a string for an untyped column and
// nothing in the loop could tell it otherwise.
const wrongType = await session.request({
  method: 'tools/call',
  params: { name: 'updateProduct', arguments: { id: 'p1', price: 'free' } },
});
assert({
  ok: wrongType.structuredContent?.status === 'invalid_input',
  message: `a wrong-typed optional must be refused, got ${JSON.stringify(wrongType.structuredContent)}`,
});
assert({
  ok: (wrongType.structuredContent?.issues ?? []).includes('"price" expects number'),
  message: `the refusal must name the field and the type it wanted, got ${JSON.stringify(wrongType.structuredContent)}`,
});
assert({
  ok: (wrongType.content ?? []).some((part) =>
    (part.text ?? '').includes('"price" expects number'),
  ),
  message:
    'the issues must reach the TEXT content — a tool with no outputSchema is read from there',
});

// ...and the type the schema advertises gets past the parser, so the contract is
// true in both directions. Same shape of proof as the filter above: this fixture
// has no database, so anything past the parse fails downstream, and the STATUS is
// what distinguishes the gate from everything behind it.
const rightType = await session.request({
  method: 'tools/call',
  params: { name: 'updateProduct', arguments: { id: 'p1', price: 9.5 } },
});
assert({
  ok: rightType.structuredContent?.status !== 'invalid_input',
  message: `a value the schema advertises must not be refused by the parser, got ${JSON.stringify(rightType.structuredContent)}`,
});

// the server booted at all => build-time tool-name validation passed => the
// hostile operationId was sanitized into the MCP-safe charset.
await session.close();

console.log(`[phase 3] OK — ${toolNames.length} tools`);

// ───────────────────── phase 4 — byte determinism (AC-9) ─────────────────────

console.log('[phase 4] two fresh runs produce identical bytes');

for (const dir of [RUN_B, RUN_C]) {
  prepareRunDir({ dir });
  const res = runCli({ args: ['init', '--yes', '--no-studio', '--no-open'], cwd: dir });
  assert({
    ok: res.status === 0,
    message: `init in ${dir} failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
  });
}

for (const rel of ['ontology', '.orangerail/generated']) {
  const b = snapshotDir({ dir: join(RUN_B, rel) });
  const c = snapshotDir({ dir: join(RUN_C, rel) });
  assert({
    ok: b.size === c.size && [...b].every(([k, v]) => c.get(k) === v),
    message: `generated ${rel}/ differs between two identical runs — generation is not deterministic`,
  });
}
assert({
  ok:
    readFileSync(join(RUN_B, 'orangerail.config.mjs'), 'utf8') ===
    readFileSync(join(RUN_C, 'orangerail.config.mjs'), 'utf8'),
  message: 'generated config differs between two identical runs',
});

console.log('[phase 4] OK');

// ──────────────────────── phase 5 — sync drift (AC-7) ────────────────────────

console.log('[phase 5] sync: clean, drift, --accept-new, unregistered warning');

// ONT-043 (#50) added a governance baseline; ONT-050 (#N) made `init` write it.
// ONT-043 declined to, on the grounds that a baseline asserts a human reviewed
// the posture — sound, and the reason the file now records WHO wrote it. An
// init-provenance baseline is a starting point, not an approval, so it is
// detected against from the first run while every readout keeps saying it is
// unreviewed. This scenario used to run `--accept-governance` by hand here to
// work around the missing file; it now asserts the file is simply there.
const baselinePath = join(RUN_A, 'orangerail.governance.json');
assert({
  ok: existsSync(baselinePath),
  message: '`orangerail init` must record orangerail.governance.json at the project root',
});
assert({
  ok: JSON.parse(readFileSync(baselinePath, 'utf8')).recordedBy === 'init',
  message: 'the baseline init writes must be stamped `recordedBy: "init"`, never as reviewed',
});

const clean = runCli({ args: ['sync'], cwd: RUN_A });
assert({
  ok: clean.status === 0,
  message: `sync right after init + recorded baseline must be clean (exit 0), got ${clean.status}:\n${clean.stdout}\n${clean.stderr}`,
});
assert({
  ok: !/no recorded baseline/.test(clean.stdout + clean.stderr),
  message: `a recorded baseline must silence the governance nag:\n${clean.stdout}\n${clean.stderr}`,
});
assert({
  ok: /recorded by `orangerail init`/.test(clean.stdout + clean.stderr),
  message: `an unreviewed baseline must keep saying so:\n${clean.stdout}\n${clean.stderr}`,
});

// ── ONT-050: the adoption tester's exact reproduction, on the shipped binary ──
// Delete the approval gate from a generated action. Pre-ONT-050 there was no
// baseline here at all, so `sync` could only report that it could not tell, and
// `orangerail mcp` then served the un-gated action to an agent with a green
// audit chain behind it.
const gatedFile = join(ontologyDir, 'deleteOrder.mjs');
const gatedSource = readFileSync(gatedFile, 'utf8');
assert({
  ok: gatedSource.includes("policy: { approval: 'required' },"),
  message: 'the generated deleteOrder action must carry an approval gate to begin with',
});
writeFileSync(gatedFile, gatedSource.replace("  policy: { approval: 'required' },\n", ''));

const ungated = runCli({ args: ['sync'], cwd: RUN_A });
assert({
  ok: ungated.status === 1,
  message: `sync must exit 1 on a removed approval gate, got ${ungated.status}:\n${ungated.stdout}\n${ungated.stderr}`,
});
assert({
  ok: /governance: deleteOrder — approval gate removed/.test(ungated.stdout + ungated.stderr),
  message: `sync must name the action whose gate was removed:\n${ungated.stdout}\n${ungated.stderr}`,
});

// And the server refuses to serve exactly that action, while serving the rest.
{
  const session = await openMcpSession({ cwd: RUN_A });
  try {
    const listed = await session.request({ method: 'tools/list', params: {} });
    const names = new Set(listed.tools.map((tool) => tool.name));

    assert({
      ok: !names.has('deleteOrder'),
      message: 'a weakened action must not be exposed in tools/list',
    });
    assert({
      ok: names.has('deleteCustomer') && names.has('Order_get'),
      message: 'withholding one action must not take the rest of the ontology down with it',
    });

    const called = await session.request({
      method: 'tools/call',
      params: { name: 'deleteOrder', arguments: { id: '8' } },
    });
    assert({
      ok: called.isError === true && /[Uu]nknown tool/.test(JSON.stringify(called)),
      message: `calling a withheld action must not execute it: ${JSON.stringify(called)}`,
    });
  } finally {
    await session.close();
  }
}

writeFileSync(gatedFile, gatedSource);
const restored = runCli({ args: ['sync'], cwd: RUN_A });
assert({
  ok: restored.status === 0,
  message: `restoring the gate must make sync clean again, got ${restored.status}:\n${restored.stdout}\n${restored.stderr}`,
});

cpSync(join(FIXTURE, 'prisma', 'schema-drifted.prisma'), join(RUN_A, 'prisma', 'schema.prisma'));

const beforeDrift = snapshotDir({ dir: ontologyDir });
const drift = runCli({ args: ['sync'], cwd: RUN_A });
assert({
  ok: drift.status === 1,
  message: `sync with drift must exit 1, got ${drift.status}:\n${drift.stdout}\n${drift.stderr}`,
});
const driftOut = drift.stdout + drift.stderr;
assert({
  ok: /Review/.test(driftOut),
  message: 'drift report must propose the new Review model',
});
assert({
  ok: /price/.test(driftOut),
  message: 'drift report must warn about the changed Product.price field',
});
const afterDrift = snapshotDir({ dir: ontologyDir });
assert({
  ok:
    beforeDrift.size === afterDrift.size &&
    [...beforeDrift].every(([k, v]) => afterDrift.get(k) === v),
  message: 'a plain sync run must not modify any ontology file',
});

const accept = runCli({ args: ['sync', '--accept-new'], cwd: RUN_A });
const afterAccept = snapshotDir({ dir: ontologyDir });
// The new Review model brings its object file AND its three CRUD action files
// (ONT-018: every mutable model yields create/update/delete), so --accept-new
// creates exactly four new files, not one.
const EXPECTED_NEW_FILES = 4;
assert({
  ok: afterAccept.size === beforeDrift.size + EXPECTED_NEW_FILES,
  message: `--accept-new must create exactly ${EXPECTED_NEW_FILES} new files for the new model (before ${beforeDrift.size}, after ${afterAccept.size}); exit ${accept.status}`,
});
assert({
  ok: [...beforeDrift].every(([k, v]) => afterAccept.get(k) === v),
  message: '--accept-new must leave every pre-existing ontology file byte-identical',
});
const newFiles = [...afterAccept.keys()].filter((k) => !beforeDrift.has(k));
assert({
  ok: newFiles.includes('Review.mjs') && afterAccept.get('Review.mjs').includes('Review'),
  message: `the accepted new object file must declare the Review model (got ${newFiles.join(', ')})`,
});
assert({
  ok: ['createReview.mjs', 'updateReview.mjs', 'deleteReview.mjs'].every((f) =>
    newFiles.includes(f),
  ),
  message: `--accept-new must also add the new model's CRUD action files (got ${newFiles.join(', ')})`,
});

writeFileSync(join(ontologyDir, 'stray.ts'), 'export const stray = true;\n');
const unregistered = runCli({ args: ['sync'], cwd: RUN_A });
assert({
  ok:
    /unregistered/i.test(unregistered.stdout + unregistered.stderr) &&
    /stray\.ts/.test(unregistered.stdout + unregistered.stderr),
  message: 'sync must warn about the unregistered ontology/stray.ts file',
});
// ONT-050: an ontology file the loader never imports can hold a whole set of
// governed actions the user believes are live. Reporting it and then exiting 0
// is the report and the exit code disagreeing in the one command whose job is
// to make change visible.
assert({
  ok: unregistered.status === 1,
  message: `an unregistered ontology file is drift and must exit 1, got ${unregistered.status}`,
});

console.log('[phase 5] OK');

console.log('ONT-006 e2e scenario: all phases passed');
process.exit(0);
