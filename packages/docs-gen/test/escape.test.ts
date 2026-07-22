import { describe, expect, it } from 'vitest';

import {
  createIdAllocator,
  escapeInline,
  escapeMermaidLabel,
  escapeTableCell,
} from '../src/escape';

describe('escapeTableCell', () => {
  it('escapes pipes so a cell cannot start a new column', () => {
    expect(escapeTableCell({ value: 'a|b' })).toBe('a\\|b');
  });

  it('escapes backslashes before pipes (no double-escape)', () => {
    expect(escapeTableCell({ value: 'a\\|b' })).toBe('a\\\\\\|b');
  });

  it('collapses newlines to a space so a row stays on one line', () => {
    expect(escapeTableCell({ value: 'a\nb' })).toBe('a b');
    expect(escapeTableCell({ value: 'a\r\nb' })).toBe('a b');
  });

  it('escapes backticks so a cell cannot open a code span', () => {
    expect(escapeTableCell({ value: 'a`b' })).toBe('a\\`b');
  });

  it('entity-escapes HTML angle brackets (AC-7)', () => {
    expect(escapeTableCell({ value: '<script>x</script>' })).toBe('&lt;script&gt;x&lt;/script&gt;');
  });

  it('leaves a plain identifier untouched', () => {
    expect(escapeTableCell({ value: 'product_get' })).toBe('product_get');
  });
});

describe('escapeInline', () => {
  it('collapses newlines so a name cannot inject a new markdown line', () => {
    expect(escapeInline({ value: 'a\n# injected heading' })).toBe('a # injected heading');
    expect(escapeInline({ value: 'a\r\nb' })).toBe('a b');
  });

  it('escapes backticks so a name cannot open a code span', () => {
    expect(escapeInline({ value: 'a`b' })).toBe('a\\`b');
  });

  it('entity-escapes HTML angle brackets (AC-7)', () => {
    expect(escapeInline({ value: '<script>x</script>' })).toBe('&lt;script&gt;x&lt;/script&gt;');
  });

  it('leaves quotes untouched (rendered conditions carry them verbatim)', () => {
    expect(escapeInline({ value: 'status eq "draft"' })).toBe('status eq "draft"');
  });

  it('leaves a plain identifier untouched', () => {
    expect(escapeInline({ value: 'publish_product' })).toBe('publish_product');
  });
});

describe('escapeMermaidLabel', () => {
  it('maps structural characters to Mermaid entity codes', () => {
    const escaped = escapeMermaidLabel({ value: 'weird "spec|al" `object`' });

    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain('|');
    expect(escaped).not.toContain('`');
    expect(escaped).toContain('#quot;');
    expect(escaped).toContain('#124;');
    expect(escaped).toContain('#96;');
    // The raw hostile sequence must be gone entirely.
    expect(escaped).not.toContain('weird "spec|al"');
    // The plain prefix survives.
    expect(escaped).toContain('weird');
  });

  it('escapes a literal hash first so entity codes are not re-escaped', () => {
    expect(escapeMermaidLabel({ value: '#' })).toBe('#35;');
  });

  it('preserves unicode letters (only structural chars are mapped)', () => {
    expect(escapeMermaidLabel({ value: 'café ☕' })).toBe('café ☕');
  });
});

describe('createIdAllocator', () => {
  it('sanitizes to the Mermaid node-ID charset', () => {
    const alloc = createIdAllocator();
    expect(alloc.allocate({ name: 'weird "spec|al" `object`' })).toBe('weird__spec_al___object_');
  });

  it('returns a stable ID for a repeated name', () => {
    const alloc = createIdAllocator();
    const first = alloc.allocate({ name: 'product' });
    const second = alloc.allocate({ name: 'product' });
    expect(first).toBe('product');
    expect(second).toBe('product');
  });

  it('assigns deterministic collision suffixes to distinct colliding names', () => {
    const alloc = createIdAllocator();
    expect(alloc.allocate({ name: 'a b' })).toBe('a_b');
    expect(alloc.allocate({ name: 'a|b' })).toBe('a_b_2');
    expect(alloc.allocate({ name: 'a-b' })).toBe('a_b_3');
  });

  it('replaces every out-of-charset character (pipes become underscores)', () => {
    const alloc = createIdAllocator();
    expect(alloc.allocate({ name: '|||' })).toBe('___');
  });

  it('falls back to `_` for an empty name', () => {
    const alloc = createIdAllocator();
    expect(alloc.allocate({ name: '' })).toBe('_');
  });
});
