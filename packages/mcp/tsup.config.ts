import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // tsup rewrites `node:x` to bare `x` unless this is off (its default is on).
  // A bare builtin specifier can be shadowed by a real package of that name and
  // does not resolve at all on older runtimes, so the prefix has to survive the
  // bundle. See packages/cli/tsup.config.ts for the failure it caused.
  removeNodeProtocol: false,
  // This package emits ESM and CJS from one source, and `readShippedVersion`
  // resolves the manifest through `import.meta.url` — which does not exist in
  // CJS. `shims` supplies it there, so `dist/index.cjs` reports the same version
  // as `dist/index.js` instead of `unknown`. Both outputs are asserted by
  // tests/e2e/ONT-101-serverinfo-version-matches-manifest.sh.
  shims: true,
  // Workspace deps and the SDK are resolved at runtime, never inlined.
  external: ['orangerail-core', '@modelcontextprotocol/sdk'],
});
