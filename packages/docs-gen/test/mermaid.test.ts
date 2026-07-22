// @vitest-environment jsdom
import { createRegistry } from 'orangerail-core';
import mermaid from 'mermaid';
import { z } from 'zod';
import { beforeAll, describe, expect, it } from 'vitest';

import { generateMermaid } from '../src/mermaid';
import { buildFixtureRegistry } from './fixture';

/**
 * Validity is proven by the real Mermaid parser under jsdom (plan §3.3 — the
 * primary path, not the pre-pinned strict-emitter fallback). `mermaid.parse`
 * throws on invalid input, so a resolving call is a pass.
 */
beforeAll(() => {
  mermaid.initialize({ startOnLoad: false });
});

const parses = async ({ source }: { source: string }): Promise<boolean> => {
  await mermaid.parse(source);
  return true;
};

describe('generateMermaid — structure (plan §3.2)', () => {
  const diagram = generateMermaid({ registry: buildFixtureRegistry() });

  it('opens a classDiagram', () => {
    expect(diagram.startsWith('classDiagram')).toBe(true);
  });

  it('renders an object as a class with typed members and optional suffixes', () => {
    expect(diagram).toContain('class product["product"] {');
    expect(diagram).toContain('price?: number');
    expect(diagram).toContain('status: string');
  });

  it('renders a link as an association carrying cardinality and a label', () => {
    expect(diagram).toContain('product "1" --> "many" internal_note : product_notes');
  });

  it('stereotypes actions and draws a governance-marked dependency to the target', () => {
    expect(diagram).toContain('class publish_product["publish_product"] {');
    expect(diagram).toContain('<<action>>');
    expect(diagram).toContain('publish_product ..> product : approval');
    expect(diagram).toContain('discount_product ..> product : approval');
  });

  it('leaves a target-less action as a standalone node (no dependency edge)', () => {
    expect(diagram).toContain('class touch_counter["touch_counter"] {');
    expect(diagram).not.toContain('touch_counter ..>');
    expect(diagram).not.toContain('sync_catalog ..>');
  });

  it('never leaks a hostile name raw — only escaped labels and sanitized IDs', () => {
    expect(diagram).not.toContain('weird "spec|al"');
    expect(diagram).toContain('weird__spec_al___object_');
    expect(diagram).toContain('#quot;');
  });
});

describe('generateMermaid — parse-backed validity (AC-5)', () => {
  it('emits a diagram the real Mermaid parser accepts (full-feature registry)', async () => {
    await expect(
      parses({ source: generateMermaid({ registry: buildFixtureRegistry() }) }),
    ).resolves.toBe(true);
  });

  it('emits a valid diagram for an empty registry', async () => {
    const empty = generateMermaid({ registry: createRegistry() });
    expect(empty).toBe('classDiagram\nnote "No object or action types are declared."');
    await expect(parses({ source: empty })).resolves.toBe(true);
  });

  it('emits a valid diagram for a hostile-only registry', async () => {
    const registry = createRegistry();
    registry.defineObject({ name: 'a"b|c`d[e]', schema: z.object({ id: z.string() }) });
    await expect(parses({ source: generateMermaid({ registry }) })).resolves.toBe(true);
  });

  it('escapes hostile FIELD names in class members (AC-7 covers members too)', async () => {
    const registry = createRegistry();
    registry.defineObject({
      name: 'doc',
      schema: z.object({ ['bad}fi"eld']: z.string() }),
    });

    const diagram = generateMermaid({ registry });
    expect(diagram).not.toContain('bad}fi"eld');
    await expect(parses({ source: diagram })).resolves.toBe(true);
  });

  it('proves the validator actually validates: a planted-broken diagram is rejected', async () => {
    // ontograph's live bug — an unescaped quote inside a class label.
    const broken = 'classDiagram\nclass weird["weird "spec" name"]\n';
    await expect(parses({ source: broken })).rejects.toBeTruthy();
  });
});
