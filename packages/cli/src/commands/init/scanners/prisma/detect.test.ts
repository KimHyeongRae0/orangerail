import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanRepo } from '../../scan';
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

/**
 * ONT-042 D — `CANDIDATES` held single files only, so the GA
 * `prismaSchemaFolder` layout (`prisma/schema/*.prisma`) was not detected at
 * all and the user was told nothing was found. The folder is read as ONE
 * schema: a multi-file schema splits models across files freely, so scanning
 * `user.prisma` alone would report a relation to a model declared elsewhere as
 * an unsupported field type.
 */
describe('prismaScanner (ONT-042 D — the prismaSchemaFolder layout)', () => {
  let cwd: string;

  const writeAt = ({ rel, content }: { rel: string; content: string }): void => {
    const abs = join(cwd, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  };

  const detectRel = (): string[] =>
    prismaScanner.detect({ cwd }).map((abs) => abs.slice(cwd.length + 1));

  /** The QA reproduction: base + user + post, split across three files. */
  const writeSplitSchema = ({ dir }: { dir: string }): void => {
    writeAt({
      rel: `${dir}/base.prisma`,
      content: 'datasource db {\n  provider = "postgresql"\n}\n',
    });
    writeAt({
      rel: `${dir}/post.prisma`,
      content: 'model Post {\n  id String @id\n  title String\n  author User @relation("a")\n}\n',
    });
    writeAt({
      rel: `${dir}/user.prisma`,
      content: 'model User {\n  id String @id\n  posts Post[]\n}\n',
    });
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ont-042-prisma-folder-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('detects prisma/schema/ as one schema source', () => {
    writeSplitSchema({ dir: 'prisma/schema' });

    expect(detectRel()).toEqual(['prisma/schema']);
  });

  it('generates every model in the folder with its cross-file relations intact', () => {
    writeSplitSchema({ dir: 'prisma/schema' });

    const [filePath] = prismaScanner.detect({ cwd });
    const scanned = prismaScanner.scan({ filePath: filePath as string });

    expect(scanned.objects.map((o) => o.name).sort()).toEqual(['Post', 'User']);

    // `posts Post[]` in user.prisma resolves against the model in post.prisma;
    // per-file scanning would have called it an unsupported field type instead.
    const user = scanned.objects.find((o) => o.name === 'User');
    expect(user?.relations).toEqual([{ field: 'posts', target: 'Post', cardinality: 'many' }]);
    expect(scanned.warnings).toHaveLength(0);
  });

  it('walks nested subdirectories of the schema folder, in a deterministic order', () => {
    writeAt({ rel: 'prisma/schema/a.prisma', content: 'model A {\n  id String @id\n}\n' });
    writeAt({ rel: 'prisma/schema/nested/z.prisma', content: 'model Z {\n  id String @id\n}\n' });
    writeAt({ rel: 'prisma/schema/nested/m.prisma', content: 'model M {\n  id String @id\n}\n' });

    const [filePath] = prismaScanner.detect({ cwd });
    const scanned = prismaScanner.scan({ filePath: filePath as string });

    // Files before subdirs, each group sorted: a, nested/m, nested/z.
    expect(scanned.objects.map((o) => o.name)).toEqual(['A', 'M', 'Z']);
  });

  it('does not claim an empty prisma/schema/ directory', () => {
    mkdirSync(join(cwd, 'prisma', 'schema'), { recursive: true });

    expect(detectRel()).toEqual([]);
  });

  it('does not claim a prisma/schema/ holding no .prisma files', () => {
    writeAt({ rel: 'prisma/schema/README.md', content: '# schema\n' });

    expect(detectRel()).toEqual([]);
  });

  it('finds the folder layout inside a monorepo workspace package too', () => {
    writeSplitSchema({ dir: 'packages/db/prisma/schema' });

    expect(detectRel()).toEqual(['packages/db/prisma/schema']);
  });

  it('de-collides case-variant models declared in SEPARATE files of the folder', () => {
    // The folder is read as one schema, so its models reach `allocateNames`
    // together and ONT-041's case-folded collision key sees them as colliding —
    // which it must, since all three would claim `ontology/User.mjs`.
    writeAt({ rel: 'prisma/schema/a-user.prisma', content: 'model User {\n  id String @id\n}\n' });
    writeAt({ rel: 'prisma/schema/b-user.prisma', content: 'model user {\n  id String @id\n}\n' });
    writeAt({ rel: 'prisma/schema/c-user.prisma', content: 'model USER {\n  id String @id\n}\n' });

    const scanned = scanRepo({ cwd });

    expect(scanned.objects.map((o) => o.name)).toEqual(['User', 'user_2', 'USER_3']);

    // ONT-041's invariant survives the folder path: a collision-rename moves the
    // registry name but never the database accessor, which tracks `sourceModel`.
    expect(scanned.objects.map((o) => o.sourceModel)).toEqual(['User', 'user', 'USER']);
    expect(scanned.warnings.filter((w) => /collides with/.test(w))).toHaveLength(2);
  });

  it('scans the folder deterministically — same tree, same names, every run', () => {
    writeSplitSchema({ dir: 'prisma/schema' });
    writeAt({ rel: 'prisma/schema/nested/z.prisma', content: 'model Z {\n  id String @id\n}\n' });

    const first = scanRepo({ cwd }).objects.map((o) => o.name);
    const second = scanRepo({ cwd }).objects.map((o) => o.name);

    expect(second).toEqual(first);
    expect(first).toEqual(['Post', 'User', 'Z']);
  });

  it('keeps the single-file candidates ahead of the folder when a repo has both', () => {
    writeAt({ rel: 'prisma/schema.prisma', content: 'model Root {\n  id String @id\n}\n' });
    writeAt({ rel: 'prisma/schema/extra.prisma', content: 'model Extra {\n  id String @id\n}\n' });

    expect(detectRel()).toEqual(['prisma/schema.prisma', 'prisma/schema']);
  });
});
