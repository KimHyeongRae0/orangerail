import { describe, expect, it } from 'vitest';

import type { GraphSnapshot, SnapshotObject } from '../snapshot/types';
import { actionNodeId, cardWidth, objectId } from './graph';
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

  it('reserves the self-loop pill band so a targeted card never overlaps the next layer', async () => {
    // `order` is the target of two self-loop actions AND links to `refund` in the
    // next layer — the exact deleteOrder/updateOrder-over-Refund overlap case. The
    // pill band bulges to `orderRight + 236` (bulge 96 + label 10 + pill half 130),
    // so `refund` must be placed clear of that band, not straight through it.
    const orderObject: SnapshotObject = {
      name: 'order',
      fields: [],
      readAccess: 'authenticated',
      hasResolve: true,
    };
    const overlapCase: GraphSnapshot = {
      objects: [
        orderObject,
        { name: 'refund', fields: [], readAccess: 'authenticated', hasResolve: true },
      ],
      links: [{ id: 'order_refunds', from: 'order', to: 'refund', cardinality: 'many' }],
      actions: [
        {
          name: 'updateOrder',
          target: 'order',
          approval: 'required',
          roles: [],
          where: 'none',
          notImplemented: false,
        },
        {
          name: 'deleteOrder',
          target: 'order',
          approval: 'required',
          roles: [],
          where: 'none',
          notImplemented: false,
        },
      ],
    };

    const positions = await computeLayout({ snapshot: overlapCase });
    const order = positions.get(objectId({ name: 'order' }));
    const refund = positions.get(objectId({ name: 'refund' }));

    const orderRight = (order?.x ?? 0) + cardWidth({ object: orderObject });
    const pillBandRight = orderRight + 236;

    // Refund's left edge sits beyond the pill band's right edge — no overlap.
    expect(refund?.x ?? 0).toBeGreaterThanOrEqual(pillBandRight);
  });
});
