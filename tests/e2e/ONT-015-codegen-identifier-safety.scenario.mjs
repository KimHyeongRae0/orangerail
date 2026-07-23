/**
 * ONT-015 e2e driver — codegen identifier safety (ticket section 5).
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) against crafted
 * Prisma/OpenAPI fixtures under per-phase scratch run dirs (pure Node stdlib —
 * no Playwright, no browser) and proves the two MEDIUM + one LOW
 * identifier/filename defects the security audit confirmed are closed, while a
 * no-collision input stays byte-deterministic:
 *
 *   Phase 1 (AC-1, reserved binding): a Prisma schema with models `registry`
 *     and `z` (names the generated modules already import) plus ordinary models
 *     `Alpha`/`Beta`. init must produce an orangerail.config.mjs that dynamic-
 *     imports WITHOUT throwing, and `orangerail mcp` must serve every object.
 *   Phase 2 (AC-2, object + object-vs-action dedup): a schema with `A__B` and
 *     `A_B` (both sanitize to `A_B`) plus a `Widget` object whose binding
 *     collides with a `Widget` OpenAPI write op. All four bindings must land in
 *     four distinct ontology/*.mjs files — none silently dropped.
 *   Phase 3 (AC-3, surfaced collision): the de-collision warning (naming the
 *     original + the chosen identifier) must appear on init's stderr for the
 *     phase-2 collisions, not be swallowed into a silent count mismatch.
 *   Phase 4 (AC-4, action filename at the sink): an OpenAPI op whose MCP-safe
 *     name keeps a hyphen (`create-thing`) must emit a file named after its
 *     re-sanitized binding (`create_thing.mjs`), not the raw name.
 *   Phase 5 (AC-5, byte-identity): the no-collision ONT-006 fixture, init'd
 *     twice, must produce byte-identical config + ontology + generated docs
 *     (the reference is captured by the shipped CLI at scenario start, so this
 *     phase passes both before and after the fix; RED is driven by phases 1-3).
 *
 * RED (pre-implementation): (1) the `registry`/`z` model makes codegen emit a
 * duplicate `export const registry`/`z` that throws `SyntaxError: Identifier
 * 'registry' has already been declared` — init's staged smoke-load aborts, the
 * config is never written, and phase 1 fails "config not generated". (2) `A__B`
 * and `A_B` both emit `ontology/A_B.mjs` and `Widget` object/action both emit
 * `ontology/Widget.mjs`; the later write wins, leaving 2 files where 4 are
 * expected, so phase 2 fails. (3) No collision warning is surfaced, so phase 3
 * fails. (4) The action file is named `create-thing.mjs`, so phase 4 fails.
 * Phase 5 (determinism) holds today.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-015');
const ONT006_FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-006');
const SCRATCH = join(ROOT, '.docs', 'scratch');

// Run dirs MUST live under the repo so the generated code's bare specifiers
// (`orangerail-core`, `zod`) resolve via node_modules walk-up — exactly the
// resolvable path where init smoke-loads the staged config (the reserved-name
// SyntaxError surfaces here).
const RUN_RESERVED = join(SCRATCH, 'ont-015-run-reserved');
const RUN_DEDUP = join(SCRATCH, 'ont-015-run-dedup');
const RUN_ACTION = join(SCRATCH, 'ont-015-run-action-filename');
const RUN_BYTE_A = join(SCRATCH, 'ont-015-run-byte-a');
const RUN_BYTE_B = join(SCRATCH, 'ont-015-run-byte-b');

const ALL_RUN_DIRS = [RUN_RESERVED, RUN_DEDUP, RUN_ACTION, RUN_BYTE_A, RUN_BYTE_B];

/** Thrown by `assert`; carries an AC-named message the phase runner reports. */
class AssertionError extends Error {}

