import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * The skew check must survive the core it exists to diagnose (ONT-058).
 *
 * The first version of `core-skew.ts` reached the mark through
 * `import { inspectCoreInstance } from 'orangerail-core'`. Every in-process
 * test passed, because they all built objects by hand and never linked against
 * anything old. CI did not: `ONT-039-cli-init-pnpm-and-clobber` installs the
 * SHIPPED CLI beside `orangerail-core@0.1.0`, ESM failed the module at LINK
 * time with `does not provide an export named 'inspectCoreInstance'`, and the
 * whole binary died before a single command ran — against precisely the
 * configuration the check was written to explain.
 *
 * So this suite does what the others could not: it crosses a real module
 * boundary. It writes a real `orangerail-core` package that exports neither the
 * marker key nor any reader, puts the real `core-skew.ts` source next to it,
 * and runs it under real Node. A named import of anything ONT-058 added fails
 * here the way it failed in CI.
 *
 * That coverage has to live here. ONT-039 is being pinned to matched workspace
 * versions by ONT-057 — correctly, since that scenario means to assert
 * `NODE_PATH` resolution and not a cross-package version match — and once it
 * is, nothing else in the suite runs this CLI against an older core.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A project directory holding a fake `orangerail-core` and the REAL
 * `core-skew.ts` beside it, so Node resolves the bare specifier to the fake.
 *
 * `stamps` decides whether the fake's `createRegistry` marks what it returns.
 * Either way the package exports nothing ONT-058 introduced — that is the
 * property under test. It writes the mark with a bare `Symbol.for` literal,
 * which is exactly how a second copy of a real core would do it: the global
 * symbol registry is what lets two copies agree on a key with no import
 * between them.
 */
const scaffold = ({ stamps }: { stamps: boolean }): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ont-058-resolution-'));
  dirs.push(dir);

  // `"type": "module"` matters: the shipped CLI is ESM, and it is ESM that
  // fails a missing named import at LINK time. Without this the runner would
  // transpile to CJS and the same defect would surface as a late TypeError —
  // a weaker reproduction of a different failure.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', type: 'module' }));

  const pkg = join(dir, 'node_modules', 'orangerail-core');
  mkdirSync(pkg, { recursive: true });

  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'orangerail-core',
      version: '0.1.0',
      type: 'module',
      exports: './index.js',
    }),
  );

  // The 0.1.0 public surface this module is allowed to depend on, and nothing
  // else. No CORE_INSTANCE_KEY, no markCoreInstance, no inspectCoreInstance.
  writeFileSync(
    join(pkg, 'index.js'),
    [
      "const TOKEN = Object.freeze({ package: 'orangerail-core' });",
      '',
      'export const createRegistry = () => {',
      '  const registry = { listActions: () => [], listObjects: () => [], listLinks: () => [] };',
      stamps
        ? "  Object.defineProperty(registry, Symbol.for('orangerail.coreInstance'), { value: TOKEN, enumerable: false });"
        : '  // 0.1.0 stamped nothing.',
      '  return registry;',
      '};',
      '',
      'export const createMemoryStore = () => ({});',
      '',
    ].join('\n'),
  );

  // The real source, verbatim. Its only other import is `import type`, which
  // tsx erases, so the file stands alone here exactly as it does in the bundle.
  copyFileSync(join(here, '..', 'src', 'core-skew.ts'), join(dir, 'core-skew.ts'));

  writeFileSync(
    join(dir, 'probe.mjs'),
    [
      "import { coreSkewNotice, reviewCoreSkew } from './core-skew.ts';",
      '',
      '// A config whose own core stamped nothing — a 0.1.0 project.',
      'const legacyConfig = { registry: { listActions: () => [] }, store: {} };',
      'const review = reviewCoreSkew({ config: legacyConfig });',
      '',
      'process.stdout.write(JSON.stringify({',
      '  state: review.state,',
      '  notice: coreSkewNotice({ review }),',
      '}));',
      '',
    ].join('\n'),
  );

  return dir;
};

/** Run the probe under real Node, returning what it printed. */
const probe = ({ dir }: { dir: string }): { state: string; notice: string } => {
  const stdout = execFileSync(tsx, [join(dir, 'probe.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return JSON.parse(stdout) as { state: string; notice: string };
};

describe('core skew — linking against a stale orangerail-core (ONT-058)', () => {
  it('reports `stale` through a core that exports no marker and no reader', () => {
    // The regression. Pre-fix this throws before the first statement runs:
    //   SyntaxError: The requested module 'orangerail-core' does not provide
    //   an export named 'inspectCoreInstance'
    const result = probe({ dir: scaffold({ stamps: true }) });

    expect(result.state).toBe('stale');
    expect(result.notice).toContain('CORE VERSION SKEW');
  }, 30_000);

  it('degrades to a silent verdict when this CLI’s own core is the old one', () => {
    // The ONT-039 shape: the shipped CLI installed beside orangerail-core@0.1.0,
    // so BOTH sides are unmarked. Nothing to compare, nothing broken (a core
    // with no marker also has no inputHash enforcement), and above all — the
    // process must still run.
    const result = probe({ dir: scaffold({ stamps: false }) });

    expect(result.state).toBe('unverifiable');
    expect(result.notice).toBe('');
  }, 30_000);
});
