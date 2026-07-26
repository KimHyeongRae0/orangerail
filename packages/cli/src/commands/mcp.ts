import { createMcpServer } from 'orangerail-mcp';

import type { OrangerailConfig } from '../config';
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
