import { describe, expect, it } from 'vitest';

import { emitConfigFile, emitRegistryFile } from './emit-config';

describe('emitConfigFile', () => {
  it('self-discovers ontology/*.mjs and wires the file store under .orangerail/store', () => {
    const { content, filename } = emitConfigFile({ preset: 'approval-for-writes' });

    expect(filename).toBe('orangerail.config.mjs');
    expect(content).toContain('readdirSync(ontologyDir)');
    expect(content).toContain("name.endsWith('.mjs')");
    expect(content).toContain("createFileStore({ dir: join(here, '.orangerail', 'store') })");
    expect(content).toContain('preset: "approval-for-writes"');
    // config never lands the store under the byte-compared generated dir
    expect(content).not.toContain("'.orangerail', 'generated'");
  });

  it('is deterministic for a given preset', () => {
    expect(emitConfigFile({ preset: 'readonly' }).content).toBe(
      emitConfigFile({ preset: 'readonly' }).content,
    );
  });
});

describe('emitRegistryFile', () => {
  it('exports a single shared registry instance', () => {
    const { content, filename } = emitRegistryFile();

    expect(filename).toBe('_registry.mjs');
    expect(content).toContain('export const registry = createRegistry();');
  });
});
