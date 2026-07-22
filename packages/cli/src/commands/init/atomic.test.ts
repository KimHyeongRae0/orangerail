import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { existsSync } from 'node:fs';

import { smokeLoadStaged, specifiersResolvable } from './atomic';

describe('specifiersResolvable (D9 degrade branch)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false when a required specifier does not resolve', () => {
    // The generated code needs orangerail-core AND zod; if either is missing,
    // init takes the degrade path (files written, install command printed,
    // smoke load + studio skipped, exit 0).
    const resolver = ({ specifier }: { specifier: string }) => {
      if (specifier === 'orangerail-core') {
        throw new Error('not found');
      }
    };

    expect(specifiersResolvable({ cwd: '/nowhere', resolver })).toBe(false);
  });

  it('is true when both specifiers resolve', () => {
    const resolver = () => {};

    expect(specifiersResolvable({ cwd: '/nowhere', resolver })).toBe(true);
  });

  it('resolves via the real node resolver when node_modules provides the deps', () => {
    // A self-contained repo fixture — the real monorepo cannot be used here
    // because resolving orangerail-core requires its dist/ build output, which
    // does not exist yet when CI runs tests before build.
    const repoDir = mkdtempSync(join(tmpdir(), 'ont-006-resolve-'));
    tempDirs.push(repoDir);

    for (const name of ['orangerail-core', 'zod']) {
      const packageDir = join(repoDir, 'node_modules', name);
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ name, version: '0.0.0', main: 'index.js' }),
        'utf8',
      );
      writeFileSync(join(packageDir, 'index.js'), '', 'utf8');
    }

    expect(specifiersResolvable({ cwd: repoDir })).toBe(true);
  });
});

describe('smokeLoadStaged', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the repo byte-identical on a failed smoke load (no empty .orangerail)', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'ont-006-smoke-'));
    tempDirs.push(repoDir);

    const files = [
      { path: 'orangerail.config.mjs', content: 'export default { notAConfig: true };\n' },
    ];

    await expect(smokeLoadStaged({ files, cwd: repoDir })).rejects.toThrow(
      /usable \{ registry, store \}/,
    );

    expect(existsSync(join(repoDir, '.orangerail'))).toBe(false);
  });
});
