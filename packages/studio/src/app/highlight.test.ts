import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../snapshot/types';
import { computeHighlights } from './highlight';

const snapshot: GraphSnapshot = {
  objects: [
    { name: 'product', fields: [], readAccess: 'authenticated', hasResolve: true },
    { name: 'note', fields: [], readAccess: 'authenticated', hasResolve: false },
    { name: 'orphan', fields: [], readAccess: 'authenticated', hasResolve: false },
  ],
  links: [{ id: 'product_notes', from: 'product', to: 'note', cardinality: 'many' }],
  actions: [
    {
      name: 'publish',
      target: 'product',
      approval: 'required',
      roles: ['editor'],
      where: 'none',
      notImplemented: false,
    },
    { name: 'sync', approval: 'auto', roles: [], where: 'none', notImplemented: true },
  ],
};

describe('computeHighlights (plan section 3.5)', () => {
  it('is neutral when nothing is focused', () => {
    const r = computeHighlights({ snapshot, active: null, hover: null });
    expect(Object.values(r.objects).every((s) => !s.active && !s.highlighted && !s.dim)).toBe(true);
    expect(r.links.product_notes?.highlighted).toBe(false);
  });

  it('activates an object and highlights its neighbours + touching actions', () => {
    const r = computeHighlights({
      snapshot,
      active: { type: 'object', name: 'product' },
      hover: null,
    });

    expect(r.objects.product?.active).toBe(true);
    expect(r.objects.note?.highlighted).toBe(true);
    expect(r.objects.orphan?.dim).toBe(true);
    expect(r.actions.publish?.highlighted).toBe(true);
    expect(r.actions.sync?.dim).toBe(true);
    expect(r.links.product_notes?.highlighted).toBe(true);
  });

  it('activating an action highlights only its target object', () => {
    const r = computeHighlights({
      snapshot,
      active: { type: 'action', name: 'publish' },
      hover: null,
    });

    expect(r.actions.publish?.active).toBe(true);
    expect(r.objects.product?.highlighted).toBe(true);
    expect(r.objects.note?.dim).toBe(true);
  });

  it('falls back to hover when there is no active selection', () => {
    const r = computeHighlights({
      snapshot,
      active: null,
      hover: { type: 'object', name: 'product' },
    });
    expect(r.objects.product?.active).toBe(true);
    expect(r.objects.note?.highlighted).toBe(true);
  });
});
