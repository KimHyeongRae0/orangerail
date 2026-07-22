import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the browser app into `dist/app`. `base: './'` keeps every asset URL
 * relative so any static server (the CLI's node:http handler) can mount the
 * directory at `/`. `emptyOutDir` only clears `dist/app`, so the sibling
 * `tsc -p tsconfig.node.json` output at `dist/node` survives a rebuild. No
 * external/CDN resources are referenced — fonts are bundled locally (AC-9).
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
