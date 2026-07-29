/**
 * ONT-049 e2e driver — the SHIPPED `orangerail init` against each Prisma major,
 * and the exit code of every refusal (ticket section 5).
 *
 * Everything runs OUTSIDE the repo, under os.tmpdir(). The Prisma-major probe
 * walks upward looking for `node_modules/@prisma/client`, so a scratch dir
 * inside the monorepo would read the monorepo's Prisma 6 no matter what the
 * scenario plants — the walk-up is exactly what the out-of-repo location
 * neutralizes.
 *
 *   Phase 1 (AC-1): a repo with no Prisma installed. The emitted construction is
 *     the pre-7 `new PrismaClient()`, unchanged.
 *   Phase 2 (AC-1): the same repo with Prisma 6.19.3 installed. Byte-identical
 *     to phase 1 — the pre-7 world does not move.
 *   Phase 3 (AC-2): Prisma 7.9.1 plus `@prisma/adapter-pg`. The construction
 *     passes a driver adapter built from the project's DATABASE_URL.
 *   Phase 4 (AC-3): Prisma 7.9.1 with no adapter. init must REFUSE, exit 1,
 *     name the adapter to install, and write nothing at all.
 *   Phase 5 (AC-4): an empty repo. init must refuse on stderr, exit 1, and name
 *     the existing-database walkthrough.
 *
 * Only package MANIFESTS are planted — the probe reads `version` and nothing
 * else — so every phase is offline and deterministic. What those manifests
 * stand in for was verified for real in the ticket: both majors installed from
 * npm, `prisma db pull` and `prisma generate` run against PostgreSQL 16.14, and
 * the generated Prisma 7 ontology queried that database through the adapter.
 *
 * RED (pre-implementation): phase 3 fails first — init emits
 * `new PrismaClient()` regardless of the installed major, which is the defect.
 * Phases 4 and 5 then fail on the exit code (both returned 0).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-049');

// process.pid keeps concurrent runs isolated without Date.now/random.
const WORK = join(tmpdir(), `orangerail-ont-049-${process.pid}`);

const INIT_ARGS = ['init', '--yes', '--no-studio', '--no-docs'];

const fail = ({ message }) => {
  console.error(`ONT-049 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

/** A fresh copy of the fixture repo under the scratch root. */
const makeRepo = ({ name, empty = false }) => {
  const dir = join(WORK, name);

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  if (!empty) {
    cpSync(FIXTURE, dir, { recursive: true });
  }

  return dir;
};

/** Plant a package manifest where the Prisma-major probe will read it. */
const plant = ({ cwd, pkg, version }) => {
  const dir = join(cwd, 'node_modules', ...pkg.split('/'));

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version }), 'utf8');
};

const runInit = ({ cwd }) => {
  const res = spawnSync(process.execPath, [CLI, ...INIT_ARGS], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

const generatedObject = ({ cwd }) => readFileSync(join(cwd, 'ontology', 'Product.mjs'), 'utf8');

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

assert({ ok: existsSync(CLI), message: `CLI bundle missing at ${CLI} — build first` });

// ---- Phase 1: no Prisma installed -> the pre-7 construction ----
const bare = makeRepo({ name: 'no-prisma' });
const bareRun = runInit({ cwd: bare });

assert({ ok: bareRun.status === 0, message: `phase 1: init exited ${bareRun.status}` });

const bareContent = generatedObject({ cwd: bare });

assert({
  ok: bareContent.includes('client = new PrismaClient();'),
  message: 'phase 1: expected the pre-7 bare constructor',
});

// ---- Phase 2: Prisma 6 -> byte-identical to phase 1 ----
const six = makeRepo({ name: 'prisma-6' });
plant({ cwd: six, pkg: '@prisma/client', version: '6.19.3' });
plant({ cwd: six, pkg: 'prisma', version: '6.19.3' });

const sixRun = runInit({ cwd: six });

assert({ ok: sixRun.status === 0, message: `phase 2: init exited ${sixRun.status}` });
assert({
  ok: generatedObject({ cwd: six }) === bareContent,
  message: 'phase 2: Prisma 6 output drifted from the no-Prisma output',
});

// ---- Phase 3: Prisma 7 + an adapter -> the adapter construction ----
const seven = makeRepo({ name: 'prisma-7-adapter' });
plant({ cwd: seven, pkg: '@prisma/client', version: '7.9.1' });
plant({ cwd: seven, pkg: 'prisma', version: '7.9.1' });
plant({ cwd: seven, pkg: '@prisma/adapter-pg', version: '7.9.1' });

const sevenRun = runInit({ cwd: seven });

assert({ ok: sevenRun.status === 0, message: `phase 3: init exited ${sevenRun.status}` });

const sevenContent = generatedObject({ cwd: seven });

assert({
  ok: sevenContent.includes('client = new PrismaClient({ adapter: new PrismaPg(url) });'),
  message: 'phase 3: expected an adapter-backed client construction',
});
assert({
  ok: sevenContent.includes('const url = process.env.DATABASE_URL;'),
  message: 'phase 3: expected the connection URL to come from DATABASE_URL',
});
assert({
  ok: !sevenContent.includes('new PrismaClient();'),
  message: 'phase 3: the pre-7 constructor survived into Prisma 7 output',
});

// ---- Phase 4: Prisma 7, no adapter -> refuse, exit 1, write nothing ----
const orphan = makeRepo({ name: 'prisma-7-no-adapter' });
plant({ cwd: orphan, pkg: '@prisma/client', version: '7.9.1' });

const orphanRun = runInit({ cwd: orphan });

assert({
  ok: orphanRun.status === 1,
  message: `phase 4: expected exit 1, got ${orphanRun.status}`,
});
assert({
  ok: orphanRun.stderr.includes('no supported driver adapter is installed'),
  message: 'phase 4: the refusal did not state the finding',
});
assert({
  ok: orphanRun.stderr.includes('npm install @prisma/adapter-pg'),
  message: 'phase 4: the refusal did not name the adapter for the scanned provider',
});
assert({
  ok: !existsSync(join(orphan, 'orangerail.config.mjs')) && !existsSync(join(orphan, 'ontology')),
  message: 'phase 4: the refusal still wrote files',
});

// ---- Phase 5: nothing to scan -> refuse on stderr, exit 1, name the doc ----
const nothing = makeRepo({ name: 'empty', empty: true });
const nothingRun = runInit({ cwd: nothing });

assert({
  ok: nothingRun.status === 1,
  message: `phase 5: expected exit 1, got ${nothingRun.status}`,
});
assert({
  ok: nothingRun.stderr.includes('no Prisma schema or OpenAPI JSON found'),
  message: 'phase 5: the refusal text is missing',
});
assert({
  ok: nothingRun.stderr.includes('docs/existing-database.md'),
  message: 'phase 5: the refusal did not point at the existing-database walkthrough',
});
assert({
  ok: nothingRun.stdout === '',
  message: `phase 5: a refusal wrote to stdout: ${JSON.stringify(nothingRun.stdout)}`,
});

rmSync(WORK, { recursive: true, force: true });

console.log('ONT-049 e2e: 5/5 phases passed');
