import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseBaseline } from '../../governance';
import { runInit } from './index';
import type { InitFlags } from './wizard';

const SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Article {
  id    Int    @id @default(autoincrement())
  title String
}
`;

const FLAGS: InitFlags = { yes: true, docs: false, studio: false, open: false };

const tempDirs: string[] = [];

/** A scratch repo with a Prisma schema — enough for init to render a file set. */
const makeRepo = ({ prefix }: { prefix: string }): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);

  mkdirSync(join(dir, 'prisma'), { recursive: true });
  writeFileSync(join(dir, 'prisma', 'schema.prisma'), SCHEMA, 'utf8');

  return dir;
};

/**
 * Plant a package manifest under the repo's own `node_modules`, which is what
 * the Prisma-major probe reads (ONT-049). A manifest is all the probe needs —
 * it reads `version` and nothing else — so these cases cost no install.
 */
const installPackage = ({
  cwd,
  pkg,
  version,
}: {
  cwd: string;
  pkg: string;
  version: string;
}): void => {
  const dir = join(cwd, 'node_modules', ...pkg.split('/'));

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version }), 'utf8');
};

/** Run `runInit` with stdout/stderr captured instead of printed. */
const runCaptured = async ({ cwd, flags = {} }: { cwd: string; flags?: Partial<InitFlags> }) => {
  const out: string[] = [];
  const err: string[] = [];

  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });

  try {
    const code = await runInit({ flags: { ...FLAGS, ...flags }, cwd });

    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runInit front door', () => {
  it('generates the whole file set into an empty repo and exits 0', async () => {
    // Which degrade branch a bare repo lands in is NOT asserted here: the test
    // runner resolves dynamic imports through its own loader, which leaks the
    // workspace's node_modules into a scratch dir that has none. The verdict
    // split lives in atomic.test.ts (injected resolver) and the ONT-039 e2e
    // (the shipped bin, out of repo, under pnpm).
    const repoDir = makeRepo({ prefix: 'ont-039-init-fresh-' });

    const { code } = await runCaptured({ cwd: repoDir });

    expect(code).toBe(0);
    expect(existsSync(join(repoDir, 'orangerail.config.mjs'))).toBe(true);
    expect(existsSync(join(repoDir, 'ontology', 'Article.mjs'))).toBe(true);
  });

  /**
   * ONT-050 — without this file a fresh project cannot detect the one edit that
   * disarms it: `sync` could only report that it had nothing to compare
   * against. ONT-043 declined to write it because a baseline asserts a human
   * reviewed the posture; the file now records WHO wrote it, so init can state a
   * starting point without claiming an approval.
   */
  it('records the generated posture as an init-provenance baseline, and says so', async () => {
    const repoDir = makeRepo({ prefix: 'ont-050-init-baseline-' });

    const { code, stdout } = await runCaptured({ cwd: repoDir });
    const path = join(repoDir, 'orangerail.governance.json');

    expect(code).toBe(0);
    expect(existsSync(path)).toBe(true);

    const baseline = parseBaseline({ source: readFileSync(path, 'utf8') });
    expect(baseline.recordedBy).toBe('init');
    // Since ONT-056 the recorded rows are the posture init GENERATED, which
    // under the default `--gate delete` is not all-gated. The baseline is a
    // description of the starting point, not a claim that it is strict — so
    // what is asserted is that it MATCHES what was written, per action.
    expect(baseline.actions.length).toBeGreaterThan(0);
    expect(
      baseline.actions
        .filter((row) => row.approval === 'required')
        .map((row) => row.name)
        .sort(),
    ).toEqual(['deleteArticle']);

    expect(stdout).toContain('orangerail.governance.json');
    expect(stdout).toContain('nobody has reviewed');
    expect(stdout).toContain('orangerail sync --accept-governance');
  });

  /**
   * ONT-056 — the gated count in the closing summary is derived through the same
   * predicate the emitter branched on, so a run that leaves writes executable
   * cannot close with a line the reader mistakes for "all of them are gated".
   */
  it('gates only the delete by default, and says which writes are not gated', async () => {
    const repoDir = makeRepo({ prefix: 'ont-056-init-gate-default-' });

    const { code, stdout } = await runCaptured({ cwd: repoDir });

    expect(code).toBe(0);
    expect(readFileSync(join(repoDir, 'ontology', 'deleteArticle.mjs'), 'utf8')).toContain(
      "policy: { approval: 'required' },",
    );
    for (const stem of ['createArticle', 'updateArticle']) {
      const content = readFileSync(join(repoDir, 'ontology', `${stem}.mjs`), 'utf8');

      expect(content).not.toContain("\n  policy: { approval: 'required' },\n");
      // The header cannot describe a gate the file does not declare.
      expect(content).not.toContain('staged for human approval');
      expect(content).toContain('NOT approval-gated');
    }

    expect(stdout).toContain('--gate delete: 1 of 3 write action(s) gated behind human approval');
    expect(stdout).toContain('the other 2 run when the agent calls them');
  });

  it('gates every write under --gate all, and none under --gate none (ONT-056)', async () => {
    const allDir = makeRepo({ prefix: 'ont-056-init-gate-all-' });
    const noneDir = makeRepo({ prefix: 'ont-056-init-gate-none-' });

    const all = await runCaptured({ cwd: allDir, flags: { gate: 'all' } });
    const none = await runCaptured({ cwd: noneDir, flags: { gate: 'none' } });

    expect(all.code).toBe(0);
    expect(none.code).toBe(0);

    for (const stem of ['createArticle', 'updateArticle', 'deleteArticle']) {
      expect(readFileSync(join(allDir, 'ontology', `${stem}.mjs`), 'utf8')).toContain(
        "policy: { approval: 'required' },",
      );
      expect(readFileSync(join(noneDir, 'ontology', `${stem}.mjs`), 'utf8')).not.toContain(
        "\n  policy: { approval: 'required' },\n",
      );
    }

    expect(all.stdout).toContain('--gate all: 3 of 3 write action(s) gated');
    expect(all.stdout).not.toContain('run when the agent calls them');
    expect(none.stdout).toContain('--gate none: 0 of 3 write action(s) gated');

    // The baseline describes each run rather than asserting a fixed posture.
    const noneBaseline = parseBaseline({
      source: readFileSync(join(noneDir, 'orangerail.governance.json'), 'utf8'),
    });
    expect(noneBaseline.actions.every((row) => row.approval === null)).toBe(true);
  });

  it('refuses when a TypeScript config already exists (the documented name)', async () => {
    // packages/cli/README.md documents `orangerail.config.ts` through the user's
    // own TS-capable runtime. A name init does not recognize used to read as
    // "not initialized" and get regenerated over the top of the user's work.
    const repoDir = makeRepo({ prefix: 'ont-039-init-ts-' });
    writeFileSync(join(repoDir, 'orangerail.config.ts'), 'export default {};\n', 'utf8');

    const { code, stderr } = await runCaptured({ cwd: repoDir });

    expect(code).toBe(1);
    expect(stderr).toContain('an orangerail config already exists here');
    expect(existsSync(join(repoDir, 'orangerail.config.mjs'))).toBe(false);
  });

  it('refuses when generated targets exist without a config, leaving them untouched', async () => {
    const repoDir = makeRepo({ prefix: 'ont-039-init-clobber-' });

    mkdirSync(join(repoDir, 'ontology'), { recursive: true });
    writeFileSync(
      join(repoDir, 'ontology', 'Article.mjs'),
      '// === HAND-WRITTEN BUSINESS RULE ===\n',
      'utf8',
    );

    const { code, stderr } = await runCaptured({ cwd: repoDir });

    expect(code).toBe(1);
    expect(stderr).toContain('init never overwrites your ontology');
    expect(stderr).toContain('ontology/Article.mjs');
    expect(readFileSync(join(repoDir, 'ontology', 'Article.mjs'), 'utf8')).toBe(
      '// === HAND-WRITTEN BUSINESS RULE ===\n',
    );
    expect(existsSync(join(repoDir, 'orangerail.config.mjs'))).toBe(false);
  });
});

describe('runInit refusal exit codes (ONT-049)', () => {
  // Every path that declines to generate has to say so in its exit code. The
  // "no sources" path printed on stdout and returned 0, which told every
  // scripted caller that init had succeeded over a repo it never touched.

  it('exits 1 and points at the on-ramp when there is nothing to scan', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'ont-049-init-empty-'));
    tempDirs.push(emptyDir);

    const { code, stdout, stderr } = await runCaptured({ cwd: emptyDir });

    expect(code).toBe(1);
    expect(stderr).toContain('no Prisma schema or OpenAPI JSON found');
    // The refusal names the way OUT. A live database with no schema file is the
    // most likely starting point, and "add a prisma/schema.prisma" is not an
    // instruction that user can follow without being told `db pull` writes one.
    expect(stderr).toContain('prisma db pull');
    expect(stderr).toContain('docs/existing-database.md');
    // A refusal is not a result: nothing about it belongs on stdout.
    expect(stdout).toBe('');
    expect(existsSync(join(emptyDir, 'orangerail.config.mjs'))).toBe(false);
  });

  it('exits 1 and writes nothing when Prisma 7 has no driver adapter', async () => {
    const repoDir = makeRepo({ prefix: 'ont-049-init-prisma7-' });
    installPackage({ cwd: repoDir, pkg: '@prisma/client', version: '7.9.1' });

    const { code, stderr } = await runCaptured({ cwd: repoDir });

    expect(code).toBe(1);
    expect(stderr).toContain('no supported driver adapter is installed');
    expect(stderr).toContain('npm install @prisma/adapter-pg');
    expect(existsSync(join(repoDir, 'orangerail.config.mjs'))).toBe(false);
    expect(existsSync(join(repoDir, 'ontology'))).toBe(false);
  });

  it('generates the adapter construction when Prisma 7 has one, and exits 0', async () => {
    const repoDir = makeRepo({ prefix: 'ont-049-init-prisma7-ok-' });
    installPackage({ cwd: repoDir, pkg: '@prisma/client', version: '7.9.1' });
    installPackage({ cwd: repoDir, pkg: '@prisma/adapter-pg', version: '7.9.1' });

    const { code } = await runCaptured({ cwd: repoDir });

    expect(code).toBe(0);
    expect(readFileSync(join(repoDir, 'ontology', 'Article.mjs'), 'utf8')).toContain(
      'new PrismaClient({ adapter: new PrismaPg(url) })',
    );
  });

  it('leaves Prisma 6 output byte-identical to a repo with no Prisma at all', async () => {
    // AC-1: the pre-7 world must not move. Whatever a Prisma 6 repo emitted
    // before this change, it emits now.
    const six = makeRepo({ prefix: 'ont-049-init-prisma6-' });
    installPackage({ cwd: six, pkg: '@prisma/client', version: '6.19.3' });
    const none = makeRepo({ prefix: 'ont-049-init-noprisma-' });

    expect((await runCaptured({ cwd: six })).code).toBe(0);
    expect((await runCaptured({ cwd: none })).code).toBe(0);

    expect(readFileSync(join(six, 'ontology', 'Article.mjs'), 'utf8')).toBe(
      readFileSync(join(none, 'ontology', 'Article.mjs'), 'utf8'),
    );
    expect(readFileSync(join(six, 'ontology', 'Article.mjs'), 'utf8')).toContain(
      'client = new PrismaClient();',
    );
  });
});

/**
 * ONT-059 — `--exclude` is the deny-list's front door, and the complement of
 * `--models` is never treated as one.
 */
describe('orangerail init — refused models (ONT-059)', () => {
  const TWO_MODELS = `${SCHEMA}
