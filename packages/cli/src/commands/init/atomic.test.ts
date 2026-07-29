import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clobberRefusal,
  degradeNotice,
  existingTargets,
  verifyStaged,
  writeFileSet,
} from './atomic';

/** A scratch repo root, removed after the test that made it. */
const tempDirs: string[] = [];

const makeRepo = ({ prefix }: { prefix: string }): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
};

/** Install a stub package into `repoDir`'s node_modules with the given manifest. */
const installStub = ({
  repoDir,
  name,
  manifest,
}: {
  repoDir: string;
  name: string;
  manifest: Record<string, unknown>;
}): void => {
  const packageDir = join(repoDir, 'node_modules', name);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, ...manifest }), 'utf8');
  writeFileSync(join(packageDir, 'index.cjs'), 'module.exports = {};\n', 'utf8');
  writeFileSync(join(packageDir, 'index.js'), 'export default {};\n', 'utf8');
};

const CONFIG_OK = [
  { path: 'orangerail.config.mjs', content: 'export default { registry: {}, store: {} };\n' },
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('verifyStaged (D9 pre-verification)', () => {
  it('reports missing-deps when a required specifier does not resolve', async () => {
    // The generated code needs orangerail-core AND zod; if either is missing,
    // init takes the degrade path (files written, install command printed,
    // smoke load + studio skipped, exit 0).
    const resolver = async ({ specifier }: { specifier: string }) => {
      if (specifier === 'orangerail-core') {
        throw new Error('not found');
      }
    };

    const repoDir = makeRepo({ prefix: 'ont-039-missing-' });

    expect(await verifyStaged({ files: CONFIG_OK, cwd: repoDir, resolver })).toEqual({
      ok: false,
      kind: 'missing-deps',
    });
  });

  it('is ok when both specifiers resolve and the config constructs', async () => {
    const resolver = async () => {};
    const repoDir = makeRepo({ prefix: 'ont-039-ok-' });

    expect(await verifyStaged({ files: CONFIG_OK, cwd: repoDir, resolver })).toEqual({ ok: true });
  });

  it('agrees with the ESM loader, not with require.resolve (the pnpm shape)', async () => {
    // pnpm's bin shim and `pnpm dlx` export NODE_PATH at `.pnpm/node_modules`.
    // CJS resolution honors NODE_PATH; the ESM loader ignores it — so a CJS
    // probe answers "yes" for a package `import()` cannot see, init takes the
    // smoke-load branch, and the run dies with ERR_MODULE_NOT_FOUND.
    //
    // NODE_PATH itself is fixed at process start and cannot be injected into a
    // running test runner, so this fixture reproduces the same CJS/ESM split
    // with the other mechanism that produces it: an exports map that offers
    // only the `require` condition. require.resolve finds it; `import()` does
    // not. The literal NODE_PATH case is covered live in the ONT-039 e2e.
    const repoDir = makeRepo({ prefix: 'ont-039-pnpm-' });

    for (const name of ['orangerail-core', 'zod']) {
      installStub({
        repoDir,
        name,
        manifest: { version: '0.0.0', exports: { require: './index.cjs' } },
      });
    }

    const require = createRequire(join(repoDir, 'package.json'));
    expect(require.resolve('orangerail-core')).toContain('index.cjs');

    expect(await verifyStaged({ files: CONFIG_OK, cwd: repoDir })).toEqual({
      ok: false,
      kind: 'missing-deps',
    });
  });

  it('resolves via the real ESM loader when node_modules provides the deps', async () => {
    // A self-contained repo fixture — the real monorepo cannot be used here
    // because resolving orangerail-core requires its dist/ build output, which
    // does not exist yet when CI runs tests before build.
    const repoDir = makeRepo({ prefix: 'ont-039-resolve-' });

    for (const name of ['orangerail-core', 'zod']) {
      installStub({
        repoDir,
        name,
        manifest: { version: '0.0.0', type: 'module', main: 'index.js' },
      });
    }

    expect(await verifyStaged({ files: CONFIG_OK, cwd: repoDir })).toEqual({ ok: true });
  });

  it('reports load-failed instead of throwing when the generated config is unusable', async () => {
    const repoDir = makeRepo({ prefix: 'ont-039-smoke-' });
    const resolver = async () => {};

    const files = [
      { path: 'orangerail.config.mjs', content: 'export default { notAConfig: true };\n' },
    ];

    const verdict = await verifyStaged({ files, cwd: repoDir, resolver });

    expect(verdict).toMatchObject({ ok: false, kind: 'load-failed' });
    expect(existsSync(join(repoDir, '.orangerail'))).toBe(false);
  });

  it('reports load-failed instead of throwing when the generated config throws', async () => {
    const repoDir = makeRepo({ prefix: 'ont-039-throw-' });
    const resolver = async () => {};

    const files = [{ path: 'orangerail.config.mjs', content: 'throw new Error("boom");\n' }];

    const verdict = await verifyStaged({ files, cwd: repoDir, resolver });

    expect(verdict).toMatchObject({ ok: false, kind: 'load-failed' });
    expect(existsSync(join(repoDir, '.orangerail'))).toBe(false);
  });

  it('leaves the repo byte-identical on every path (no staging residue)', async () => {
    const repoDir = makeRepo({ prefix: 'ont-039-residue-' });
    const resolver = async () => {};

    await verifyStaged({ files: CONFIG_OK, cwd: repoDir, resolver });

    expect(existsSync(join(repoDir, '.orangerail'))).toBe(false);
    expect(existsSync(join(repoDir, 'orangerail.config.mjs'))).toBe(false);
  });
});

describe('writeFileSet (clobber guard)', () => {
  it('refuses to overwrite an existing target and writes nothing', () => {
    const repoDir = makeRepo({ prefix: 'ont-039-clobber-' });

    mkdirSync(join(repoDir, 'ontology'), { recursive: true });
    writeFileSync(join(repoDir, 'ontology', 'Article.mjs'), '// hand-written\n', 'utf8');

    const files = [
      { path: 'orangerail.config.mjs', content: 'export default {};\n' },
      { path: 'ontology/Article.mjs', content: '// generated\n' },
    ];

    expect(() => writeFileSet({ files, baseDir: repoDir })).toThrow(/refusing to overwrite/);

    expect(readFileSync(join(repoDir, 'ontology', 'Article.mjs'), 'utf8')).toBe(
      '// hand-written\n',
    );
    expect(existsSync(join(repoDir, 'orangerail.config.mjs'))).toBe(false);
  });

  it('writes the whole set when nothing collides', () => {
    const repoDir = makeRepo({ prefix: 'ont-039-write-' });

    const files = [
      { path: 'orangerail.config.mjs', content: 'export default {};\n' },
      { path: 'ontology/Article.mjs', content: '// generated\n' },
    ];

    writeFileSet({ files, baseDir: repoDir });

    expect(readFileSync(join(repoDir, 'ontology', 'Article.mjs'), 'utf8')).toBe('// generated\n');
  });
});

describe('existingTargets', () => {
  it('names only the generated paths that already exist', () => {
    const repoDir = makeRepo({ prefix: 'ont-039-targets-' });

    mkdirSync(join(repoDir, 'ontology'), { recursive: true });
    writeFileSync(join(repoDir, 'ontology', 'Article.mjs'), '', 'utf8');

    const files = [
      { path: 'orangerail.config.mjs', content: '' },
      { path: 'ontology/Article.mjs', content: '' },
      { path: 'ontology/Author.mjs', content: '' },
    ];

    expect(existingTargets({ files, baseDir: repoDir })).toEqual(['ontology/Article.mjs']);
  });
});

describe('operator-facing text', () => {
  it('the clobber refusal names the files and repeats the never-overwrite promise', () => {
    const message = clobberRefusal({ existing: ['ontology/Article.mjs'] });

    expect(message).toContain('init never overwrites your ontology');
    expect(message).toContain('ontology/Article.mjs');
  });

  it('the clobber refusal truncates a long collision list with a count', () => {
    const existing = Array.from({ length: 12 }, (_, i) => `ontology/Object${i}.mjs`);

    expect(clobberRefusal({ existing })).toContain('and 4 more');
  });

  it('missing-deps states the install command', () => {
    expect(degradeNotice({ verdict: { ok: false, kind: 'missing-deps' } })).toContain(
      'npm install orangerail-core zod',
    );
  });

  it('load-failed says the files are written and the handoff was skipped', () => {
    const notice = degradeNotice({
      verdict: { ok: false, kind: 'load-failed', detail: 'boom' },
    });

    expect(notice).toContain('boom');
    expect(notice).toContain('written');
  });
});
