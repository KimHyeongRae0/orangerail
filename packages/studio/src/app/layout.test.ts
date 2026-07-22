import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../snapshot/types';
import { actionNodeId, objectId } from './graph';
import { computeLayout, ELK_OPTIONS } from './layout';

const snapshot: GraphSnapshot = {
  objects: [
    { name: 'product', fields: [], readAccess: 'authenticated', hasResolve: true },
    { name: 'note', fields: [], readAccess: 'authenticated', hasResolve: false },
    { name: 'orphan', fields: [], readAccess: 'authenticated', hasResolve: false },
  ],
  links: [{ id: 'product_notes', from: 'product', to: 'note', cardinality: 'many' }],
  actions: [{ name: 'sync', approval: 'auto', roles: [], where: 'none', notImplemented: true }],
};

describe('computeLayout (plan section 3.4)', () => {
  it('passes Liam layered constants', () => {
    expect(ELK_OPTIONS['elk.algorithm']).toBe('layered');
    expect(ELK_OPTIONS['elk.layered.spacing.baseValue']).toBe('40');
    expect(ELK_OPTIONS['elk.layered.nodePlacement.strategy']).toBe('INTERACTIVE');
  });

  it('positions every object and target-less action pill', async () => {
    const positions = await computeLayout({ snapshot });

    expect(positions.has(objectId({ name: 'product' }))).toBe(true);
    expect(positions.has(objectId({ name: 'note' }))).toBe(true);
    expect(positions.has(objectId({ name: 'orphan' }))).toBe(true);
    expect(positions.has(actionNodeId({ name: 'sync' }))).toBe(true);
  });

  it('docks isolated objects and target-less pills to a left column', async () => {
    const positions = await computeLayout({ snapshot });

    const product = positions.get(objectId({ name: 'product' }));
    const orphan = positions.get(objectId({ name: 'orphan' }));
    const sync = positions.get(actionNodeId({ name: 'sync' }));

    expect(orphan?.x).toBeLessThan(product?.x ?? 0);
    expect(sync?.x).toBe(orphan?.x);
  });
});
