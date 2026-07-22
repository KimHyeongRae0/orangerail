import { watch } from 'node:fs';
import { dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSnapshot, type GraphSnapshot } from 'orangerail-studio/snapshot';

/** Source extensions that trigger a reload; anything else is ignored. */
const WATCH_EXTENSIONS = new Set(['.mjs', '.js', '.ts', '.cjs']);

const DEBOUNCE_MS = 150;

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
 * Watch the config file's directory and rebuild the snapshot on any
 * relevant-extension change, debounced 150ms (plan section 3.6). A reload that
 * throws keeps the last good snapshot and reports via `onError` — the server
 * never dies on a bad edit (ticket edge case). `fs.watch` usage stays coarse
 * (any relevant event → debounce → full reload); it does not rely on per-event
 * filenames, which differ per platform. Returns a stop function.
 */
export const watchConfig = ({
  configPath,
  onReload,
  onError,
}: {
  configPath: string;
  onReload: ({ snapshot }: { snapshot: GraphSnapshot }) => void;
  onError: ({ message }: { message: string }) => void;
}): (() => void) => {
  let bust = 0;
  let timer: NodeJS.Timeout | undefined;

  const reload = async () => {
    bust += 1;

    try {
      const snapshot = await loadSnapshotFromConfig({ configPath, bust });
      onReload({ snapshot });
    } catch (err) {
      onError({ message: err instanceof Error ? err.message : String(err) });
    }
  };

  const watcher = watch(dirname(configPath), { recursive: true }, (_event, filename) => {
    if (filename && !WATCH_EXTENSIONS.has(extname(filename.toString()))) {
      return;
    }

    clearTimeout(timer);
    timer = setTimeout(() => void reload(), DEBOUNCE_MS);
  });

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
};
