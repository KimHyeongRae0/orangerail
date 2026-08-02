/**
 * ONT-077 e2e driver — `--yes` scaffolds and returns; `--studio` still serves.
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) over the ont-056 Prisma /
 * SQLite fixture. The defect is a property of the PROCESS, not of a string, so
 * every phase here is about whether a spawned `init` exits on its own — a
 * `spawnSync` with a timeout would report the same failure as a pass.
 *
 * Phase 1 (AC-1): `init --yes` in a scaffoldable project exits 0 unaided and
 *   never prints `serving on`. On `88b3849` it scaffolds in ~0.45s and then
 *   serves indefinitely; this phase is the RED gate.
 *
 * Phase 2 (AC-2): `init --yes --studio --no-open --port <n>` DOES serve —
 *   `/api/registry` answers — and the scenario kills it. An explicit `--studio`
 *   beats the new default, which is the half that keeps this a papercut fix
 *   rather than a removed capability.
 *
 * Phase 3 (AC-3): `init --yes` and `init --yes --no-studio` produce identical
 *   stdout and an identical generated tree, file for file, content for content.
 *   The new default is not "close to" the flag that already said this; it is it.
 *
 * No database and no browser: nothing here is about what the studio renders,
 * only about whether one was started.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-056');
const SCRATCH = join(ROOT, '.docs', 'scratch');

/** Inside the repo so the generated config resolves `orangerail-core` from the workspace. */
const RUN_YES = join(SCRATCH, 'ont-077-yes');
const RUN_STUDIO = join(SCRATCH, 'ont-077-studio');
const RUN_NO_STUDIO = join(SCRATCH, 'ont-077-no-studio');

/** Not 4820 (the default) and not 4879 (ONT-006), so a stray server cannot answer for us. */
const PORT = 4877;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Well under the seven minutes the report measured, and ~40x the 0.45s the
 * scaffolding actually takes, so a slow machine is never mistaken for a hang.
 */
const EXIT_BUDGET_MS = 20_000;

let failures = 0;

const assert = ({ ac, ok, message }) => {
  if (!ok) {
    failures += 1;
    console.error(`ASSERTION FAILED [${ac}]: ${message}`);
  }
};

const fail = ({ message }) => {
  console.error(`FATAL: ${message}`);
  process.exit(1);
};

const prepareRunDir = ({ dir }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
};

/**
 * Spawn `init` and wait for it to exit ON ITS OWN, up to `budgetMs`.
 *
 * `stdio.stdin` is `ignore` rather than inherited: the whole point of `--yes` is
 * the caller who has no terminal, and an inherited TTY would let the wizard read
 * where the real CI job cannot.
 */
const runInitDetached = ({ args, cwd, budgetMs }) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const collect = (chunk) => {
      output += chunk.toString('utf8');
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ exited: false, status: null, elapsedMs: Date.now() - started, output });
    }, budgetMs);

    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve({ exited: true, status, elapsedMs: Date.now() - started, output });
    });
  });

/** Poll a predicate until it holds or the budget runs out. */
const waitFor = async ({ label, fn, timeoutMs }) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await fn()) {
      return;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  fail({ message: `timed out waiting for ${label}` });
};

/** Every file under `dir`, as repo-relative paths, sorted — generated output only. */
const generatedTree = ({ dir }) => {
  const skip = new Set(['node_modules', '.git', 'package.json', 'prisma']);
  const out = [];

  const walk = ({ current }) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);

      if (current === dir && skip.has(entry)) {
        continue;
      }

      if (statSync(full).isDirectory()) {
        walk({ current: full });
      } else {
        out.push(relative(dir, full));
      }
    }
  };

  walk({ current: dir });

  return out.sort();
};

if (!spawnSync('node', [CLI, '--version'], { encoding: 'utf8' }).stdout) {
  fail({ message: `CLI not built at ${CLI} — run pnpm -r run build` });
}

mkdirSync(SCRATCH, { recursive: true });

// ───────── phase 1 — `--yes` scaffolds and returns (AC-1) ─────────

console.log('[phase 1] `init --yes` exits on its own and starts no server (AC-1)');

prepareRunDir({ dir: RUN_YES });

const yesRun = await runInitDetached({
  args: ['init', '--yes'],
  cwd: RUN_YES,
  budgetMs: EXIT_BUDGET_MS,
});

// The RED gate. On `88b3849` this never resolves as `exited` — the studio holds
// the event loop open until the timer kills it.
assert({
  ac: 'AC-1',
  ok: yesRun.exited,
  message: `init --yes must return on its own; still running after ${EXIT_BUDGET_MS}ms. Output:\n${yesRun.output}`,
});

