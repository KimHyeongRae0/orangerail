import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // Workspace deps and the SDK are resolved at runtime, never inlined.
  external: ['orangerail-core', '@modelcontextprotocol/sdk'],
});