model Secret {
  id    Int    @id @default(autoincrement())
  value String
}
`;

  const makeTwoModelRepo = (): string => {
    const dir = makeRepo({ prefix: 'ont-059-init-' });

    writeFileSync(join(dir, 'prisma', 'schema.prisma'), TWO_MODELS, 'utf8');

    return dir;
  };

  it('generates nothing for a refused model and records the refusal in the baseline', async () => {
    const cwd = makeTwoModelRepo();

    const { code, stdout } = await runCaptured({ cwd, flags: { exclude: ['Secret'] } });

    expect(code).toBe(0);
    expect(existsSync(join(cwd, 'ontology', 'Secret.mjs'))).toBe(false);
    expect(existsSync(join(cwd, 'ontology', 'Article.mjs'))).toBe(true);

    const baseline = parseBaseline({
      source: readFileSync(join(cwd, 'orangerail.governance.json'), 'utf8'),
    });
    expect(baseline.excluded).toEqual(['Secret']);
    expect(baseline.actions.some((row) => row.name.includes('Secret'))).toBe(false);

    // The refusal is stated where the generation is, not left to be found in a
    // JSON file later.
    expect(stdout).toContain('refused 1 model(s) — Secret');
  });

  it('refuses an unknown --exclude name before writing a byte', async () => {
    const cwd = makeTwoModelRepo();

    await expect(runCaptured({ cwd, flags: { exclude: ['Scret'] } })).rejects.toThrow(
      /unknown model "Scret" in --exclude/,
    );
    expect(existsSync(join(cwd, 'orangerail.config.mjs'))).toBe(false);
    expect(existsSync(join(cwd, 'ontology'))).toBe(false);
  });

  it('names what --models left unaccounted for, and records none of it', async () => {
    const cwd = makeTwoModelRepo();

    const { code, stdout } = await runCaptured({ cwd, flags: { models: ['Article'] } });

    expect(code).toBe(0);
    expect(stdout).toContain('1 scanned model(s) were neither generated nor refused: Secret');
    expect(stdout).toContain('orangerail sync --exclude Secret');

    // Narrowing is not refusing. Recording the complement would make the tool
    // assert a decision nobody made.
    const baseline = parseBaseline({
      source: readFileSync(join(cwd, 'orangerail.governance.json'), 'utf8'),
    });
    expect(baseline.excluded).toEqual([]);
  });

  it('says nothing about leftovers when every scanned model was kept or refused', async () => {
    const cwd = makeTwoModelRepo();

    const { stdout } = await runCaptured({
      cwd,
      flags: { models: ['Article'], exclude: ['Secret'] },
    });

    expect(stdout).not.toContain('neither generated nor refused');
    expect(stdout).toContain('refused 1 model(s) — Secret');
  });
});
