import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createRegistry,
  defineObject,
  getDefaultRegistry,
  resetDefaultRegistry,
} from '../src/registry';

describe('registry (AC-4)', () => {
  it('registers declarations on call and looks them up by name', () => {
    const registry = createRegistry();
    const obj = registry.defineObject({ name: 'Widget', schema: z.object({ id: z.string() }) });

    expect(obj.kind).toBe('object');
    expect(obj.readAccess).toBe('authenticated');
    expect(registry.getObject({ name: 'Widget' })?.name).toBe('Widget');
    expect(registry.listObjects()).toHaveLength(1);
  });

  it('throws on duplicate object / action / link names', () => {
    const registry = createRegistry();
    registry.defineObject({ name: 'Dup', schema: z.object({ id: z.string() }) });

    expect(() =>
      registry.defineObject({ name: 'Dup', schema: z.object({ id: z.string() }) }),
    ).toThrow(/duplicate object/);

    registry.defineAction({ name: 'act', input: z.object({}), execute: async () => undefined });
    expect(() =>
      registry.defineAction({ name: 'act', input: z.object({}), execute: async () => undefined }),
    ).toThrow(/duplicate action/);
  });

  it('keeps separate registries isolated', () => {
    const a = createRegistry();
    const b = createRegistry();
    a.defineObject({ name: 'OnlyA', schema: z.object({ id: z.string() }) });

    expect(a.getObject({ name: 'OnlyA' })).toBeDefined();
    expect(b.getObject({ name: 'OnlyA' })).toBeUndefined();
  });

  it('supports the default-registry sugar with reset', () => {
    resetDefaultRegistry();
    defineObject({ name: 'Sugared', schema: z.object({ id: z.string() }) });
    expect(getDefaultRegistry().getObject({ name: 'Sugared' })).toBeDefined();

    resetDefaultRegistry();
    expect(getDefaultRegistry().getObject({ name: 'Sugared' })).toBeUndefined();
  });

  it('honours an explicit readAccess', () => {
    const registry = createRegistry();
    const obj = registry.defineObject({
      name: 'Public',
      schema: z.object({ id: z.string() }),
      readAccess: 'anonymous',
    });
    expect(obj.readAccess).toBe('anonymous');
  });
});
