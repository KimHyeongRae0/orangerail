/**
 * ONT-008 e2e driver — scanner honesty + runtime diagnostics (ticket section 5).
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) against three copied
 * fixture repos and proves the four honesty / diagnostics gaps are closed while
 * root-only repos stay byte-identical:
 *
 *   Phase 1 (AC-1, RUN monorepo): `orangerail init --no-studio --yes` at a
 *     monorepo ROOT exits 0 and generates the models declared in the NESTED
 *     schema (packages/db/prisma/schema.prisma) — User + Post ontology files.
 *   Phase 2 (AC-2, RUN monorepo): the init output carries exactly ONE aggregated
 *     view-skip warning naming the fixture view (UserStats) and saying views are
 *     not scanned; init never crashes.
 *   Phase 3 (AC-1 edge, RUN both): with a root schema AND a nested schema, ALL
 *     hits are scanned (root first) — RootWidget (root) and NestedGadget
 *     (nested) ontology files both exist.
 *   Phase 4 (AC-3, MCP on RUN monorepo): booting `orangerail mcp` WITHOUT a
 *     generated Prisma client and calling a generated read tool returns an
 *     ACTIONABLE diagnostic — the error names the object, `@prisma/client`,
 *     `prisma generate`, and DATABASE_URL, not a raw module-resolution error.
 *   Phase 5 (AC-4, RUN monorepo): the generated .orangerail/generated/AGENTS.md
 *     governed-actions section explains the not-implemented stub path (rejected
 *     before staging).
 *   Phase 6 (AC-5, RUN root A/B): two fresh inits of the ONT-006-shaped
 *     root-only fixture produce byte-identical output — the detection change
 *     leaves root-only repos untouched.
 *
 * RED (pre-implementation): root-only detection never finds the monorepo's
 * nested schema, so Phase 1's model-file assertions FAIL (init still exits 0);
 * the view warning is absent (Phase 2); the no-client read-tool call surfaces
 * the raw `Cannot find module` text without the object name or `prisma generate`
 * (Phase 4); and the AGENTS.md governed section lacks the stub-path wording
 * (Phase 5). Phase 6's determinism holds today, so the RED FAIL comes from
 * Phases 1/2/3/4/5 (Phase 1 gates first).
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-008');
const MONOREPO_FIXTURE = join(FIXTURES, 'monorepo');
const BOTH_FIXTURE = join(FIXTURES, 'both');
const ROOT_FIXTURE = join(FIXTURES, 'root');
const SCRATCH = join(ROOT, '.docs', 'scratch');
const RUN_MONOREPO = join(SCRATCH, 'ont-008-run-monorepo');
const RUN_BOTH = join(SCRATCH, 'ont-008-run-both');
const RUN_ROOT_A = join(SCRATCH, 'ont-008-run-root-a');
const RUN_ROOT_B = join(SCRATCH, 'ont-008-run-root-b');

const fail = ({ message }) => {
  console.error(`ONT-008 e2e FAIL: ${message}`);
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

/** Absolute path of a generated `ontology/<name>` file. */
const ontologyPath = ({ runDir, name }) => join(runDir, 'ontology', name);

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

/** Minimal MCP stdio client (ONT-006/007 pattern) over the generated config. */
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
      clientInfo: { name: 'ont-008-e2e', version: '0.0.0' },
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

// ─────────── phase 1 — monorepo: nested schema detected + generated ───────────

console.log('[phase 1] monorepo root init detects the nested packages/db schema (AC-1)');

prepareRunDir({ dir: RUN_MONOREPO, fixture: MONOREPO_FIXTURE });

const monorepoInit = runCli({ args: ['init', '--no-studio', '--yes'], cwd: RUN_MONOREPO });

assert({
  ok: monorepoInit.status === 0,
  message: `monorepo init must exit 0, got ${monorepoInit.status}:\n${monorepoInit.stdout}\n${monorepoInit.stderr}`,
});

const monorepoOutput = `${monorepoInit.stdout}\n${monorepoInit.stderr}`;

for (const model of ['User', 'Post']) {
  assert({
    ok: existsSync(ontologyPath({ runDir: RUN_MONOREPO, name: `${model}.mjs` })),
    message: `expected ontology/${model}.mjs generated from the nested packages/db/prisma/schema.prisma — root-only detection never found it`,
  });
}

console.log('[phase 1] OK');

// ──────────── phase 2 — monorepo: aggregated view-skip warning (AC-2) ─────────

console.log('[phase 2] one aggregated view-skip warning names the fixture view (AC-2)');

const viewWarnings = monorepoOutput
  .split('\n')
  .filter((line) => /view/i.test(line) && line.includes('UserStats'));

