import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Resolve workspace deps to source so unit tests never depend on prior
 * `orangerail-core` / `orangerail-mcp` builds (verify runs `test` before `build`).
 */
export default defineConfig({
  resolve: {
    alias: {
      'orangerail-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      'orangerail-docs-gen': fileURLToPath(new URL('../docs-gen/src/index.ts', import.meta.url)),
      'orangerail-mcp': fileURLToPath(new URL('../mcp/src/index.ts', import.meta.url)),
      'orangerail-studio/snapshot': fileURLToPath(
        new URL('../studio/src/snapshot/index.ts', import.meta.url),
      ),
    },
  },
});
