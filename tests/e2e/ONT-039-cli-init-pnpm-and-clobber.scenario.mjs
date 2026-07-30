/**
 * ONT-039 e2e driver — `orangerail init` under pnpm, and the clobber guard
 * (ticket section 5).
 *
 * Everything runs OUTSIDE the repo, under os.tmpdir(), so bare specifiers in
 * the generated project cannot resolve by walking up into the monorepo's
 * node_modules — that walk-up is exactly what masks this bug in the in-repo
 * scratch runs of ONT-006.
 *
 *   Phase 1 (AC-1, always-on): the shipped bin under a hand-exported NODE_PATH.
 *     pnpm's bin shim does one thing that matters here — it exports NODE_PATH at
 *     `.pnpm/node_modules`. CJS resolution honors it, the ESM loader does not, so
 *     the old CJS probe answered "these deps resolve" for a package `import()`
 *     could not see and `init` aborted with ERR_MODULE_NOT_FOUND and zero files
 *     written. Reproduced here with a plain `node` run, no package manager
 *     needed, so the phase is deterministic and offline.
 *   Phase 2 (AC-1, capability-gated): the same thing for real — `pnpm pack` the
 *     CLI, `pnpm add` the tarball into a scratch project, run
 *     `./node_modules/.bin/orangerail init` through pnpm's own shim. Gated on
 *     the install succeeding (it needs the registry for the CLI's own deps);
 *     skips with a LOUD notice (DEV-01) rather than failing offline.
 *   Phase 3 (AC-5, always-on): the clobber guard. Init once, hand-edit a
 *     generated ontology file, rename the config to the documented
 *     `orangerail.config.ts`, re-run. The refusal must name the promise, the run
 *     must exit non-zero, the hand-written line must survive byte-for-byte, and
 *     no second `orangerail.config.mjs` may appear to shadow the `.ts`.
 *   Phase 4 (AC-5, always-on): the same guard with no TypeScript involved —
 *     config deleted, `ontology/` kept.
 *
 * RED (pre-implementation): Phase 1 fails first — the shipped bin exits 1 with
 * "Cannot find package 'orangerail-core'" and writes nothing, instead of taking
 * the degrade branch. With Phase 1 removed, Phase 3 then fails: the re-run exits
 * 0 and the hand-written line is gone.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-039');

// process.pid keeps concurrent runs isolated without Date.now/random.
const WORK = join(tmpdir(), `orangerail-ont-039-${process.pid}`);

const HAND_WRITTEN = '\n// === HAND-WRITTEN BUSINESS RULE, 3 hours of work ===\n';
const INIT_ARGS = ['init', '--yes', '--no-studio', '--no-docs'];

const fail = ({ message }) => {
  console.error(`ONT-039 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const run = ({ command, args, cwd, env }) => {
  const res = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    encoding: 'utf8',
    timeout: 300_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** A clean out-of-repo copy of the Prisma fixture. */
const prepareProject = ({ name }) => {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });

  return dir;
};

/** Every generated path under a project dir, sorted, for a wrote-nothing check. */
const generatedPaths = ({ dir }) =>
  readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.mjs') || entry.endsWith('.ts'))
    .sort();

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ───────── Phase 1 — NODE_PATH must not fool the dependency probe (AC-1) ─────────

console.log('[phase 1] NODE_PATH does not fool the probe (AC-1) — THE RED SOURCE');

