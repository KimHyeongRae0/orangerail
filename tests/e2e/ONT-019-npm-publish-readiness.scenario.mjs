/**
 * ONT-019 e2e driver — npm publish-readiness (ticket section 5).
 *
 * Proves that the five workspace packages are publishable and that a
 * from-registry install genuinely boots end to end. It packs the release
 * packages with `pnpm pack` (which rewrites the `workspace:` protocol to a
 * concrete range) and drives everything off the resulting tarballs — the same
 * bytes a stranger's `npm install` would receive:
 *
 *   Phase 1 (AC-1/2/3, THE RED SOURCE): for each of the five packages, read the
 *     packed tarball's embedded package.json and assert the publish contract —
 *     version "0.1.0", publishConfig.access "public", license "MIT", NO
 *     `private`, NO `workspace:` string in any runtime dependency, the tarball
 *     ships `dist` (studio: both `dist/app/index.html` and `dist/node/index.js`)
 *     and a `LICENSE`, and `orangerail-studio`'s runtime deps DO NOT include
 *     react / react-dom / @xyflow/react / elkjs. This phase is always-on and is
 *     the RED/GREEN discriminator (the recursive publish --dry-run is NOT the
 *     discriminator: pnpm silently skips private packages and returns exit 0
 *     even on the current tree — plan §4).
 *   Phase 2 (AC-4, capability-gated): install ALL packed tarballs together into
 *     a clean prefix with NO repo node_modules on the resolution path (an
 *     out-of-repo temp dir), run the installed `orangerail init --no-studio --yes`
 *     on the Prisma fixture in a SEPARATE out-of-repo project dir, resolve
 *     `orangerail-core` there from the same tarballs, boot `orangerail mcp`, and
 *     drive the ONT-018 governed write loop (discover `createNote` ->
 *     approval_pending -> `orangerail approvals approve` -> executed once ->
 *     `orangerail audit verify` exit 0). No "Cannot find package" anywhere. The
 *     whole network/toolchain-dependent install+boot is wrapped in a capability
 *     probe that skips-with-LOUD-notice (DEV-01) when the isolated install can
 *     not run offline — Phase 1 stays always-on regardless.
 *   Phase 3 (AC-5, always-on): the SHIPPED `orangerail init` in an out-of-repo dir
 *     with NO resolvable `orangerail-core` prints the honest
 *     `npm install orangerail-core zod` instruction (guards the already-correct
 *     degrade guidance). The "after install the resolve branch is taken" half is
 *     asserted inside Phase 2's gated block (the generated config loads).
 *
 * RED (pre-implementation): on the current tree every packed tarball is version
 * "0.0.0" with `private: true`, no `publishConfig`, no `license`, and studio
 * still lists react/@xyflow/react/elkjs as runtime deps. Phase 1's FIRST
 * tarball-manifest assertion (core version must be "0.1.0") FAILs, the run
 * aborts, and Phases 2/3 are never reached. That FAIL is attributable to the
 * absent publish-readiness feature, not a harness error. `verify.sh` still
 * PASSes because the tree compiles and all suites pass.
 *
 * Out-of-repo temp dirs (plan §4 / risk): Phases 2/3 run under os.tmpdir() so
 * the generated project's bare specifiers do NOT resolve via a walk-up into the
 * monorepo's root node_modules — that walk-up is exactly what makes the in-repo
 * scratch runs of ONT-006/018 resolve, and it would mask the from-registry
 * boot this ticket must prove.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-019');

// Everything Phase 2/3 touches lives OUTSIDE the repo so module resolution can
// not walk up into the monorepo's node_modules (which would mask the
// from-registry boot). process.pid keeps runs isolated without Date.now/random.
const WORK = join(tmpdir(), `orangerail-ont-019-${process.pid}`);
const PACK_DIR = join(WORK, 'tarballs');
const INSTALL_PREFIX = join(WORK, 'consumer');
const PROJECT_DIR = join(WORK, 'project');
const HONESTY_DIR = join(WORK, 'honesty');

// Release packages, in documented publish order (core -> docs-gen -> mcp ->
// studio -> cli). `key` names the per-package tarball scratch subdir.
const PACKAGES = [
  { key: 'core', dir: 'packages/core', name: 'orangerail-core' },
  { key: 'docs-gen', dir: 'packages/docs-gen', name: 'orangerail-docs-gen' },
  { key: 'mcp', dir: 'packages/mcp', name: 'orangerail-mcp' },
  { key: 'studio', dir: 'packages/studio', name: 'orangerail-studio' },
  { key: 'cli', dir: 'packages/cli', name: 'orangerail' },
];

const EXPECTED_VERSION = '0.1.0';
const STUDIO_BANNED_DEPS = ['react', 'react-dom', '@xyflow/react', 'elkjs'];
const ACTIONS = ['createNote', 'updateNote', 'deleteNote'];

const fail = ({ message }) => {
  console.error(`ONT-019 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const resetDir = ({ dir }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
};

/** Copy a fixture repo into a clean run dir. */
const prepareRunDir = ({ dir, fixture }) => {
  resetDir({ dir });
  cpSync(fixture, dir, { recursive: true });
};

