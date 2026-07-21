import { createMcpServer } from 'orangerail-mcp';

import type { OrangerailConfig } from '../config';

/**
 * `orangerail mcp` — launch the governed MCP server over stdio (§3.4). Once
 * connected, the stdio transport keeps the process alive; the caller (a human
 * or an MCP client) ends the session by closing stdin. Never resolves under
 * normal operation.
 */
export const runMcp = async ({ config }: { config: OrangerailConfig }): Promise<void> => {
  const { serve } = createMcpServer({
    registry: config.registry,
    store: config.store,
    ...(config.resolveIdentity ? { resolveIdentity: config.resolveIdentity } : {}),
    ...(config.preset ? { preset: config.preset } : {}),
    ...(config.redactAudit ? { redactAudit: config.redactAudit } : {}),
  });

  await serve();
};
