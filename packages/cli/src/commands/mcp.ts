import { createMcpServer } from 'orangerail-mcp';

import type { OrangerailConfig } from '../config';
import {
  heartbeatPathForStore,
  startServerHeartbeat,
  type HeartbeatHandle,
} from '../server-heartbeat';
import { computeStatus, formatStatusLine } from './status';

/**
 * `orangerail mcp` — launch the governed MCP server over stdio (§3.4). Once
 * connected, the stdio transport keeps the process alive; the caller (a human
 * or an MCP client) ends the session by closing stdin. Never resolves under
 * normal operation.
 *
 * Before serving, write a one-line confidence signal to STDERR (stdout is the
 * JSON-RPC channel): proof that governance is wired and the audit chain
 * verifies. It answers a first-run operator's "is this actually protecting me?"
 * without a live dashboard, and surfaces a broken chain loudly.
 */
export const runMcp = async ({ config }: { config: OrangerailConfig }): Promise<void> => {
  const report = await computeStatus({ config });

  // Publish a liveness heartbeat FIRST, so the `serving` line we print next is
  // backed by a real on-disk heartbeat a concurrent `orangerail status` can
  // already observe — not just a hopeful claim. A no-op path (a non-file store
  // has no shared on-disk location) leaves `status` reporting "not detected"
  // honestly. Cleanup is registered once, best-effort, and stops the refresh
  // timer + removes the file on any terminating signal or a normal exit so a
  // clean shutdown never lingers as "stale".
  const heartbeatPath = heartbeatPathForStore({ store: config.store });
  const heartbeat: HeartbeatHandle | null =
    heartbeatPath === null ? null : startServerHeartbeat({ path: heartbeatPath });

  if (heartbeat) {
    const shutdown = ({ signal }: { signal: NodeJS.Signals }): void => {
      heartbeat.stop();
      process.kill(process.pid, signal);
    };

    process.once('exit', () => heartbeat.stop());
    process.once('SIGINT', () => shutdown({ signal: 'SIGINT' }));
    process.once('SIGTERM', () => shutdown({ signal: 'SIGTERM' }));
  }

  process.stderr.write(`${formatStatusLine({ report })}\n`);

  const { serve } = createMcpServer({
    registry: config.registry,
    store: config.store,
    ...(config.resolveIdentity ? { resolveIdentity: config.resolveIdentity } : {}),
    ...(config.preset ? { preset: config.preset } : {}),
    ...(config.redactAudit ? { redactAudit: config.redactAudit } : {}),
    ...(config.allowDevMode ? { allowDevMode: config.allowDevMode } : {}),
  });

  await serve();
};
