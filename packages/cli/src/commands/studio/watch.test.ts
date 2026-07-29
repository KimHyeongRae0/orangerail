import type * as nodeFs from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { collectWatchDirs, loadSnapshotFromConfig, watchConfig } from './watch';

const EMPTY_CONFIG =
  'export default { registry: { listObjects: () => [], listLinks: () => [], listActions: () => [] } };';

const ONE_OBJECT_CONFIG =
  "export default { registry: { listObjects: () => [{ name: 'thing', schema: {}, readAccess: 'authenticated' }], listLinks: () => [], listActions: () => [] } };";

describe('loadSnapshotFromConfig (plan section 3.6 — cache-busted re-import)', () => {
  it('loads a snapshot from a config module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-005-watch-'));
    const path = join(dir, 'config.mjs');
    writeFileSync(path, EMPTY_CONFIG, 'utf8');

    const snapshot = await loadSnapshotFromConfig({ configPath: path, bust: 1 });
    expect(snapshot).toEqual({ objects: [], links: [], actions: [] });
  });

  it('reflects each config file content in its snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-005-watch-'));

    const emptyPath = join(dir, 'empty.mjs');
    writeFileSync(emptyPath, EMPTY_CONFIG, 'utf8');
    const first = await loadSnapshotFromConfig({ configPath: emptyPath, bust: 1 });
    expect(first.objects).toHaveLength(0);

    // Cache-busting under the real Node runtime is proven end-to-end by the
    // e2e live-reload phase; here a distinct file proves content is read back.
    const onePath = join(dir, 'one.mjs');
    writeFileSync(onePath, ONE_OBJECT_CONFIG, 'utf8');
    const second = await loadSnapshotFromConfig({ configPath: onePath, bust: 1 });
    expect(second.objects.map((o) => o.name)).toEqual(['thing']);
  });

  it('throws on a config without a registry (so the watcher keeps the last snapshot)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-005-watch-'));
    const path = join(dir, 'config.mjs');
    writeFileSync(path, 'export default { nope: true };', 'utf8');

    await expect(loadSnapshotFromConfig({ configPath: path, bust: 1 })).rejects.toThrow(/registry/);
  });
});

/** A project tree shaped like the one `orangerail init` scaffolds. */
const scaffold = ({ nodeModulePackages = 3 }: { nodeModulePackages?: number } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'ont-052-'));
  const configPath = join(root, 'orangerail.config.mjs');
  writeFileSync(configPath, EMPTY_CONFIG, 'utf8');

  mkdirSync(join(root, 'ontology'));
  writeFileSync(join(root, 'ontology', 'Article.mjs'), 'export default {};', 'utf8');
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'fleet.json'), '{}', 'utf8');

  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.git', 'objects'));
  mkdirSync(join(root, 'node_modules'));

  for (let i = 0; i < nodeModulePackages; i += 1) {
    mkdirSync(join(root, 'node_modules', `pkg-${i}`));
    mkdirSync(join(root, 'node_modules', `pkg-${i}`, 'dist'));
  }

  return { root, configPath };
};

const waitFor = async ({
  predicate,
  timeoutMs = 3000,
  intervalMs = 25,
  onPoll = () => {},
}: {
  predicate: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
  onPoll?: ({ tick }: { tick: number }) => void;
}) => {
  const deadline = Date.now() + timeoutMs;
  let tick = 0;

  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }

    tick += 1;
    onPoll({ tick });

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
};

