import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore, createRegistry } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runDocs } from '../src/commands/docs';
import type { OrangerailConfig } from '../src/config';

const buildConfig = ({
  preset,
}: { preset?: OrangerailConfig['preset'] } = {}): OrangerailConfig => {
  const registry = createRegistry();

  registry.defineObject({
    name: 'product',
    schema: z.object({ id: z.string() }),
    resolve: { get: async ({ id }) => ({ id }) },
  });

  registry.defineAction({
    name: 'publish_product',
    input: z.object({ productId: z.string() }),
    policy: { approval: 'required', roles: ['editor'] },
    execute: async () => ({ ok: true }),
  });

  return { registry, store: createMemoryStore(), ...(preset ? { preset } : {}) };
};

describe('orangerail docs command (§3.7)', () => {
  it('writes AGENTS.md into the given out dir with the do-not-edit header and returns 0', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ont-004-cli-'));
    const code = runDocs({ config: buildConfig(), outDir });

    expect(code).toBe(0);

    const written = readFileSync(join(outDir, 'AGENTS.md'), 'utf8');
    expect(written).toContain('DO NOT EDIT');
    expect(written).toContain('# Domain ontology');
    expect(written).toContain('publish_product');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('threads config.preset into the generated document', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ont-004-cli-'));
    runDocs({ config: buildConfig({ preset: 'readonly' }), outDir });

    const written = readFileSync(join(outDir, 'AGENTS.md'), 'utf8');
    expect(written).toContain('[not exposed — readonly preset]');
    expect(written).toContain('read-only');
  });

  it('regenerates in place (overwrites an existing file)', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ont-004-cli-'));
    runDocs({ config: buildConfig(), outDir });
    const first = readFileSync(join(outDir, 'AGENTS.md'), 'utf8');

    runDocs({ config: buildConfig(), outDir });
    const second = readFileSync(join(outDir, 'AGENTS.md'), 'utf8');

    expect(second).toBe(first);
  });
});
