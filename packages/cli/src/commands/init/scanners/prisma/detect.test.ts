import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prismaScanner } from './index';

/**
 * `detect` operates on the real filesystem, so each test builds a throwaway
 * repo tree under a fresh temp dir and asserts on the paths (made relative to
 * the repo root for readable, deterministic expectations).
 */
describe('prismaScanner.detect (plan I1 — nested schema detection)', () => {
  let cwd: string;

  const write = ({ rel }: { rel: string }): void => {
    const abs = join(cwd, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '// schema\n');
  };

  const detectRel = (): string[] =>
    prismaScanner.detect({ cwd }).map((abs) => abs.slice(cwd.length + 1));

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ont-008-detect-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('finds a root-only schema and nothing else', () => {
    write({ rel: 'prisma/schema.prisma' });

    expect(detectRel()).toEqual(['prisma/schema.prisma']);
  });

  it('finds a nested-only schema under packages/<dir>/prisma', () => {
    write({ rel: 'packages/db/prisma/schema.prisma' });

    expect(detectRel()).toEqual(['packages/db/prisma/schema.prisma']);
  });

  it('finds a nested-only schema under apps/<dir>/prisma', () => {
    write({ rel: 'apps/web/prisma/schema.prisma' });

    expect(detectRel()).toEqual(['apps/web/prisma/schema.prisma']);
  });

  it('returns root candidates first, then packages, then apps (order pinned)', () => {
    write({ rel: 'prisma/schema.prisma' });
    write({ rel: 'schema.prisma' });
    write({ rel: 'packages/db/prisma/schema.prisma' });
    write({ rel: 'apps/web/prisma/schema.prisma' });

    expect(detectRel()).toEqual([
      'prisma/schema.prisma',
      'schema.prisma',
      'packages/db/prisma/schema.prisma',
      'apps/web/prisma/schema.prisma',
    ]);
  });

  it('finds a schema directly under a workspace package named prisma (cal.com shape)', () => {
    write({ rel: 'packages/prisma/schema.prisma' });

    expect(detectRel()).toEqual(['packages/prisma/schema.prisma']);
  });

  it('returns both shapes for a workspace dir holding prisma/schema.prisma and schema.prisma (order pinned)', () => {
    write({ rel: 'packages/db/prisma/schema.prisma' });
    write({ rel: 'packages/db/schema.prisma' });

    expect(detectRel()).toEqual(['packages/db/prisma/schema.prisma', 'packages/db/schema.prisma']);
  });

  it('sorts sibling workspace dirs lexicographically', () => {
    write({ rel: 'packages/zeta/prisma/schema.prisma' });
    write({ rel: 'packages/alpha/prisma/schema.prisma' });
    write({ rel: 'packages/mid/prisma/schema.prisma' });

    expect(detectRel()).toEqual([
      'packages/alpha/prisma/schema.prisma',
      'packages/mid/prisma/schema.prisma',
      'packages/zeta/prisma/schema.prisma',
    ]);
  });

  it('is empty when neither packages/ nor apps/ exists and no root schema', () => {
    expect(detectRel()).toEqual([]);
  });

  it('ignores workspace subdirs without a prisma/schema.prisma', () => {
    mkdirSync(join(cwd, 'packages', 'empty'), { recursive: true });
    write({ rel: 'packages/db/prisma/schema.prisma' });

    expect(detectRel()).toEqual(['packages/db/prisma/schema.prisma']);
  });

  it('ignores non-directory entries under packages/', () => {
    write({ rel: 'packages/db/prisma/schema.prisma' });
    writeFileSync(join(cwd, 'packages', 'README.md'), '# packages\n');

    expect(detectRel()).toEqual(['packages/db/prisma/schema.prisma']);
  });
});
