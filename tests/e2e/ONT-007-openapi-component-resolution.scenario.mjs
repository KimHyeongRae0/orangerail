/**
 * ONT-007 e2e driver — OpenAPI component resolution (ticket section 5).
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) against two copied fixture
 * repos and proves that local `#/components/*` references resolve into complete
 * typed action inputs, while genuinely unresolvable references stay honest:
 *
 *   Phase 1 (clean fixture, RUN dir A): `orangerail init --no-studio` exits 0 and
 *     the generated `ontology/*.mjs` files carry every component-referenced
 *     field — $ref path parameters (GitHub shape), $ref / nested / allOf
 *     request bodies (cal.com/NestJS shape) — with the correct optionality; the
 *     fully-resolvable document emits ZERO openapi $ref / unresolvable /
 *     composition warnings; the hostile enum string inside a component schema
 *     survives escaping (init's smoke-load already loaded the file).
 *   Phase 2 (clean fixture, RUN dir B): a fresh init is byte-identical to RUN A
 *     (determinism).
 *   Phase 3 (MCP, RUN dir A): `orangerail mcp` exposes the resolved fields over
 *     tools/list (replaceTopics -> owner/repo/names, cancelBooking ->
 *     cancellationReason/allRemainingBookings/uid).
 *   Phase 4 (hostile fixture, RUN dir C): init exits 0 (skip-with-warning never
 *     crashes); the aggregated warning names the missing target, the external
 *     pointer, and the cycle; the oneOf raises a composition warning; the union
 *     body surfaces both branch fields as optional; the missing $ref parameter
 *     is dropped while the inline path param survives.
 *
 * RED (pre-implementation): today's scanner reads inline shapes only, so $ref
 * params are counted-and-skipped and $ref / allOf / oneOf bodies produce no
 * fields — the Phase 1 resolved-field assertions FAIL (init still exits 0).
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-007');
const CLEAN_FIXTURE = join(FIXTURES, 'clean');
const HOSTILE_FIXTURE = join(FIXTURES, 'hostile');
const SCRATCH = join(ROOT, '.docs', 'scratch');
const RUN_A = join(SCRATCH, 'ont-007-run-a');
const RUN_B = join(SCRATCH, 'ont-007-run-b');
const RUN_C = join(SCRATCH, 'ont-007-run-c');

const fail = ({ message }) => {
  console.error(`ONT-007 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
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

/** Copy a fixture repo into a clean scratch run dir. */
const prepareRunDir = ({ dir, fixture }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(fixture, dir, { recursive: true });
};