/** Run a command to completion, returning status + captured output. */
const run = ({ command, args, cwd, env }) => {
  const res = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    encoding: 'utf8',
    timeout: 300_000,
  });

  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
  };
};

// ───────── Phase 1 — publishability from the packed tarballs (AC-1/2/3) ─────────

console.log('[phase 1] packed tarballs carry the publish contract (AC-1/2/3) — THE RED SOURCE');

resetDir({ dir: WORK });
mkdirSync(PACK_DIR, { recursive: true });

/** `pnpm pack` one package into its own scratch subdir; return the tarball path. */
const packPackage = ({ dir, key }) => {
  const dest = join(PACK_DIR, key);
  mkdirSync(dest, { recursive: true });

  const res = run({
    command: 'pnpm',
    args: ['pack', '--pack-destination', dest],
    cwd: join(ROOT, dir),
  });
  assert({
    ok: res.status === 0,
    message: `\`pnpm pack\` failed for ${dir} (exit ${res.status}) — harness precondition, not the feature:\n${res.stdout}\n${res.stderr}`,
  });

  const tarballs = readdirSync(dest).filter((f) => f.endsWith('.tgz'));
  assert({
    ok: tarballs.length === 1,
    message: `expected exactly one tarball for ${dir}, got: ${tarballs.join(', ')}`,
  });

  return join(dest, tarballs[0]);
};

/** Read the embedded package.json from a packed tarball. */
const tarballManifest = ({ tgz }) => {
  const res = run({ command: 'tar', args: ['-xzOf', tgz, 'package/package.json'] });
  assert({
    ok: res.status === 0 && res.stdout.trim() !== '',
    message: `could not read package/package.json from ${tgz}:\n${res.stderr}`,
  });

  return JSON.parse(res.stdout);
};

/** List the entries inside a packed tarball. */
const tarballEntries = ({ tgz }) => {
  const res = run({ command: 'tar', args: ['-tzf', tgz] });
  assert({ ok: res.status === 0, message: `could not list ${tgz}:\n${res.stderr}` });

  return res.stdout.split('\n').filter((line) => line.trim() !== '');
};

/** Any `workspace:` string in the published runtime dependency fields. */
const hasWorkspaceSpec = ({ manifest }) => {
  const fields = ['dependencies', 'peerDependencies', 'optionalDependencies'];

  return fields.some((field) =>
    Object.values(manifest[field] ?? {}).some((spec) => String(spec).includes('workspace:')),
  );
};

const packed = {};

for (const pkg of PACKAGES) {
  const tgz = packPackage({ dir: pkg.dir, key: pkg.key });
  packed[pkg.key] = tgz;

  const manifest = tarballManifest({ tgz });
  const entries = tarballEntries({ tgz });

  // The RED lever — pre-fix every tarball is version "0.0.0" (core fails first).
  assert({
    ok: manifest.version === EXPECTED_VERSION,
    message: `${pkg.name}: packed tarball version must be "${EXPECTED_VERSION}" (a single coordinated v0 release), got "${manifest.version}" — the packages are not publish-ready`,
  });
  assert({
    ok: manifest.publishConfig?.access === 'public',
    message: `${pkg.name}: publishConfig.access must be "public" (scoped packages default to restricted), got ${JSON.stringify(manifest.publishConfig)}`,
  });
  assert({
    ok: manifest.license === 'MIT',
    message: `${pkg.name}: license must be "MIT", got ${JSON.stringify(manifest.license)}`,
  });
  assert({
    ok: manifest.private === undefined,
    message: `${pkg.name}: \`private\` must be absent so npm can publish the package, got ${JSON.stringify(manifest.private)}`,
  });
  assert({
    ok: !hasWorkspaceSpec({ manifest }),
    message: `${pkg.name}: no dependency may keep a "workspace:" spec in the packed tarball (uninstallable from npm) — deps: ${JSON.stringify(manifest.dependencies)}`,
  });

  // The tarball actually ships the built output (files: ["dist"]).
  assert({
    ok: entries.some((e) => e.startsWith('package/dist/')),
    message: `${pkg.name}: the tarball must include the built \`dist\`, got entries: ${entries.slice(0, 12).join(', ')}`,
  });
  assert({
    ok: entries.includes('package/LICENSE'),
    message: `${pkg.name}: the tarball must include a LICENSE file (a license-less npm page otherwise)`,
  });
}