assert({
  ac: 'AC-1',
  ok: yesRun.status === 0,
  message: `init --yes must exit 0, got ${yesRun.status}. Output:\n${yesRun.output}`,
});

assert({
  ac: 'AC-1',
  ok: !yesRun.output.includes('serving on'),
  message: `init --yes must not start a server. Output:\n${yesRun.output}`,
});

// Nothing is lost by not serving, because init already names the next command.
assert({
  ac: 'AC-1',
  ok: yesRun.output.includes('orangerail studio'),
  message: `init --yes must still name \`orangerail studio\` as the next step. Output:\n${yesRun.output}`,
});

console.log(`[phase 1] OK — exited ${yesRun.status} in ${yesRun.elapsedMs}ms, no server`);

// ───────── phase 2 — an explicit `--studio` still serves (AC-2) ─────────

console.log('[phase 2] `init --yes --studio` still serves (AC-2)');

prepareRunDir({ dir: RUN_STUDIO });

const studioChild = spawn(
  'node',
  [CLI, 'init', '--yes', '--studio', '--no-open', '--port', String(PORT)],
  { cwd: RUN_STUDIO, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
);

let studioOut = '';
let studioExited = false;
studioChild.stdout.on('data', (c) => {
  studioOut += c.toString('utf8');
});
studioChild.stderr.on('data', (c) => {
  studioOut += c.toString('utf8');
});
studioChild.on('exit', () => {
  studioExited = true;
});

await waitFor({
  label: 'the studio init launched to serve /api/registry',
  fn: async () => {
    if (studioExited) {
      fail({
        message: `init --yes --studio exited instead of serving — the explicit flag lost to the new default.\n${studioOut}`,
      });
    }

    const res = await fetch(`${BASE}/api/registry`).catch(() => undefined);

    return res !== undefined && res.ok;
  },
  timeoutMs: 60_000,
});

assert({
  ac: 'AC-2',
  ok: studioOut.includes('serving on'),
  message: `init --yes --studio must announce the server. Output:\n${studioOut}`,
});

studioChild.kill('SIGKILL');

console.log(`[phase 2] OK — served on ${BASE} under an explicit --studio`);

// ───────── phase 3 — the default IS `--no-studio` (AC-3) ─────────

console.log('[phase 3] `--yes` and `--yes --no-studio` are the same run (AC-3)');

prepareRunDir({ dir: RUN_NO_STUDIO });

const noStudioRun = await runInitDetached({
  args: ['init', '--yes', '--no-studio'],
  cwd: RUN_NO_STUDIO,
  budgetMs: EXIT_BUDGET_MS,
});

assert({
  ac: 'AC-3',
  ok: noStudioRun.exited && noStudioRun.status === 0,
  message: `init --yes --no-studio must exit 0, got exited=${noStudioRun.exited} status=${noStudioRun.status}`,
});

// Absolute paths differ by run dir; nothing else may.
const normalize = ({ text, dir }) => text.split(dir).join('<RUN_DIR>');

assert({
  ac: 'AC-3',
  ok:
    normalize({ text: yesRun.output, dir: RUN_YES }) ===
    normalize({ text: noStudioRun.output, dir: RUN_NO_STUDIO }),
  message: [
    'init --yes and init --yes --no-studio must print the same thing.',
    `--- --yes ---\n${yesRun.output}`,
    `--- --yes --no-studio ---\n${noStudioRun.output}`,
  ].join('\n'),
});

const yesTree = generatedTree({ dir: RUN_YES });
const noStudioTree = generatedTree({ dir: RUN_NO_STUDIO });

assert({
  ac: 'AC-3',
  ok: yesTree.length > 0 && yesTree.join('\n') === noStudioTree.join('\n'),
  message: `generated file sets differ:\n${yesTree.join('\n')}\n---\n${noStudioTree.join('\n')}`,
});

for (const file of yesTree) {
  const left = normalize({ text: readFileSync(join(RUN_YES, file), 'utf8'), dir: RUN_YES });
  const right = normalize({
    text: readFileSync(join(RUN_NO_STUDIO, file), 'utf8'),
    dir: RUN_NO_STUDIO,
  });

  assert({ ac: 'AC-3', ok: left === right, message: `generated ${file} differs between the runs` });
}

console.log(`[phase 3] OK — identical stdout and ${yesTree.length} identical generated file(s)`);

// ───────── verdict ─────────

if (failures > 0) {
  console.error(`\nONT-077 scenario: ${failures} assertion(s) failed`);
  process.exit(1);
}

console.log('\nONT-077 scenario: all assertions passed');
