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
  // tsup rewrites `node:x` to bare `x` unless this is off (its default is on).
  // A bare builtin specifier can be shadowed by a real package of that name and
  // does not resolve at all on older runtimes, so the prefix has to survive the
  // bundle. See packages/cli/tsup.config.ts for the failure it caused.
  removeNodeProtocol: false,
  external: ['orangerail-core'],
});
