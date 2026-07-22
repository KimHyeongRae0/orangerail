import { readFileSync } from 'node:fs';

import { createRegistry, type Registry } from 'orangerail-core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { generateDocs } from '../src/index';
import { buildFixtureRegistry } from './fixture';

/** Register two objects and two actions in a caller-chosen order. */
const buildOrdered = ({ order }: { order: 'ab' | 'ba' }): Registry => {
  const registry = createRegistry();

  const defineAlpha = () =>
    registry.defineObject({ name: 'alpha', schema: z.object({ id: z.string() }) });
  const defineBeta = () =>
    registry.defineObject({ name: 'beta', schema: z.object({ id: z.string() }) });
  const defineDoIt = () =>
    registry.defineAction({
      name: 'do_it',
      input: z.object({ x: z.string() }),
      execute: async () => ({}),
    });
  const defineZap = () =>
    registry.defineAction({
      name: 'zap',
      input: z.object({ y: z.string() }),
      execute: async () => ({}),
    });

  if (order === 'ab') {
    defineAlpha();
    defineBeta();
    defineDoIt();
    defineZap();
  } else {
    defineZap();
    defineDoIt();
    defineBeta();
    defineAlpha();
  }

  return registry;
};

describe('generateDocs — assembly (AC-1)', () => {
  const doc = generateDocs({ registry: buildFixtureRegistry() });

  it('carries the do-not-edit header and every required section in order', () => {
    expect(doc).toContain('DO NOT EDIT');

    const sections = [
      '# Domain ontology',
      '## How to act in this domain',
      '## Domain map',
      '## MCP tools',
      '## Object types',
      '## Link types',
      '## Action types',
    ];

    let cursor = -1;
    for (const section of sections) {
      const at = doc.indexOf(section);
      expect(at, `section present and ordered: ${section}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('embeds a fenced mermaid block', () => {
    expect(doc).toContain('```mermaid');
    expect(doc).toContain('classDiagram');
  });

  it('ends with a single trailing newline', () => {
    expect(doc.endsWith('\n')).toBe(true);
    expect(doc.endsWith('\n\n')).toBe(false);
  });
});

describe('generateDocs — determinism (AC-6)', () => {
  it('produces byte-identical output across two runs', () => {
    const a = generateDocs({ registry: buildFixtureRegistry() });
    const b = generateDocs({ registry: buildFixtureRegistry() });
    expect(a).toBe(b);
  });

  it('is stable under registration-order permutation', () => {
    const ab = generateDocs({ registry: buildOrdered({ order: 'ab' }) });
    const ba = generateDocs({ registry: buildOrdered({ order: 'ba' }) });
    expect(ab).toBe(ba);
  });

  it('produces the same doc for the same preset regardless of default vs explicit', () => {
    const implicit = generateDocs({ registry: buildFixtureRegistry() });
    const explicit = generateDocs({
      registry: buildFixtureRegistry(),
      preset: 'approval-for-writes',
    });
    expect(implicit).toBe(explicit);
  });
});

describe('AC-9 — runtime dependency guard', () => {
  it('depends on orangerail-core ONLY (no mcp, no transport, no LLM SDK)', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['orangerail-core']);
  });
});
