import { readdirSync, watch, type FSWatcher } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSnapshot, type GraphSnapshot } from 'orangerail-studio/snapshot';

/** Source extensions that trigger a reload; anything else is ignored. */
const WATCH_EXTENSIONS = new Set(['.mjs', '.js', '.ts', '.cjs']);

const DEBOUNCE_MS = 150;

/**
 * Directory names never descended into. `node_modules` is the whole reason this
 * walk exists (see `collectWatchDirs`); dot-directories cover `.git`, `.docs`,
 * `.next` and friends, all of which churn constantly and hold nothing the
 * ontology imports.
 */
const IGNORED_DIR_NAMES = new Set(['node_modules']);

/**
 * Upper bound on how many directories one studio process will watch. A source
 * tree that large is not a v0 shape, and the cap is what keeps a pathological
 * project from re-creating the exhaustion this walk was written to avoid. The
 * caller is told when it bites; the watch set is never silently truncated.
 */
const MAX_WATCHED_DIRS = 512;

/**
 * Re-import the config with a cache-busting query and rebuild the snapshot.
 * The bust query defeats the ESM module cache so an edited config is actually
 * re-read (module instances leak, bounded by edit count — a dev-tool tradeoff,
 * plan Risks). Throws on a config that fails to load or lacks a registry, so
 * the caller can keep the last good snapshot.
 */
export const loadSnapshotFromConfig = async ({
  configPath,
  bust,
}: {
  configPath: string;
  bust: number;
}): Promise<GraphSnapshot> => {
  const module: unknown = await import(`${pathToFileURL(configPath).href}?v=${bust}`);
  const config = (module as { default?: { registry?: unknown } }).default;

  if (!config || !config.registry) {
    throw new Error(`config ${configPath} must default-export { registry }`);
  }

  return buildSnapshot({
    registry: config.registry as Parameters<typeof buildSnapshot>[0]['registry'],
  });
};

/**
 * Every directory under `root` that studio should watch: `root` itself plus its
 * descendants, minus `node_modules` and dot-directories, capped at
 * `MAX_WATCHED_DIRS`.
 *
 * This list exists because `fs.watch(root, { recursive: true })` — what this
 * module used to call — is not one watch on Linux. macOS and Windows hand the
 * option to the OS (FSEvents / ReadDirectoryChangesW) and pay for exactly one
 * watch; every other platform falls through to Node's own
 * `internal/fs/recursive_watch`, which walks the tree and opens a separate
 * `fs.watch` — a separate inotify watch descriptor — for every file AND every
 * directory it finds. Measured on ubuntu-latest: 3611 descriptors for a
 * 3000-file tree that macOS covered with one. `dirname(configPath)` is the
 * user's project root, so `node_modules` was in that count.
 *
 * Skipping symlinked directories keeps the walk acyclic without a visited set.
 * A directory that cannot be read is skipped rather than aborting the walk —
 * an unreadable corner of the project is not a reason to refuse to serve.
 */
export const collectWatchDirs = ({
  root,
}: {
  root: string;
}): { dirs: string[]; truncated: boolean } => {
  const dirs: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    if (dirs.length >= MAX_WATCHED_DIRS) {
      return { dirs, truncated: true };
    }

    const dir = queue.shift() as string;
    dirs.push(dir);

    let entries;

    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }

      if (entry.name.startsWith('.') || IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }

      queue.push(join(dir, entry.name));
    }
  }

  return { dirs, truncated: false };
};

