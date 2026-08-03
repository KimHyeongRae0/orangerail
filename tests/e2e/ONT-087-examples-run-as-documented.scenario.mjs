/**
 * ONT-087 e2e driver — every example runs exactly as its README documents it.
 *
 * The thing under test is the INSTRUCTIONS, not the walkthrough code. ONT-085
 * (#137/#138) was a four-line "Run it" block that crashed twice on a missing
 * `DATABASE_URL` while `walkthrough.mjs` itself was fine, and CI had no way to
 * notice. So this driver does not import the examples, reimplement their setup,
 * or arrange a convenient equivalent — it lifts the ```bash fences out of each
 * example README's "## Run it" section and executes them verbatim, in order.
 *
 * Two consequences of that choice, both deliberate:
 *
 *   - `DATABASE_URL` is DELETED from the environment handed to each block. If
 *     the README forgets to export it, the block must die exactly the way a
 *     stranger's shell would, not quietly inherit one from the runner.
 *   - Examples are DISCOVERED by listing the `examples/` directory, never
 *     hardcoded. An example added later with no "## Run it" section, or one
 *     whose section carries no bash fence, fails this scenario loudly rather
 *     than being silently skipped.
 *
 * The workspace-build fence (`pnpm -r run build`) is the one command not
 * re-executed per example: the sibling .sh already ran it once, and three more
 * root-level installs would test pnpm rather than the examples. It is reported
 * as skipped so the omission stays visible.
 *
 * Phases:
 *
 *   phase 1  (AC-1, AC-2) each discovered example's documented block runs to
 *            completion, exit 0. Each example asserts every one of its own steps
 *            and exits non-zero on any deviation, so a green exit IS the
 *            assertion — this scenario's job is to make it run at all.
 *   phase 2  (AC-3) the same documented block runs a SECOND time against the
 *            database, generated client and approvals store the first one left
 *            behind, and must again exit 0. Every example resets both stores on
 *            entry; an example that only works on a clean checkout fails here.
 *   phase 3  (AC-4) per-example and total wall time are printed, so the number
 *            recorded in the PR against `timeout-minutes` is measured.
 *
 * RED (pre-implementation): revert ONT-085's `export DATABASE_URL="file:./dev.db"`
 * line from examples/unattended-queue/README.md and phase 1 fails on that example
 * with prisma's "Environment variable not found: DATABASE_URL" — which is the
 * regression this scenario exists to catch, verifiable in one edit.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLES = join(ROOT, 'examples');
const RUN_DIR = join(ROOT, '.docs', 'scratch', 'ont-087');

/** The one fence the wrapper .sh has already executed for the whole run. */
const WORKSPACE_BUILD = 'pnpm -r run build';