/** Read a generated `ontology/<name>.mjs` file (fails clearly if absent). */
const readOntologyFile = ({ runDir, name }) => {
  const filePath = join(runDir, 'ontology', name);
  assert({
    ok: existsSync(filePath),
    message: `expected generated ontology file ${name} (${filePath})`,
  });

  return readFileSync(filePath, 'utf8');
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
      clientInfo: { name: 'ont-007-e2e', version: '0.0.0' },
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

// ───────────────── phase 1 — clean fixture: resolved fields ─────────────────

console.log('[phase 1] clean fixture: $ref params + $ref/nested/allOf bodies resolve');

prepareRunDir({ dir: RUN_A, fixture: CLEAN_FIXTURE });

const cleanInit = runCli({
  args: ['init', '--yes', '--preset=approval-for-writes', '--no-studio'],
  cwd: RUN_A,
});

assert({
  ok: cleanInit.status === 0,
  message: `init on the clean fixture must exit 0, got ${cleanInit.status}:\n${cleanInit.stdout}\n${cleanInit.stderr}`,
});

const cleanOutput = `${cleanInit.stdout}\n${cleanInit.stderr}`;

// AC-1: $ref path parameters (GitHub shape) resolve into the action input.
const replaceTopics = readOntologyFile({ runDir: RUN_A, name: 'replaceTopics.mjs' });
assert({
  ok: replaceTopics.includes('"owner": z.string()'),
  message:
    'replaceTopics missing resolved owner param — $ref parameter #/components/parameters/owner did not resolve',
});
assert({
  ok: replaceTopics.includes('"repo": z.string()'),
  message:
    'replaceTopics missing resolved repo param — $ref parameter #/components/parameters/repo did not resolve',
});

// AC-5: a fully-resolvable document emits no openapi resolution/composition
// warning (GET-skip info lines do not match this regex).
const warningLine = cleanOutput
  .split('\n')
  .find((line) => /\$ref|unresolvable|composition/.test(line));
assert({
  ok: warningLine === undefined,
  message: `clean fixture must emit no $ref/unresolvable/composition warning, but saw: ${warningLine}`,
});

// AC-2: top-level $ref body (cal.com/NestJS shape) resolves; required vs
// optional mapping matches the referenced schema.
const cancelBooking = readOntologyFile({ runDir: RUN_A, name: 'cancelBooking.mjs' });
assert({
  ok: cancelBooking.includes('"cancellationReason": z.string()'),
  message: 'cancelBooking missing required cancellationReason (from $ref CancelBookingInput)',
});
assert({
  ok: cancelBooking.includes('"allRemainingBookings": z.boolean().optional()'),
  message: 'cancelBooking missing optional allRemainingBookings (from $ref CancelBookingInput)',
});

// AC-3: nested schema->schema $ref inside a resolved body ($ref SeatId, an
// integer) resolves to the emitter's int form.
const rescheduleBooking = readOntologyFile({ runDir: RUN_A, name: 'rescheduleBooking.mjs' });
assert({
  ok: rescheduleBooking.includes('"seatId": z.number().int()'),
  message:
    'rescheduleBooking missing nested $ref field seatId (SeatId integer) as z.number().int()',
});
assert({
  ok: rescheduleBooking.includes('"reason": z.string()'),
  message: 'rescheduleBooking missing inline required field reason',
});

// AC-4: allOf body merges both branch schemas (required id + optional note).
const updateBooking = readOntologyFile({ runDir: RUN_A, name: 'updateBooking.mjs' });
assert({
  ok: updateBooking.includes('"id": z.string()'),
  message: 'updateBooking missing required id from allOf branch BaseUpdate',
});
assert({
  ok: updateBooking.includes('"note": z.string().optional()'),
  message: 'updateBooking missing optional note from allOf branch ExtraUpdate',
});

// AC-7: a hostile enum string inside a component schema resolves through the
// body $ref and survives the escape layer — init exited 0, so the file
// smoke-loaded; assert the value is present as escaped data.
const setPriority = readOntologyFile({ runDir: RUN_A, name: 'setPriority.mjs' });
assert({
  ok: setPriority.includes('emergency'),
  message: 'setPriority missing the resolved hostile enum value (from $ref PriorityInput)',
});

console.log('[phase 1] OK');

// ─────────────────── phase 2 — clean fixture: determinism ───────────────────

console.log('[phase 2] two fresh runs of the clean fixture produce identical bytes');

prepareRunDir({ dir: RUN_B, fixture: CLEAN_FIXTURE });

const cleanInitB = runCli({
  args: ['init', '--yes', '--preset=approval-for-writes', '--no-studio'],
  cwd: RUN_B,
});
assert({
  ok: cleanInitB.status === 0,
  message: `second clean init must exit 0, got ${cleanInitB.status}:\n${cleanInitB.stdout}\n${cleanInitB.stderr}`,
});

const ontologyA = snapshotDir({ dir: join(RUN_A, 'ontology') });
const ontologyB = snapshotDir({ dir: join(RUN_B, 'ontology') });
assert({
  ok: ontologyA.size === ontologyB.size && [...ontologyA].every(([k, v]) => ontologyB.get(k) === v),
  message:
    'generated ontology/ differs between two identical clean runs — generation is not deterministic',
});

console.log('[phase 2] OK');

// ──────────────── phase 3 — MCP exposes the resolved fields ─────────────────

console.log('[phase 3] MCP tools/list exposes resolved component fields');

const session = await openMcpSession({ cwd: RUN_A });
const toolsResult = await session.request({ method: 'tools/list', params: {} });
const toolsByName = new Map(toolsResult.tools.map((t) => [t.name, t]));

const replaceTopicsTool = toolsByName.get('replaceTopics');
assert({ ok: replaceTopicsTool !== undefined, message: 'tools/list missing replaceTopics' });
const replaceTopicsProps = Object.keys(replaceTopicsTool.inputSchema?.properties ?? {});
for (const key of ['owner', 'repo', 'names']) {
  assert({
    ok: replaceTopicsProps.includes(key),
    message: `replaceTopics inputSchema missing property ${key} (got ${replaceTopicsProps.join(', ')})`,
  });
}

const cancelBookingTool = toolsByName.get('cancelBooking');
assert({ ok: cancelBookingTool !== undefined, message: 'tools/list missing cancelBooking' });
const cancelBookingProps = Object.keys(cancelBookingTool.inputSchema?.properties ?? {});
for (const key of ['cancellationReason', 'allRemainingBookings', 'uid']) {
  assert({
    ok: cancelBookingProps.includes(key),
    message: `cancelBooking inputSchema missing property ${key} (got ${cancelBookingProps.join(', ')})`,
  });
}

await session.close();

console.log('[phase 3] OK');

// ──────── phase 4 — hostile fixture: honest skip-with-warning + oneOf ────────

console.log('[phase 4] hostile fixture: unresolvables named, oneOf composed, never crashes');

prepareRunDir({ dir: RUN_C, fixture: HOSTILE_FIXTURE });

const hostileInit = runCli({
  args: ['init', '--yes', '--preset=approval-for-writes', '--no-studio'],
  cwd: RUN_C,
});
assert({
  ok: hostileInit.status === 0,
  message: `init on the hostile fixture must exit 0 (skip-with-warning never crashes), got ${hostileInit.status}:\n${hostileInit.stdout}\n${hostileInit.stderr}`,
});

const hostileOutput = `${hostileInit.stdout}\n${hostileInit.stderr}`;

// AC-5: the aggregated warning names each genuine unresolvable reason bucket.
for (const pattern of [/missing/, /external/, /cycle/]) {
  assert({
    ok: pattern.test(hostileOutput),
    message: `hostile init output must name the unresolvable bucket ${pattern} — output:\n${hostileOutput}`,
  });
}

// AC-4: the oneOf body raises a composition warning.
assert({
  ok: /oneOf|composition/.test(hostileOutput),
  message: `hostile init output must raise a composition warning for the oneOf body — output:\n${hostileOutput}`,
});

// AC-4: the union body surfaces both branch fields, all optional.
const createUnion = readOntologyFile({ runDir: RUN_C, name: 'createUnion.mjs' });
assert({
  ok: createUnion.includes('"emailField": z.string().optional()'),
  message: 'createUnion missing emailField (BranchA) as optional — oneOf union should surface it',
});
assert({
  ok: createUnion.includes('"phoneField": z.string().optional()'),
  message: 'createUnion missing phoneField (BranchB) as optional — oneOf union should surface it',
});

// AC-1 edge: a missing $ref parameter is dropped, the inline path param stays.
const updateRefParam = readOntologyFile({ runDir: RUN_C, name: 'updateRefParam.mjs' });
assert({
  ok: updateRefParam.includes('"id": z.string()'),
  message:
    'updateRefParam missing its inline path param id (a missing $ref param must not drop the inline one)',
});

console.log('[phase 4] OK');

console.log('ONT-007 e2e scenario: all phases passed');
process.exit(0);
