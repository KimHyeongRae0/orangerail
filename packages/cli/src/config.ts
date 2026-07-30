import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RedactAudit, RedactPrior, Registry, ResolveIdentity, Store } from 'orangerail-core';
import type { HostApprovalPrompt, McpPreset } from 'orangerail-mcp';

/**
 * The shape a user's `orangerail.config.mjs` must default-export. `registry` and
 * `store` are required; the rest are optional hooks (§3.4).
 */
export interface OrangerailConfig {
  registry: Registry;
  store: Store;
  resolveIdentity?: ResolveIdentity;
  preset?: McpPreset;
  redactAudit?: RedactAudit;
  /**
   * Mask the PRIOR target row on audit records and in the approver's view
   * (§3.11). A separate hook from `redactAudit` because a row is not an input:
   * it carries columns no input mentions, so an input-shaped mask would publish
   * them. Configure `redactAudit` without this and the row is withheld rather
   * than half-masked.
   */
  redactPrior?: RedactPrior;
  /**
   * Opt in to dev mode on the MCP server when there is no `resolveIdentity`
   * adapter (§3.3 / AC-4). The server defaults to a secure `false`; a local
   * operator sets this in `orangerail.config.mjs` to restore the `local-dev`
   * all-roles identity for a no-adapter run. A typed config field, never an env
   * flag (zero `process.env` reads preserved).
   */
  allowDevMode?: boolean;
  /**
   * Ask the agent host to run its OWN permission prompt for some action tools
   * (ONT-048). Defaults to `'off'`. A config field rather than a flag, exactly
   * like `preset` — `--preset` belongs to `init` and selects what gets
   * generated, not how a running server behaves.
   *
   * This is a hint the client enforces. It composes with orangerail's gate; it
   * is never what makes that gate hold.
   */
  hostApprovalPrompt?: HostApprovalPrompt;
}

/**
 * Config filenames every command discovers, in resolution order — the single
 * list `init`'s front door and `resolveConfigPath` both read, so a name one of
 * them honors can never read as "not initialized" to the other.
 *
 * `.mjs` stays first (it is what `init` generates). The TypeScript names are
 * discovered because the docs promise they work through the user's own
 * TS-capable runtime; leaving them out let `init` regenerate over the ontology
 * of anyone who had migrated to one.
 */
export const DEFAULT_CONFIG_NAMES = [
  'orangerail.config.mjs',
  'orangerail.config.js',
  'orangerail.config.ts',
  'orangerail.config.mts',
];

/**
 * Load the ontology config via plain dynamic `import()` (§3.4 — no loader
 * dependency). `--config <path>` wins; otherwise the first default name in the
 * cwd is used. TypeScript configs work through the user's own TS-capable
 * runtime (tsx / node --experimental-strip-types), documented, not bundled.
 *
 * NOTE: loading a config is arbitrary code execution — the same trust level as
 * an npm script. This is inherent to a local-first tool (no network exposure;
 * v0 is stdio only).
 */
/**
 * Resolve the absolute path of the config file `loadConfig` would import, with
 * the same diagnostics (`--config` wins; otherwise the first default name in
 * the cwd). Extracted so long-running commands (`studio`) can watch the exact
 * file being loaded without re-deriving the resolution rule.
 */
export const resolveConfigPath = ({ configPath }: { configPath?: string | undefined }): string => {
  const chosen =
    configPath ?? DEFAULT_CONFIG_NAMES.find((name) => existsSync(resolve(process.cwd(), name)));

  if (chosen === undefined) {
    throw new Error(
      'no orangerail config found — pass --config <path> or add orangerail.config.mjs to the working directory',
    );
  }

  const absolute = resolve(process.cwd(), chosen);
  if (!existsSync(absolute)) {
    throw new Error(`config not found: ${absolute}`);
  }

  return absolute;
};

export const loadConfig = async ({
  configPath,
}: {
  configPath?: string | undefined;
}): Promise<OrangerailConfig> => {
  const absolute = resolveConfigPath({ configPath });

  const module: unknown = await import(pathToFileURL(absolute).href);
  const config = (module as { default?: OrangerailConfig }).default;

  if (!config || !config.registry || !config.store) {
    throw new Error(`config ${absolute} must default-export { registry, store }`);
  }

  return config;
};