const fail = ({ message }) => {
  console.error(`ONT-087 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

/**
 * Returns the lines of the README's "## Run it" section — everything between
 * that heading and the next H2. A README without one cannot be followed, which
 * is a finding about the example rather than about this scenario.
 */
const runItSection = ({ readme, label }) => {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => /^##\s+Run it\s*$/.test(line));

  assert({
    ok: start !== -1,
    message: `${label}: no "## Run it" section in its README — this scenario does not know how to run it`,
  });

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));

  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * Every ```bash fence in the given lines, in document order, each as one string.
 */
const bashFences = ({ lines }) => {
  const fences = [];
  let current = null;

  for (const line of lines) {
    if (current === null) {
      if (/^```bash\s*$/.test(line)) {
        current = [];
      }
      continue;
    }

    if (/^```\s*$/.test(line)) {
      fences.push(current.join('\n'));
      current = null;
      continue;
    }

    current.push(line);
  }

  return fences;
};

/**
 * The first thing the block actually does, comments and blank lines ignored.
 * A block that starts by changing directory is written from the repo root; one
 * that does not is written for the example's own folder, which is what each
 * README says in the prose right above its fence.
 */
const firstCommand = ({ script }) =>
  script
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#')) ?? '';

/**
 * Reads one example's README and returns the documented block to execute, the
 * directory to execute it from, and whatever was deliberately left out.
 */
const documentedBlock = ({ name }) => {
  const dir = join(EXAMPLES, name);
  const readmePath = join(dir, 'README.md');
  const label = `examples/${name}`;

  assert({ ok: existsSync(readmePath), message: `${label}: no README.md` });

  const fences = bashFences({
    lines: runItSection({ readme: readFileSync(readmePath, 'utf8'), label }),
  });

  assert({
    ok: fences.length > 0,
    message: `${label}: its "## Run it" section has no \`\`\`bash fence — this scenario does not know how to run it`,
  });

  const skipped = fences.filter((fence) => fence.includes(WORKSPACE_BUILD));
  const script = fences.filter((fence) => !fence.includes(WORKSPACE_BUILD)).join('\n');

  assert({
    ok: script.trim().length > 0,
    message: `${label}: its "## Run it" section documents only the workspace build`,
  });

  return {
    label,
    script,
    skipped,
    cwd: firstCommand({ script }).startsWith('cd ') ? ROOT : dir,
  };
};

/**
 * Executes one documented block through bash and returns how it went.
 *
 * `DATABASE_URL` is removed from the child environment on purpose: inheriting
 * it would have masked the ONT-085 bug completely, since the runner that
 * happens to have one set never sees the missing export.
 */
const runBlock = ({ label, script, cwd, pass }) => {
  const scriptPath = join(RUN_DIR, `${label.replace(/\//g, '-')}-pass${pass}.sh`);
  writeFileSync(scriptPath, `set -euo pipefail\n\n${script}\n`, 'utf8');

  const env = { ...process.env };
  delete env.DATABASE_URL;

  const startedAt = process.hrtime.bigint();
  const result = spawnSync('bash', [scriptPath], { cwd, env, encoding: 'utf8' });
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(RUN_DIR, `${label.replace(/\//g, '-')}-pass${pass}.log`), output, 'utf8');

  return { status: result.status, output, seconds };
};

const report = ({ label, pass, cwd, result }) => {
  console.error(
    `ONT-087 ${label} pass ${pass} exited ${result.status} (cwd ${relative(ROOT, cwd) || '.'})`,
  );
  console.error('─── last 40 lines ───');
  console.error(result.output.split('\n').slice(-40).join('\n'));
  console.error('─────────────────────');
};

rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(RUN_DIR, { recursive: true });

const names = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

assert({ ok: names.length > 0, message: 'no example directories found under examples/' });

console.log(`ONT-087: ${names.length} example(s) discovered: ${names.join(', ')}`);

const timings = [];

for (const name of names) {
  const { label, script, skipped, cwd } = documentedBlock({ name });

  console.log(
    `\n── ${label} — ${script.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#')).length} documented command(s), from ${relative(ROOT, cwd) || '.'}`,
  );

  for (const fence of skipped) {
    console.log(
      `   (workspace build already run once by the wrapper: ${firstCommand({ script: fence })})`,
    );
  }

  // phase 1 — the documented block, on whatever state the checkout is in.
  const first = runBlock({ label, script, cwd, pass: 1 });

  if (first.status !== 0) {
    report({ label, pass: 1, cwd, result: first });
    fail({ message: `${label} does not run as documented` });
  }

  console.log(`   pass 1 ok (${first.seconds.toFixed(1)}s)`);

  // phase 2 — the same block again, over the state pass 1 left behind.
  const second = runBlock({ label, script, cwd, pass: 2 });

  if (second.status !== 0) {
    report({ label, pass: 2, cwd, result: second });
    fail({ message: `${label} runs once but not twice — it depends on a clean checkout` });
  }

  console.log(`   pass 2 ok (${second.seconds.toFixed(1)}s)`);

  timings.push({ label, first: first.seconds, second: second.seconds });
}

// phase 3 — measured, so the PR quotes a number instead of an estimate.
const total = timings.reduce((sum, entry) => sum + entry.first + entry.second, 0);

console.log('\nONT-087 wall time (this driver only, excluding the workspace build):');
for (const entry of timings) {
  console.log(
    `  ${entry.label.padEnd(28)} ${entry.first.toFixed(1)}s + ${entry.second.toFixed(1)}s`,
  );
}
console.log(`  ${'TOTAL'.padEnd(28)} ${total.toFixed(1)}s`);

console.log(`\nONT-087: ${names.length} example(s) ran as documented, twice each.`);