/**
 * Watch the config file's directory tree and rebuild the snapshot on any
 * relevant-extension change, debounced 150ms (plan section 3.6). A reload that
 * throws keeps the last good snapshot and reports via `onError` — the server
 * never dies on a bad edit (ticket edge case). Watching stays coarse (any
 * relevant event → debounce → full reload); it does not rely on per-event
 * filenames, which differ per platform. Returns a stop function.
 *
 * The tree is covered by one NON-recursive `fs.watch` per directory from
 * `collectWatchDirs`, not by a single `{ recursive: true }` call. See that
 * function for why. Two consequences worth stating plainly:
 *
 *   - A directory created after startup is not watched by the event that
 *     created it. The debounced tick re-syncs the watch set before reloading,
 *     so a new `ontology/billing/` is picked up on the next filesystem event —
 *     one debounce late, rather than never.
 *   - Every watcher gets an `'error'` handler. `fs.watch` reports EACCES,
 *     EMFILE and ENOSPC as an `'error'` event, and an EventEmitter `'error'`
 *     with no listener throws: the old code had none, so a single unwatchable
 *     directory took the whole studio server down. Now that watcher is dropped
 *     and the rest keep serving.
 */
export const watchConfig = ({
  configPath,
  onReload,
  onError,
  onWarn = () => {},
}: {
  configPath: string;
  onReload: ({ snapshot }: { snapshot: GraphSnapshot }) => void;
  onError: ({ message }: { message: string }) => void;
  onWarn?: ({ message }: { message: string }) => void;
}): (() => void) => {
  const root = dirname(configPath);
  const watchers = new Map<string, FSWatcher>();

  let bust = 0;
  let timer: NodeJS.Timeout | undefined;
  let reloadPending = false;
  let warnedTruncated = false;

  /**
   * Directories already reported as unwatchable. A failed attach is retried on
   * every re-sync — a transient EMFILE should heal — but it is only ever
   * reported once, so a permanently unwatchable directory does not turn the
   * operator's stderr into a log of the same line at every keystroke.
   */
  const warnedDirs = new Set<string>();

  const reload = async () => {
    bust += 1;

    try {
      const snapshot = await loadSnapshotFromConfig({ configPath, bust });
      onReload({ snapshot });
    } catch (err) {
      onError({ message: err instanceof Error ? err.message : String(err) });
    }
  };

  /**
   * Bring the watcher set in line with the directories that exist right now:
   * add watchers for new directories, drop the ones whose directory is gone.
   * Called at startup and on every debounced tick.
   */
  const syncWatchers = () => {
    const { dirs, truncated } = collectWatchDirs({ root });

    if (truncated && !warnedTruncated) {
      warnedTruncated = true;
      onWarn({
        message: `more than ${MAX_WATCHED_DIRS} directories under ${root} — live reload covers the first ${MAX_WATCHED_DIRS}; edits below that are not picked up`,
      });
    }

    const wanted = new Set(dirs);

    for (const [dir, watcher] of watchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        watchers.delete(dir);
      }
    }

    for (const dir of dirs) {
      if (watchers.has(dir)) {
        continue;
      }

      try {
        const watcher = watch(dir, (_event, filename) => {
          schedule({
            relevant: !filename || WATCH_EXTENSIONS.has(extname(filename.toString())),
          });
        });

        watcher.on('error', () => {
          watcher.close();
          watchers.delete(dir);
        });

        watchers.set(dir, watcher);
        warnedDirs.delete(dir);
      } catch (err) {
        if (warnedDirs.has(dir)) {
          continue;
        }

        warnedDirs.add(dir);
        onWarn({
          message: `cannot watch ${dir} (${err instanceof Error ? err.message : String(err)}) — edits there will not reload`,
        });
      }
    }
  };

  /**
   * One debounce for both jobs. Every event re-syncs the watch set, because an
   * event on a watched directory is the only signal that a new subdirectory
   * appeared; only a relevant-extension event also reloads the snapshot.
   */
  const schedule = ({ relevant }: { relevant: boolean }) => {
    reloadPending = reloadPending || relevant;

    clearTimeout(timer);
    timer = setTimeout(() => {
      syncWatchers();

      if (reloadPending) {
        reloadPending = false;
        void reload();
      }
    }, DEBOUNCE_MS);
  };

  syncWatchers();

  return () => {
    clearTimeout(timer);

    for (const watcher of watchers.values()) {
      watcher.close();
    }

    watchers.clear();
  };
};