assert({
  ok: viewWarnings.length === 1,
  message: `expected exactly ONE aggregated view warning naming UserStats, got ${viewWarnings.length}:\n${monorepoOutput}`,
});
assert({
  ok: /not scanned/i.test(viewWarnings[0]),
  message: `the view warning must say views are not scanned in v0 — got: ${viewWarnings[0]}`,
});

console.log('[phase 2] OK');

// ──────── phase 3 — both: all hits scanned, root first (§4 precedence) ────────

console.log('[phase 3] both root + nested schemas are scanned, all hits (§4 edge case)');

prepareRunDir({ dir: RUN_BOTH, fixture: BOTH_FIXTURE });

const bothInit = runCli({ args: ['init', '--no-studio', '--yes'], cwd: RUN_BOTH });
assert({
  ok: bothInit.status === 0,
  message: `both-schema init must exit 0, got ${bothInit.status}:\n${bothInit.stdout}\n${bothInit.stderr}`,
});

assert({
  ok: existsSync(ontologyPath({ runDir: RUN_BOTH, name: 'RootWidget.mjs' })),
  message: 'expected ontology/RootWidget.mjs from the ROOT schema',
});
assert({
  ok: existsSync(ontologyPath({ runDir: RUN_BOTH, name: 'NestedGadget.mjs' })),
  message:
    'expected ontology/NestedGadget.mjs from the NESTED schema — a root schema must not suppress nested hits (all scanned, root first)',
});

console.log('[phase 3] OK');

// ──────── phase 4 — MCP read tool without a Prisma client: diagnostic ─────────

console.log('[phase 4] read tool with no Prisma client returns the actionable diagnostic (AC-3)');

const session = await openMcpSession({ cwd: RUN_MONOREPO });
const toolsResult = await session.request({ method: 'tools/list', params: {} });
const toolNames = toolsResult.tools.map((t) => t.name);

assert({
  ok: toolNames.includes('Post_list'),
  message: `tools/list missing the generated read tool Post_list (got: ${toolNames.join(', ')})`,
});

let callError;
try {
  await session.request({ method: 'tools/call', params: { name: 'Post_list', arguments: {} } });
} catch (err) {
  callError = err;
}
await session.close();

assert({
  ok: callError !== undefined,
  message: 'calling Post_list without a generated Prisma client must surface an error',
});

const errText = callError?.message ?? '';
for (const needle of ['Post', '@prisma/client', 'prisma generate', 'DATABASE_URL']) {
  assert({
    ok: errText.includes(needle),
    message: `resolve diagnostic must name "${needle}" (the raw module error is a detail, not the headline) — got:\n${errText}`,
  });
}

console.log('[phase 4] OK');

// ──────────── phase 5 — AGENTS.md governed-actions stub wording (AC-4) ────────

console.log('[phase 5] generated AGENTS.md documents the not-implemented stub path (AC-4)');

const agentsMdPath = join(RUN_MONOREPO, '.orangerail', 'generated', 'AGENTS.md');
assert({
  ok: existsSync(agentsMdPath),
  message: '.orangerail/generated/AGENTS.md was not generated',
});

const agentsMd = readFileSync(agentsMdPath, 'utf8');
assert({
  ok: /not.implemented/i.test(agentsMd),
  message: 'AGENTS.md governed-actions section must mention the not-implemented stub path',
});
assert({
  ok: /before staging|rejected before/i.test(agentsMd),
  message:
    'AGENTS.md governed-actions section must say a not-implemented stub is rejected BEFORE staging (§3.7 truthfulness)',
});

console.log('[phase 5] OK');

// ──────────── phase 6 — root-only fixture byte-identity (AC-5) ────────────────

console.log('[phase 6] root-only init is byte-identical across two fresh runs (AC-5)');

for (const dir of [RUN_ROOT_A, RUN_ROOT_B]) {
  prepareRunDir({ dir, fixture: ROOT_FIXTURE });
  const res = runCli({ args: ['init', '--no-studio', '--yes'], cwd: dir });
  assert({
    ok: res.status === 0,
    message: `root-only init in ${dir} failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
  });
}

for (const rel of ['ontology', '.orangerail/generated']) {
  const a = snapshotDir({ dir: join(RUN_ROOT_A, rel) });
  const b = snapshotDir({ dir: join(RUN_ROOT_B, rel) });
  assert({
    ok: a.size === b.size && [...a].every(([k, v]) => b.get(k) === v),
    message: `generated ${rel}/ differs between two identical root-only runs — detection change disturbed a root-only repo`,
  });
}

console.log('[phase 6] OK');

console.log('ONT-008 e2e scenario: all phases passed');
process.exit(0);
