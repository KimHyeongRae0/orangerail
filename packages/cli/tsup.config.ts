import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // tsup defaults `removeNodeProtocol` to true, which rewrites every
  // `node:x` import in the bundle to a bare `x`. For this package that turned
  // `node:readline/promises` into `readline/promises`, and on a Node without
  // that bare builtin the loader answers "Cannot find package 'readline'" —
  // pointing the user at an abandoned third-party package on npm. Keep the
  // prefix: it is what makes an unsupported runtime say so honestly.
  removeNodeProtocol: false,
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