{
  const project = prepareProject({ name: 'node-path' });

  // A directory that CJS resolution can see through NODE_PATH and the ESM loader
  // cannot — the whole of what pnpm's bin shim adds to the environment.
  const hidden = join(WORK, 'hidden-modules');
  for (const name of ['orangerail-core', 'zod']) {
    const packageDir = join(hidden, name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name, version: '0.0.0', main: 'index.cjs' }),
      'utf8',
    );
    writeFileSync(join(packageDir, 'index.cjs'), 'module.exports = {};\n', 'utf8');
  }

  const res = run({
    command: process.execPath,
    args: [CLI, ...INIT_ARGS],
    cwd: project,
    env: { NODE_PATH: hidden },
  });

  assert({
    ok: res.status === 0,
    message: `init under NODE_PATH must exit 0 (degrade branch), got ${res.status}:\n${res.stdout}\n${res.stderr}`,
  });
  assert({
    ok: !`${res.stdout}${res.stderr}`.includes('Cannot find package'),
    message: `init under NODE_PATH must not surface a loader error:\n${res.stdout}\n${res.stderr}`,
  });
  assert({
    ok: res.stdout.includes('npm install orangerail-core zod'),
    message: `init under NODE_PATH must state the install next step:\n${res.stdout}`,
  });
  assert({
    ok: existsSync(join(project, 'orangerail.config.mjs')),
    message: 'init under NODE_PATH must still write orangerail.config.mjs',
  });
  assert({
    ok: existsSync(join(project, 'ontology', 'Article.mjs')),
    message: `init under NODE_PATH must still write the ontology, got: ${generatedPaths({ dir: project }).join(', ')}`,
  });
  assert({
    ok: !existsSync(join(project, '.orangerail')),
    message: 'the staging dir must not survive the degrade branch',
  });
}

console.log('  ✓ degrade branch taken, full file set written, exit 0');

// ───────── Phase 2 — the same thing through a real pnpm install (AC-1) ─────────

console.log('[phase 2] the shipped tarball under a real `pnpm add` + pnpm bin shim (AC-1)');

