import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // A CLI bin: keep the node shebang, resolve workspace deps at runtime.
  banner: { js: '#!/usr/bin/env node' },
  external: [
    'orangerail-core',
    'orangerail-docs-gen',
    'orangerail-mcp',
    'orangerail-studio',
    'orangerail-studio/snapshot',
    '@modelcontextprotocol/sdk',
  ],
});