describe('collectWatchDirs (ONT-052 — the Linux recursive-watch blowup)', () => {
  it('covers the source tree but never descends into node_modules or dot-directories', () => {
    const { root } = scaffold({ nodeModulePackages: 50 });

    const { dirs, truncated } = collectWatchDirs({ root });

    expect(truncated).toBe(false);
    expect(new Set(dirs)).toEqual(new Set([root, join(root, 'ontology'), join(root, 'data')]));
    expect(dirs.some((dir) => dir.includes('node_modules'))).toBe(false);
    expect(dirs.some((dir) => dir.includes('.git'))).toBe(false);
  });

  it('does not follow a symlinked directory (no cycle, no escape from the project)', () => {
    const { root } = scaffold();
    const outside = mkdtempSync(join(tmpdir(), 'ont-052-outside-'));
    mkdirSync(join(outside, 'deep'));
    symlinkSync(outside, join(root, 'linked'), 'dir');
    symlinkSync(root, join(root, 'ontology', 'loop'), 'dir');

    const { dirs } = collectWatchDirs({ root });

    expect(dirs.some((dir) => dir.includes('linked'))).toBe(false);
    expect(dirs.some((dir) => dir.includes('loop'))).toBe(false);
  });

  it('reports truncation rather than opening an unbounded number of watches', () => {
    const root = mkdtempSync(join(tmpdir(), 'ont-052-wide-'));

    for (let i = 0; i < 600; i += 1) {
      mkdirSync(join(root, `dir-${i}`));
    }

    const { dirs, truncated } = collectWatchDirs({ root });

    expect(truncated).toBe(true);
    expect(dirs).toHaveLength(512);
  });

  it('skips a directory it cannot read instead of aborting the whole walk', () => {
    const { root } = scaffold();
    const blocked = join(root, 'blocked');
    mkdirSync(blocked);
    mkdirSync(join(blocked, 'child'));
    chmodSync(blocked, 0o000);

    try {
      const { dirs } = collectWatchDirs({ root });

      expect(dirs).toContain(join(root, 'ontology'));
      expect(dirs).not.toContain(join(blocked, 'child'));
    } finally {
      chmodSync(blocked, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('watchConfig (ONT-052 — no recursive watch, no fatal watch error)', () => {
  /**
   * Load `./watch` against a `node:fs` whose `watch` is `fake`. The module takes
   * `watch` as a named ESM import, so a spy on the namespace object does not
   * reach it — the module has to be re-evaluated against a mocked `node:fs`.
   */
  const withFakeWatch = async ({ fake }: { fake: typeof nodeFs.watch }) => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof nodeFs>('node:fs');

      return { ...actual, default: actual, watch: fake };
    });

    return import('./watch');
  };

  const restoreWatch = () => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  };

  it('reloads on an edit to a file in a subdirectory of the config directory', async () => {
    const { root, configPath } = scaffold();
    const reloads: number[] = [];

    const errors: string[] = [];

    const stop = watchConfig({
      configPath,
      onReload: () => reloads.push(Date.now()),
      onError: ({ message }) => errors.push(message),
    });

    try {
      // The edit is repeated until the reload lands. This is the one assertion
      // in the suite that goes through the real OS watcher, and how quickly a
      // given kernel reports a given write is not what is under test — that a
      // write inside a subdirectory reaches the reload path at all is. A single
      // write plus a fixed deadline is how this assertion turns flaky.
      const seen = await waitFor({
        predicate: () => reloads.length > 0,
        timeoutMs: 10000,
        onPoll: ({ tick }) =>
          writeFileSync(
            join(root, 'ontology', 'Article.mjs'),
            `export default { v: ${tick} };`,
            'utf8',
          ),
        intervalMs: 200,
      });

      expect(seen).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      stop();
    }
  }, 20000);

  it('re-syncs the watch set so a directory created after startup gets watched', async () => {
    const { root, configPath } = scaffold();
    const watched: string[] = [];
    const callbacks = new Map<string, (event: string, filename: string) => void>();

    // The event delivery itself is driven here rather than by the OS: whether
    // macOS reports a new subdirectory on the parent's watcher within any given
    // millisecond is not what this test is about, and racing it is how a gate
    // turns flaky. What is under test is that the debounced tick re-walks and
    // attaches to a directory that did not exist at startup.
    const { watchConfig: isolated } = await withFakeWatch({
      fake: ((path: string, listener: (event: string, filename: string) => void) => {
        watched.push(path);
        callbacks.set(path, listener);

        const emitter = new EventEmitter() as EventEmitter & { close: () => void };
        emitter.close = () => {};

        return emitter;
      }) as unknown as typeof nodeFs.watch,
    });

    try {
      const stop = isolated({ configPath, onReload: () => {}, onError: () => {} });

      expect(watched).toContain(join(root, 'ontology'));
      expect(watched).not.toContain(join(root, 'ontology', 'billing'));

      mkdirSync(join(root, 'ontology', 'billing'));
      callbacks.get(join(root, 'ontology'))?.('rename', 'billing');

      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(watched).toContain(join(root, 'ontology', 'billing'));

      stop();
    } finally {
      restoreWatch();
    }
  });

  // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM is the error Node raised for a
  // recursive watch on Linux before 19.1.0. It is unreachable on anything this
  // package supports (engines.node >= 20) and this module no longer asks for a
  // recursive watch at all — but a watch can still fail for reasons the
  // operator did not cause, and every one of them used to be fatal.
  it.each([
    ['ENOSPC', 'ENOSPC: System limit for number of file watchers reached'],
    ['EACCES', 'EACCES: permission denied'],
    ['EMFILE', 'EMFILE: too many open files'],
    ['ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'The feature watch recursively is unavailable'],
  ])('warns and keeps serving when a watch fails with %s', async (code, message) => {
    const { configPath } = scaffold();
    const warnings: string[] = [];

    const { watchConfig: isolated } = await withFakeWatch({
      fake: (() => {
        throw Object.assign(new Error(message), { code });
      }) as unknown as typeof nodeFs.watch,
    });

    try {
      const stop = isolated({
        configPath,
        onReload: () => {},
        onError: () => {},
        onWarn: ({ message: warning }) => warnings.push(warning),
      });

      stop();
    } finally {
      restoreWatch();
    }

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain(message);
    expect(warnings[0]).toMatch(/will not reload/);
  });

  it('drops a watcher that errors after start instead of taking the process down', async () => {
    const { configPath } = scaffold();
    const emitters: EventEmitter[] = [];

    const { watchConfig: isolated } = await withFakeWatch({
      fake: (() => {
        const emitter = new EventEmitter() as EventEmitter & { close: () => void };
        emitter.close = () => {};
        emitters.push(emitter);

        return emitter;
      }) as unknown as typeof nodeFs.watch,
    });

    try {
      const stop = isolated({ configPath, onReload: () => {}, onError: () => {} });

      // Before ONT-052 there was no 'error' listener at all, so this line threw
      // out of the emit and killed the studio server.
      expect(() => {
        for (const emitter of emitters) {
          emitter.emit('error', new Error('watch died'));
        }
      }).not.toThrow();

      stop();
    } finally {
      restoreWatch();
    }

    expect(emitters.length).toBeGreaterThan(0);
  });

  it('never asks fs.watch for a recursive watch (the Linux per-entry walker is never selected)', async () => {
    const { configPath } = scaffold();
    const options: unknown[] = [];

    const { watchConfig: isolated } = await withFakeWatch({
      fake: ((_path: string, ...rest: unknown[]) => {
        options.push(rest[0]);

        const emitter = new EventEmitter() as EventEmitter & { close: () => void };
        emitter.close = () => {};

        return emitter;
      }) as unknown as typeof nodeFs.watch,
    });

    try {
      const stop = isolated({ configPath, onReload: () => {}, onError: () => {} });
      stop();
    } finally {
      restoreWatch();
    }

    expect(options.length).toBeGreaterThan(0);
    expect(
      options.some(
        (option) => typeof option === 'object' && option !== null && 'recursive' in option,
      ),
    ).toBe(false);
  });

  it('stops cleanly and stops reloading', async () => {
    const { root, configPath } = scaffold();
    const reloads: number[] = [];

    const stop = watchConfig({
      configPath,
      onReload: () => reloads.push(Date.now()),
      onError: () => {},
    });

    stop();
    writeFileSync(join(root, 'ontology', 'Article.mjs'), 'export default { v: 3 };', 'utf8');

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(reloads).toHaveLength(0);
  });
});