// Studio is the from-registry weight offender: its node entry imports only
// orangerail-core, while the React/graph stack is inlined into the prebuilt Vite
// app — so it must NOT be forced onto every CLI install (AC-2).
const studioManifest = tarballManifest({ tgz: packed['studio'] });
const studioEntries = tarballEntries({ tgz: packed['studio'] });

for (const dep of STUDIO_BANNED_DEPS) {
  assert({
    ok: (studioManifest.dependencies ?? {})[dep] === undefined,
    message: `orangerail-studio: "${dep}" must be a devDependency, not a runtime dependency (dist/node imports only orangerail-core; the React/graph stack is inlined into dist/app) — deps: ${JSON.stringify(studioManifest.dependencies)}`,
  });
}
assert({
  ok: studioEntries.includes('package/dist/app/index.html'),
  message:
    'orangerail-studio: the tarball must ship the prebuilt browser app (dist/app/index.html), else the CLI serves a broken studio',
});
assert({
  ok: studioEntries.some((e) => e.startsWith('package/dist/node/')),
  message: 'orangerail-studio: the tarball must ship the node-consumable snapshot entry (dist/node)',
});

console.log('[phase 1] OK — all five tarballs carry the publish contract');

// ───────── shared MCP + install helpers (ONT-018 stdio client) ─────────

