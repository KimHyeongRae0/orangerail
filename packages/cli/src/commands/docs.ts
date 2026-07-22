import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { generateDocs } from 'orangerail-docs-gen';

import type { OrangerailConfig } from '../config';

/** The tool-owned output directory and canonical filename (§3.7 / §5.1.5). */
const DEFAULT_OUT_DIR = '.orangerail/generated';
const OUTPUT_FILENAME = 'AGENTS.md';

/**
 * `orangerail docs` — generate the agent-facing domain document into the
 * tool-owned `.orangerail/generated/` directory (§3.7). The ontology is resolved
 * via the same config path `orangerail mcp` uses, and `config.preset` is threaded
 * into `generateDocs` the same way `mcp.ts` threads it into `createMcpServer`,
 * so docs and server read one preset source. The directory is created if
 * missing and the file is overwritten in place (tool-owned, regenerate-only).
 * The written path is printed to stderr, keeping stdout clean.
 */
export const runDocs = ({
  config,
  outDir,
}: {
  config: OrangerailConfig;
  outDir?: string | undefined;
}): number => {
  const document = generateDocs({
    registry: config.registry,
    ...(config.preset ? { preset: config.preset } : {}),
  });

  const targetDir = resolve(process.cwd(), outDir ?? DEFAULT_OUT_DIR);
  mkdirSync(targetDir, { recursive: true });

  const targetPath = resolve(targetDir, OUTPUT_FILENAME);
  writeFileSync(targetPath, document, 'utf8');

  process.stderr.write(`orangerail docs: wrote ${targetPath}\n`);

  return 0;
};
