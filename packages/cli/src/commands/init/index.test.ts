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
    // Every generated action is gated, so the recorded starting point is the
    // strongest posture the tool can produce — it cannot launder a weak one.
    expect(baseline.actions.length).toBeGreaterThan(0);
    expect(baseline.actions.every((row) => row.approval === 'required')).toBe(true);

    expect(stdout).toContain('orangerail.governance.json');
    expect(stdout).toContain('nobody has reviewed');
    expect(stdout).toContain('orangerail sync --accept-governance');
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
