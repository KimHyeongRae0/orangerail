import { describe, expect, it } from 'vitest';

import { refOf, resolveLocalRef } from './resolve';

const DOC = {
  components: {
    schemas: {
      Booking: { type: 'object', properties: { id: { type: 'string' } } },
      SeatId: { type: 'integer' },
      'weird/key': { type: 'string' },
      'tilde~name': { type: 'boolean' },
      ChainA: { $ref: '#/components/schemas/ChainB' },
      ChainB: { $ref: '#/components/schemas/ChainA' },
      SelfRef: { $ref: '#/components/schemas/SelfRef' },
      Alias: { $ref: '#/components/schemas/Booking' },
    },
  },
};

describe('refOf', () => {
  it('returns the pointer of a JSON Reference object', () => {
    expect(refOf({ value: { $ref: '#/x' } })).toBe('#/x');
  });

  it('ignores $ref siblings and returns the pointer', () => {
    expect(refOf({ value: { $ref: '#/x', description: 'ignored' } })).toBe('#/x');
  });

  it('returns undefined for non-reference values', () => {
    expect(refOf({ value: { type: 'string' } })).toBeUndefined();
    expect(refOf({ value: null })).toBeUndefined();
    expect(refOf({ value: 'string' })).toBeUndefined();
    expect(refOf({ value: { $ref: 42 } })).toBeUndefined();
  });
});

describe('resolveLocalRef', () => {
  it('walks a local pointer to the target value', () => {
    const result = resolveLocalRef({ doc: DOC, ref: '#/components/schemas/SeatId' });

    expect(result).toEqual({ ok: true, value: { type: 'integer' } });
  });

  it('decodes ~1 as / in a segment (RFC 6901)', () => {
    const result = resolveLocalRef({ doc: DOC, ref: '#/components/schemas/weird~1key' });

    expect(result).toEqual({ ok: true, value: { type: 'string' } });
  });

  it('decodes ~0 as ~ in a segment (RFC 6901)', () => {
    const result = resolveLocalRef({ doc: DOC, ref: '#/components/schemas/tilde~0name' });

    expect(result).toEqual({ ok: true, value: { type: 'boolean' } });
  });

  it('follows a chained reference to the concrete value', () => {
    const result = resolveLocalRef({ doc: DOC, ref: '#/components/schemas/Alias' });

    expect(result).toEqual({
      ok: true,
      value: { type: 'object', properties: { id: { type: 'string' } } },
    });
  });

  it('rejects a non-local (external / URL) pointer', () => {
    const result = resolveLocalRef({ doc: DOC, ref: 'https://example.com/x.json#/Thing' });

    expect(result).toEqual({ ok: false, reason: 'external' });
  });

  it('reports a missing target', () => {
    const result = resolveLocalRef({ doc: DOC, ref: '#/components/schemas/Nope' });

    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  it('terminates an A->B->A cycle with a cycle reason', () => {
    const result = resolveLocalRef({ doc: DOC, ref: '#/components/schemas/ChainA' });

    expect(result).toEqual({ ok: false, reason: 'cycle' });
  });

  it('terminates a self-referential cycle', () => {
    const result = resolveLocalRef({ doc: DOC, ref: '#/components/schemas/SelfRef' });

    expect(result).toEqual({ ok: false, reason: 'cycle' });
  });

  it('bounds an over-deep chain with a depth reason', () => {
    const schemas: Record<string, unknown> = { end: { type: 'string' } };
    for (let i = 0; i < 20; i += 1) {
      schemas[`s${i}`] = { $ref: `#/schemas/${i === 19 ? 'end' : `s${i + 1}`}` };
    }

    const result = resolveLocalRef({ doc: { schemas }, ref: '#/schemas/s0' });

    expect(result).toEqual({ ok: false, reason: 'depth' });
  });
});
