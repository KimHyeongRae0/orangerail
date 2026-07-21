import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Resolve the workspace dep to source so unit tests never depend on a prior
 * `orangerail-core` build (verify runs `test` before `build`).
 */
export default defineConfig({
  resolve: {
    alias: {
      'orangerail-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
});