const assert = ({ ok, message }) => {
  if (!ok) {
    throw new AssertionError(message);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Copy a fixture repo into a fresh run dir. */
const prepareRunDir = ({ dir, fixture }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(fixture, dir, { recursive: true });
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

/** The generated user-owned ontology object/action files (excludes the shared registry + links). */
const ontologyBindingFiles = ({ dir }) => {
  const ontologyDir = join(dir, 'ontology');

  if (!existsSync(ontologyDir)) {
    return [];
  }

  return readdirSync(ontologyDir)
    .filter((name) => name.endsWith('.mjs') && !name.startsWith('_'))
    .sort();
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

const mapsEqual = ({ a, b }) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** Minimal MCP stdio client (ONT-006 pattern) over the generated config. */
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
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const exited = new Promise((resolve) => child.on('exit', resolve));

  await request({
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ont-015-e2e', version: '0.0.0' },
    },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const close = async () => {
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
  };

  return { request, close };
};

// ───────────────────────────────── phases ─────────────────────────────────

/** Phase 1 (AC-1): reserved generated-binding names load + serve. */
const phaseReservedBinding = async () => {
  prepareRunDir({ dir: RUN_RESERVED, fixture: join(FIXTURES, 'reserved') });

  const init = runCli({ args: ['init', '--yes', '--no-studio', '--no-open'], cwd: RUN_RESERVED });
  const configPath = join(RUN_RESERVED, 'orangerail.config.mjs');

  // RED: the `registry`/`z` model makes the staged smoke-load throw
  // `SyntaxError: Identifier 'registry' has already been declared`, so init
  // aborts before writing the config. Surface the SyntaxError as the AC-1
  // failure rather than letting a later import crash the scenario.
  assert({
    ok: existsSync(configPath),
    message:
      `AC-1: orangerail.config.mjs was not generated — a reserved-binding model ` +
      `(registry/z) made codegen emit a duplicate declaration that fails to load ` +
      `(init exit ${init.status}). init stderr:\n${init.stderr.trim()}`,
  });

  let importError;
  try {
    await import(pathToFileURL(configPath).href);
  } catch (error) {
    importError = error;
  }

  assert({
    ok: importError === undefined,
    message:
      `AC-1: the emitted orangerail.config.mjs failed to import (reserved-binding ` +
      `SyntaxError expected pre-fix): ${importError?.message ?? importError}`,
  });

  // config loads + serves: `orangerail mcp` boots on the generated output and
  // exposes a read tool for every scanned object, including the reserved names.
  const session = await openMcpSession({ cwd: RUN_RESERVED });
  try {
    const result = await session.request({ method: 'tools/list', params: {} });
    const toolNames = new Set(result.tools.map((t) => t.name));

    for (const object of ['registry', 'z', 'Alpha', 'Beta']) {
      assert({
        ok: toolNames.has(`${object}_get`),
        message: `AC-1: orangerail mcp tools/list is missing the read tool ${object}_get for scanned object '${object}'`,
      });
    }
  } finally {
    await session.close();
  }

  return { detail: 'config imports cleanly and mcp serves registry/z/Alpha/Beta' };
};

/** Phase 2 (AC-2): objects (and object-vs-action) are de-duplicated, none dropped. */
const phaseObjectDedup = async ({ init }) => {
  // 3 objects (A__B, A_B, Widget) + 1 action (Widget) = 4 distinct bindings.
  // Pre-fix, A__B/A_B collapse into one A_B.mjs and the Widget object is
  // overwritten by the Widget action -> only 2 files on disk.
  const files = ontologyBindingFiles({ dir: RUN_DEDUP });

  assert({
    ok: init.status === 0,
    message: `AC-2: init on the dedup fixture must succeed (exit 0), got ${init.status}. stderr:\n${init.stderr.trim()}`,
  });

  assert({
    ok: files.length === 4,
    message:
      `AC-2: expected 4 distinct ontology bindings (A__B, A_B, Widget object, ` +
      `Widget action) in distinct files, got ${files.length}: [${files.join(', ')}]. ` +
      `A post-sanitize duplicate object or an object-vs-action collision was ` +
      `silently dropped (later write wins).`,
  });

  return { detail: `4 distinct ontology files: [${files.join(', ')}]` };
};

/** Phase 3 (AC-3): the de-collision is surfaced on stderr, not silent. */
const phaseSurfacedWarning = async ({ init }) => {
  const stderr = init.stderr;

  assert({
    ok: /rename|already taken|collision/i.test(stderr),
    message:
      `AC-3: the dedup collision (A__B/A_B and the Widget object-vs-action clash) ` +
      `must surface a warning naming the original + chosen identifier on stderr; ` +
      `found none. init stderr:\n${stderr.trim()}`,
  });

  return { detail: 'collision warning surfaced on stderr' };
};

/** Phase 4 (AC-4): the action filename is re-sanitized at the sink. */
const phaseActionFilename = async () => {
  prepareRunDir({ dir: RUN_ACTION, fixture: join(FIXTURES, 'action-filename') });

  const init = runCli({ args: ['init', '--yes', '--no-studio', '--no-open'], cwd: RUN_ACTION });
  assert({
    ok: init.status === 0,
    message: `AC-4: init on the action-filename fixture must succeed (exit 0), got ${init.status}. stderr:\n${init.stderr.trim()}`,
  });

  const ontologyDir = join(RUN_ACTION, 'ontology');

  assert({
    ok: existsSync(join(ontologyDir, 'create_thing.mjs')),
    message:
      `AC-4: the action file must be named after its re-sanitized binding ` +
      `(create_thing.mjs), matching \`export const create_thing\`; found ` +
      `[${ontologyBindingFiles({ dir: RUN_ACTION }).join(', ')}]`,
  });

  assert({
    ok: !existsSync(join(ontologyDir, 'create-thing.mjs')),
    message:
      `AC-4: the action file must NOT be named from the raw MCP name ` +
      `(create-thing.mjs) — the filename stem and export binding must agree`,
  });

  return { detail: 'action file emitted as create_thing.mjs (== binding)' };
};

/** Phase 5 (AC-5): a no-collision input stays byte-identical across runs. */
const phaseByteIdentity = async () => {
  for (const dir of [RUN_BYTE_A, RUN_BYTE_B]) {
    prepareRunDir({ dir, fixture: ONT006_FIXTURE });
    const res = runCli({ args: ['init', '--yes', '--no-studio', '--no-open'], cwd: dir });
    assert({
      ok: res.status === 0,
      message: `AC-5: init on the no-collision ONT-006 fixture must succeed (exit 0), got ${res.status} in ${dir}. stderr:\n${res.stderr.trim()}`,
    });
  }

  for (const rel of ['ontology', '.orangerail/generated']) {
    const a = snapshotDir({ dir: join(RUN_BYTE_A, rel) });
    const b = snapshotDir({ dir: join(RUN_BYTE_B, rel) });
    assert({
      ok: mapsEqual({ a, b }),
      message: `AC-5: generated ${rel}/ is not byte-identical across two no-collision runs (determinism / non-regression broke)`,
    });
  }

  assert({
    ok:
      readFileSync(join(RUN_BYTE_A, 'orangerail.config.mjs'), 'utf8') ===
      readFileSync(join(RUN_BYTE_B, 'orangerail.config.mjs'), 'utf8'),
    message: 'AC-5: generated orangerail.config.mjs differs across two no-collision runs',
  });

  return { detail: 'config + ontology/ + generated docs byte-identical across runs' };
};

// ──────────────────────────────── runner ────────────────────────────────

const main = async () => {
  // The dedup fixture (phases 2 + 3) is init'd once; both phases read its output.
  prepareRunDir({ dir: RUN_DEDUP, fixture: join(FIXTURES, 'dedup') });
  const dedupInit = runCli({ args: ['init', '--yes', '--no-studio', '--no-open'], cwd: RUN_DEDUP });

  const phases = [
    { name: 'AC-1 reserved binding loads + serves', run: () => phaseReservedBinding() },
    {
      name: 'AC-2 object / object-vs-action dedup',
      run: () => phaseObjectDedup({ init: dedupInit }),
    },
    {
      name: 'AC-3 collision surfaced on stderr',
      run: () => phaseSurfacedWarning({ init: dedupInit }),
    },
    { name: 'AC-4 action filename re-sanitized at sink', run: () => phaseActionFilename() },
    { name: 'AC-5 no-collision input byte-identical', run: () => phaseByteIdentity() },
  ];

  const failures = [];

  for (const phase of phases) {
    try {
      const { detail } = await phase.run();
      console.log(`  PASS  ${phase.name}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      const message =
        error instanceof AssertionError
          ? error.message
          : `unexpected error: ${error?.stack ?? error}`;
      console.error(`  FAIL  ${phase.name}\n        ${message.replace(/\n/g, '\n        ')}`);
      failures.push(phase.name);
    }
  }

  for (const dir of ALL_RUN_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }

  // A short settle so any lingering mcp child fully exits before the process ends.
  await sleep(100);

  if (failures.length > 0) {
    console.error(`\nONT-015 e2e: ${failures.length} phase(s) failed: ${failures.join('; ')}`);
    process.exit(1);
  }

  console.log('\nONT-015 e2e scenario: all phases passed');
  process.exit(0);
};

main().catch((error) => {
  console.error(`ONT-015 e2e: scenario crashed: ${error?.stack ?? error}`);
  process.exit(1);
});
