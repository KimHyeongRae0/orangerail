import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
const runCaptured = async ({ cwd }: { cwd: string }) => {
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
    const code = await runInit({ flags: FLAGS, cwd });

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
