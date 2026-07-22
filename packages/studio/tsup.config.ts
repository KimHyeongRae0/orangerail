import { defineConfig } from 'tsup';

/**
 * Builds the node-consumable snapshot entry into `dist/node` (the browser app
 * is built separately by Vite into `dist/app`). Bundling with esbuild avoids
 * the extension friction of a raw `tsc` NodeNext emit and matches the other
 * packages' build. `clean` only clears `dist/node`, so the Vite output at
 * `dist/app` survives. `orangerail-core` is resolved at runtime, never inlined.
 */
export default defineConfig({
  entry: ['src/snapshot/index.ts'],
  outDir: 'dist/node',
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['orangerail-core'],
});
