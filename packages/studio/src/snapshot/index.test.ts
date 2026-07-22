import { createRegistry, notImplemented, type Registry } from 'orangerail-core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { buildSnapshot } from './index';

const buildFixture = () => {
  const registry = createRegistry();

  const product = registry.defineObject({
    name: 'product',
    schema: z.object({ id: z.string(), title: z.string(), price: z.number().optional() }),
    resolve: { get: async ({ id }) => ({ id, title: 't' }), list: async () => ({ items: [] }) },
  });

  const note = registry.defineObject({
    name: 'note',
    schema: z.object({ id: z.string(), body: z.string() }),
  });

  registry.defineLink({ name: 'product_notes', from: product, to: note, cardinality: 'many' });

  registry.defineAction({
    name: 'publish_product',
    target: product,
    input: z.object({ productId: z.string() }),
    policy: { approval: 'required', roles: ['editor'] },
    execute: async () => ({}),
  });

  registry.defineAction({
    name: 'discount_product',
    target: product,
    input: z.object({ productId: z.string() }),
    policy: { approval: 'required', where: { field: 'status', op: 'eq', value: 'draft' } },
    execute: async () => ({}),
  });

  registry.defineAction({
    name: 'touch',
    input: z.object({ label: z.string() }),
    execute: async () => ({}),
  });

  registry.defineAction({
    name: 'sync_catalog',
    input: z.object({ source: z.string() }),
    execute: notImplemented,
  });

  return registry;
};

describe('buildSnapshot (plan section 3.2)', () => {
  it('covers every registered object, link and action — nothing dropped', () => {
    const snapshot = buildSnapshot({ registry: buildFixture() });

    expect(snapshot.objects.map((o) => o.name)).toEqual(['note', 'product']);
    expect(snapshot.links.map((l) => l.id)).toEqual(['product_notes']);
    expect(snapshot.actions.map((a) => a.name)).toEqual([
      'discount_product',
      'publish_product',
      'sync_catalog',
      'touch',
    ]);
  });

  it('orders fields alphabetically and marks optionality + type', () => {
    const snapshot = buildSnapshot({ registry: buildFixture() });
    const product = snapshot.objects.find((o) => o.name === 'product');

    expect(product?.fields.map((f) => f.name)).toEqual(['id', 'price', 'title']);
    const price = product?.fields.find((f) => f.name === 'price');
    expect(price?.optional).toBe(true);
    expect(price?.type).toBe('number');
    expect(product?.hasResolve).toBe(true);
  });

  it('renders governance truthfully', () => {
    const snapshot = buildSnapshot({ registry: buildFixture() });
    const byName = (n: string) => snapshot.actions.find((a) => a.name === n);

    expect(byName('publish_product')).toMatchObject({
      approval: 'required',
      roles: ['editor'],
      target: 'product',
      where: 'none',
      notImplemented: false,
    });
    expect(byName('discount_product')).toMatchObject({
      where: 'declarative',
      whereText: 'status eq "draft"',
    });
    expect(byName('touch')?.approval).toBe('auto');
    expect(byName('touch')?.target).toBeUndefined();
    expect(byName('sync_catalog')?.notImplemented).toBe(true);
    expect(byName('sync_catalog')?.target).toBeUndefined();
  });

  it('marks a functional where as functional with no text', () => {
    const fakeRegistry = {
      listObjects: () => [],
      listLinks: () => [],
      listActions: () => [
        {
          name: 'guarded',
          execute: () => ({}),
          policy: { approval: 'required', where: () => true },
        },
      ],
    } as unknown as Registry;

    const snapshot = buildSnapshot({ registry: fakeRegistry });
    expect(snapshot.actions[0]?.where).toBe('functional');
    expect(snapshot.actions[0]?.whereText).toBeUndefined();
  });

  it('is deterministic across repeated builds', () => {
    const a = JSON.stringify(buildSnapshot({ registry: buildFixture() }));
    const b = JSON.stringify(buildSnapshot({ registry: buildFixture() }));
    expect(a).toBe(b);
  });

  it('handles an empty registry', () => {
    const snapshot = buildSnapshot({ registry: createRegistry() });
    expect(snapshot).toEqual({ objects: [], links: [], actions: [] });
  });
});
