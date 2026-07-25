import { spawn } from 'node:child_process';

import {
  buildSnapshot,
  studioAppDir,
  type AgentFleetSnapshot,
  type InstanceSnapshot,
} from 'orangerail-studio/snapshot';

import type { OrangerailConfig } from '../../config';
import { resolveConfigPath } from '../../config';
import { gatherFleet } from './fleet';
import { gatherInstances } from './instances';
import { createStudioServer } from './server';
import { watchConfig } from './watch';

/** The default studio port (plan section 3.6). */
export const DEFAULT_STUDIO_PORT = 4820;

/**
 * Best-effort platform browser open, fire-and-forget. Any failure (headless CI,
 * missing opener) is swallowed — auto-open must never kill the server (ticket
 * edge case). `--no-open` skips this entirely (agent/CI parity, plan 3.6).
 */
const openBrowser = ({ url }: { url: string }) => {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
};

/**
 * `orangerail studio` — serve the prebuilt studio app plus the registry data and
 * an SSE stream from a local node:http server bound to 127.0.0.1 (plan 3.6).
 * The ontology is resolved through the same loader `mcp`/`docs` use (a config
 * that fails to load already exited non-zero in main.ts, AC-2). A busy port
 * fails fast and non-zero; a bad live edit keeps the last good snapshot. The
 * server keeps the event loop alive, exactly like `mcp`.
 */
export const runStudio = async ({
  config,
  configPath,
  port,
  open,
}: {
  config: OrangerailConfig;
  configPath?: string | undefined;
  port: number;
  open: boolean;
}): Promise<number> => {
  const resolvedConfigPath = resolveConfigPath({ configPath });

  let snapshot = buildSnapshot({ registry: config.registry });
  let instances: InstanceSnapshot = await gatherInstances({
    registry: config.registry,
    configPath: resolvedConfigPath,
  });
  let fleet: AgentFleetSnapshot = gatherFleet({ configPath: resolvedConfigPath });

  const { server, broadcast } = createStudioServer({
    appDir: studioAppDir(),
    getSnapshot: () => snapshot,
    getInstances: () => instances,
    getFleet: () => fleet,
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `orangerail studio: port ${port} is already in use — pass --port <n> to pick another\n`,
      );
    } else {
      process.stderr.write(`orangerail studio: server error — ${err.message}\n`);
    }

    process.exit(1);
  });

  let stopWatch = (): void => {};

  await new Promise<void>((resolveListen) => {
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`;
      process.stderr.write(`orangerail studio: serving on ${url}\n`);

      stopWatch = watchConfig({
        configPath: resolvedConfigPath,
        onReload: ({ snapshot: next }) => {
          snapshot = next;

          // Re-gather instances on a live edit. The resolvers read the emitted
          // `data/*.json` fresh on each call, so re-running the gather with the
          // original registry picks up edited instance/edge files; a failing
          // gather keeps the last good instance snapshot.
          void gatherInstances({ registry: config.registry, configPath: resolvedConfigPath })
            .then((next) => {
              instances = next;
            })
            .catch(() => {});

          // The fleet manifest lives in `data/fleet.json` beside the config; a
          // live edit re-derives it (pure, synchronous). A bad file keeps the
          // last good fleet snapshot.
          fleet = gatherFleet({ configPath: resolvedConfigPath });

          broadcast({ event: 'change', data: '1' });
        },
        onError: ({ message }) => {
          // ONT-016 L-SSE-PATHLEAK: the detailed message (which carries the
          // absolute config path) stays on the operator's own stderr; the SSE
          // client receives only a generic signal with no path (the client
          // discards the data and merely flips a banner — App.tsx).
          process.stderr.write(`orangerail studio: reload failed — ${message}\n`);
          broadcast({ event: 'reload-error', data: '1' });
        },
      });

      if (open) {
        openBrowser({ url });
      }

      resolveListen();
    });
  });

  const shutdown = () => {
    stopWatch();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return 0;
};