{
  const packDir = join(WORK, 'tarball');
  mkdirSync(packDir, { recursive: true });

  // Pack the CLI **and every workspace package it depends on**, then pin those
  // names with `pnpm.overrides`.
  //
  // Without the pin, `pnpm add <cli.tgz>` resolves `orangerail-core` and friends
  // from the REGISTRY at whatever was last published, so this phase quietly ran
  // a freshly built CLI against a stale core. Any unreleased cross-package
  // change then failed here with an ESM link error that says nothing about
  // NODE_PATH — which is the only thing this phase exists to test. The five
  // packages are versioned and released together (CHANGELOG), so testing the
  // shipped tarball against its sibling tarballs is also the honest simulation
  // of what a user installs.
  const workspacePackages = ['core', 'mcp', 'docs-gen', 'studio'];
  const packOne = ({ dir }) =>
    run({ command: 'pnpm', args: ['pack', '--pack-destination', packDir], cwd: dir });

  const packed = packOne({ dir: join(ROOT, 'packages', 'cli') });
  const siblings = workspacePackages.map((name) => ({
    name,
    result: packOne({ dir: join(ROOT, 'packages', name) }),
  }));
  const failedSibling = siblings.find((entry) => entry.result.status !== 0);

  if (packed.status !== 0 || failedSibling !== undefined) {
    console.warn(
      '  ⚠️  SKIPPED (DEV-01): `pnpm pack` failed — phase 1 already covers the mechanism',
    );
    console.warn(`     ${(failedSibling?.result ?? packed).stderr.trim()}`);
  } else {
    const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
    const cliTarball = tarballs.find((f) => /^orangerail-\d/.test(f));
    assert({
      ok: cliTarball !== undefined && tarballs.length === workspacePackages.length + 1,
      message: `expected one tarball per workspace package, got: ${tarballs.join(', ')}`,
    });

    const project = prepareProject({ name: 'pnpm' });
    const manifestPath = join(project, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const overrides = {};
    for (const tarball of tarballs) {
      if (tarball === cliTarball) {
        continue;
      }

      // `orangerail-core-0.1.0.tgz` -> `orangerail-core`
      overrides[tarball.replace(/-\d[^-]*\.tgz$/, '')] = `file:${join(packDir, tarball)}`;
    }
    manifest.pnpm = { ...(manifest.pnpm ?? {}), overrides };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const added = run({
      command: 'pnpm',
      args: ['add', join(packDir, cliTarball)],
      cwd: project,
    });

    if (added.status !== 0) {
      console.warn(
        '  ⚠️  SKIPPED (DEV-01): `pnpm add` of the tarball failed (registry unreachable?)',
      );
      console.warn(`     ${added.stderr.trim()}`);
    } else {
      const shim = join(project, 'node_modules', '.bin', 'orangerail');
      assert({
        ok: existsSync(shim),
        message: 'pnpm did not link a node_modules/.bin/orangerail shim',
      });
      assert({
        ok: readFileSync(shim, 'utf8').includes('NODE_PATH'),
        message:
          'the pnpm shim no longer exports NODE_PATH — this phase would no longer test anything',
      });

      const res = run({ command: shim, args: INIT_ARGS, cwd: project });

      assert({
        ok: res.status === 0,
        message: `pnpm-installed init must exit 0, got ${res.status}:\n${res.stdout}\n${res.stderr}`,
      });
      assert({
        ok: !`${res.stdout}${res.stderr}`.includes('Cannot find package'),
        message: `pnpm-installed init must not surface a loader error:\n${res.stdout}\n${res.stderr}`,
      });
      assert({
        ok: existsSync(join(project, 'ontology', 'Article.mjs')),
        message: 'pnpm-installed init must write the ontology',
      });

      console.log('  ✓ `pnpm add` + bin shim: exit 0, ontology written');
    }
  }
}

// ───────── Phase 3 — a renamed config never costs the user their ontology (AC-5) ─────────

console.log('[phase 3] hand-edited ontology + `orangerail.config.ts` re-run refuses (AC-5)');

{
  const project = prepareProject({ name: 'clobber-ts' });

  const first = run({ command: process.execPath, args: [CLI, ...INIT_ARGS], cwd: project });
  assert({
    ok: first.status === 0,
    message: `the first init must succeed, got ${first.status}:\n${first.stdout}\n${first.stderr}`,
  });

  const edited = join(project, 'ontology', 'Article.mjs');
  appendFileSync(edited, HAND_WRITTEN, 'utf8');
  const before = readFileSync(edited, 'utf8');

  renameSync(join(project, 'orangerail.config.mjs'), join(project, 'orangerail.config.ts'));

  const second = run({ command: process.execPath, args: [CLI, ...INIT_ARGS], cwd: project });

  assert({
    ok: second.status !== 0,
    message: `the re-run must refuse (non-zero), got ${second.status}:\n${second.stdout}\n${second.stderr}`,
  });
  assert({
    ok: second.stderr.includes('init never overwrites your ontology'),
    message: `the refusal must repeat the promise, got:\n${second.stdout}\n${second.stderr}`,
  });
  assert({
    ok: readFileSync(edited, 'utf8') === before,
    message: 'the hand-written business rule must survive byte-for-byte',
  });
  assert({
    ok: !existsSync(join(project, 'orangerail.config.mjs')),
    message: 'no second config may appear to shadow the hand-kept orangerail.config.ts',
  });
}

console.log('  ✓ refused, hand-written line intact, no shadowing config');

// ───────── Phase 4 — the same guard with the config simply gone (AC-5) ─────────

console.log('[phase 4] no config at all, populated ontology/ — still refuses (AC-5)');

{
  const project = prepareProject({ name: 'clobber-bare' });

  const first = run({ command: process.execPath, args: [CLI, ...INIT_ARGS], cwd: project });
  assert({ ok: first.status === 0, message: `the first init must succeed, got ${first.status}` });

  const edited = join(project, 'ontology', 'Article.mjs');
  appendFileSync(edited, HAND_WRITTEN, 'utf8');
  const before = readFileSync(edited, 'utf8');

  rmSync(join(project, 'orangerail.config.mjs'));

  const second = run({ command: process.execPath, args: [CLI, ...INIT_ARGS], cwd: project });

  assert({
    ok: second.status !== 0,
    message: `the re-run must refuse (non-zero), got ${second.status}:\n${second.stdout}\n${second.stderr}`,
  });
  assert({
    ok: second.stderr.includes('ontology/Article.mjs'),
    message: `the refusal must name the colliding file, got:\n${second.stderr}`,
  });
  assert({
    ok: readFileSync(edited, 'utf8') === before,
    message: 'the hand-written business rule must survive byte-for-byte',
  });
  assert({
    ok: !existsSync(join(project, 'orangerail.config.mjs')),
    message: 'a refused init must write nothing at all',
  });
}

console.log('  ✓ refused, named the file, wrote nothing');

rmSync(WORK, { recursive: true, force: true });

console.log('ONT-039 e2e: all phases passed');