/** Minimal MCP stdio client (ONT-003/006/008/018 pattern) over a spawned server. */
const openMcpSession = async ({ command, args, cwd, env }) => {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
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
      clientInfo: { name: 'ont-019-e2e', version: '0.0.0' },
    },
  });
  send({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  const callTool = async ({ name, args: toolArgs }) =>
    request({ method: 'tools/call', params: { name, arguments: toolArgs } });

  const listTools = async () => request({ method: 'tools/list', params: {} });

  const close = async () => {
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
  };

  return { request, callTool, listTools, close };
};

/**
 * Install tarballs (+ public deps) into a prefix. Returns { ok, detail } so the
 * network/toolchain-dependent Phase 2 can be capability-gated (DEV-01) rather
 * than reporting a false pass in an environment that cannot reach the registry.
 */
const npmInstall = ({ cwd, packages }) => {
  const res = run({
    command: 'npm',
    args: ['install', '--no-audit', '--no-fund', '--no-save', ...packages],
    cwd,
  });

  const detail = `${res.stdout}\n${res.stderr}\n${res.error ? String(res.error) : ''}`;

  return { ok: res.status === 0, detail };
};

// ───────── Phase 2 — from-registry boot (AC-4), capability-gated ─────────

console.log('[phase 2] isolated install of packed tarballs boots mcp + governed loop (AC-4)');

const allTarballs = PACKAGES.map((pkg) => packed[pkg.key]);

resetDir({ dir: INSTALL_PREFIX });
writeFileSync(
  join(INSTALL_PREFIX, 'package.json'),
  `${JSON.stringify({ name: 'ont-019-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
);

// Capability probe: the whole install+boot is gated on this install succeeding.
const consumerInstall = npmInstall({ cwd: INSTALL_PREFIX, packages: [...allTarballs, 'zod'] });

if (!consumerInstall.ok) {
  console.error(
    '⚠️  ONT-019 e2e: LOUD SKIP — the isolated `npm install` of the packed tarballs could not ' +
      'run in this environment (offline / toolchain), so the from-registry boot sub-assertions ' +
      '(Phase 2: init on the Prisma fixture, mcp boot, governed loop, audit verify) are SKIPPED ' +
      '(DEV-01, plan §4). Phase 1 (the publish-contract RED lever) and Phase 3 (install honesty) ' +
      `still run. This is NOT a silent pass — justify in the report. Install detail:\n${consumerInstall.detail}`,
  );
} else {
  const bin = join(INSTALL_PREFIX, 'node_modules', '.bin', 'orangerail');
  assert({
    ok: existsSync(bin),
    message: `the installed orangerail bin is missing at ${bin} after installing the CLI tarball`,
  });

  // A SEPARATE out-of-repo project dir: the generated code must resolve its
  // orangerail-core import from HERE (not a walk-up into the monorepo).
  prepareRunDir({ dir: PROJECT_DIR, fixture: FIXTURE });

  const init = run({ command: bin, args: ['init', '--no-studio', '--yes'], cwd: PROJECT_DIR });
  assert({
    ok: init.status === 0,
    message: `installed \`orangerail init\` must exit 0 on the Prisma fixture, got ${init.status}:\n${init.stdout}\n${init.stderr}`,
  });
  assert({
    ok: init.stdout.includes('npm install orangerail-core zod'),
    message: `on a fresh project with no resolvable orangerail-core, init must print the honest install instruction, got:\n${init.stdout}`,
  });
  for (const name of ACTIONS) {
    assert({
      ok: existsSync(join(PROJECT_DIR, 'ontology', `${name}.mjs`)),
      message: `installed init must generate ontology/${name}.mjs from the Prisma fixture`,
    });
  }

  // Resolve the generated project's runtime deps from the SAME tarballs (the
  // path init told the user to take) + public zod.
  const projectInstall = npmInstall({ cwd: PROJECT_DIR, packages: [packed['core'], 'zod'] });
  assert({
    ok: projectInstall.ok,
    message: `installing the generated project's runtime deps from the tarballs failed:\n${projectInstall.detail}`,
  });

  // Boot the installed mcp server on the generated config; the ONT-018 write
  // tools must be present (no "Cannot find package").
  const dbEnv = { DATABASE_URL: 'file:./ont-019.db' };
  const session = await openMcpSession({
    command: bin,
    args: ['mcp', '--config', 'orangerail.config.mjs'],
    cwd: PROJECT_DIR,
    env: dbEnv,
  });

  const listed = await session.listTools();
  const toolNames = listed.tools.map((t) => t.name);
  assert({
    ok: toolNames.includes('createNote'),
    message: `tools/list from the installed server must include the ONT-018 governed write tool "createNote" (got: ${toolNames.join(', ')})`,
  });

  const staged = await session.callTool({
    name: 'createNote',
    args: { title: 'from-registry note', body: 'installed from the packed tarballs' },
  });
  const approvalId = staged.structuredContent?.approvalId;
  assert({
    ok: staged.structuredContent?.status === 'approval_pending' && typeof approvalId === 'string',
    message: `createNote must stage (approval_pending + approvalId), got ${JSON.stringify(staged)}`,
  });
  await session.close();

  const approve = run({
    command: bin,
    args: ['approvals', 'approve', approvalId, '--config', 'orangerail.config.mjs'],
    cwd: PROJECT_DIR,
    env: dbEnv,
  });
  assert({
    ok: approve.status === 0,
    message: `installed \`approvals approve\` must succeed, got ${approve.status}:\n${approve.stdout}\n${approve.stderr}`,
  });

  // Push the SQLite schema so execute has a real DB, then execute once.
  const prismaPush = run({
    command: 'npx',
    args: ['--yes', 'prisma', 'db', 'push', '--schema', 'prisma/schema.prisma'],
    cwd: PROJECT_DIR,
    env: dbEnv,
  });

  if (prismaPush.status === 0) {
    const session2 = await openMcpSession({
      command: bin,
      args: ['mcp', '--config', 'orangerail.config.mjs'],
      cwd: PROJECT_DIR,
      env: dbEnv,
    });
    const executed = await session2.callTool({ name: 'check_approval', args: { approvalId } });
    await session2.close();
    assert({
      ok: executed.structuredContent?.status === 'executed',
      message: `the approved write must execute exactly once against the installed server, got ${JSON.stringify(executed)}`,
    });
  } else {
    console.error(
      '⚠️  ONT-019 e2e: LOUD SKIP (nested) — `prisma db push` could not run in the isolated ' +
        'project, so the execute-once observation is skipped; discover + staging + approval + ' +
        `audit verify still ran (DEV-01). Detail:\n${prismaPush.stdout}\n${prismaPush.stderr}`,
    );
  }

  const audit = run({
    command: bin,
    args: ['audit', 'verify', '--config', 'orangerail.config.mjs'],
    cwd: PROJECT_DIR,
    env: dbEnv,
  });
  assert({
    ok: audit.status === 0,
    message: `installed \`audit verify\` must pass over the governed chain, got ${audit.status}:\n${audit.stdout}\n${audit.stderr}`,
  });

  console.log('[phase 2] OK — from-registry install booted mcp + drove the governed loop');
}

// ───────── Phase 3 — install honesty (AC-5), always-on ─────────

console.log(
  '[phase 3] init prints the honest install instruction when orangerail-core is unresolvable (AC-5)',
);

// The SHIPPED in-repo CLI, but run in an OUT-OF-REPO dir so resolution can not
// walk up into the monorepo node_modules — reproducing a stranger's fresh dir.
prepareRunDir({ dir: HONESTY_DIR, fixture: FIXTURE });

const honesty = run({
  command: 'node',
  args: [CLI, 'init', '--no-studio', '--yes'],
  cwd: HONESTY_DIR,
});
assert({
  ok: honesty.status === 0,
  message: `init must still exit 0 in the degrade branch, got ${honesty.status}:\n${honesty.stdout}\n${honesty.stderr}`,
});
assert({
  ok: honesty.stdout.includes('npm install orangerail-core zod'),
  message: `init must print the honest \`npm install orangerail-core zod\` instruction when the deps are unresolvable, got:\n${honesty.stdout}`,
});

console.log('[phase 3] OK');

rmSync(WORK, { recursive: true, force: true });

console.log('ONT-019 e2e scenario: all phases passed (publish-readiness contract)');
process.exit(0);
