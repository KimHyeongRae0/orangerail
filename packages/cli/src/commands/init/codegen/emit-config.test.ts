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
    // Local scaffold opts in to dev mode (ONT-014 secure default): with no
    // adapter the server would otherwise deny every caller.
    expect(content).toContain('allowDevMode: true');
    // config never lands the store under the byte-compared generated dir
    expect(content).not.toContain("'.orangerail', 'generated'");
  });

  /**
   * ONT-066 — `dir` is the whole store-location mechanism and this file is the
   * only place it is written down, so the alternative belongs at the call, not
   * only in a doc the operator may never open.
   */
  it('carries the relocation as a commented one-liner at the createFileStore call', () => {
    const { content } = emitConfigFile({ preset: 'approval-for-writes' });
    const lines = content.split('\n');
    const live = lines.findIndex((line) =>
      line.startsWith('const store = createFileStore({ dir: join(here,'),
    );

    expect(live).toBeGreaterThan(-1);
    expect(lines[live + 1]).toBe(
      "// const store = createFileStore({ dir: '/var/lib/orangerail/store' });",
    );

    // The comment above it states the exposure and the bound of the remedy: the
    // chain is named as a report AFTER the write, never as the thing that stops
    // it, because that is what it is.
    const preamble = lines.slice(0, live).join('\n');
    expect(preamble).toContain('The store below is INSIDE this project');
    expect(preamble).toContain('approvals.jsonl');
    expect(preamble).toContain('it is a report, not a gate');
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
