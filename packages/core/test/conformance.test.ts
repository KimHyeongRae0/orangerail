import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  checkConformance,
  conformanceOfField,
  conformanceReason,
  markNonconforming,
  renderConformancePath,
  UNRENDERABLE_PREFIX,
} from '../src/conformance';

const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'active', 'soldout']),
});

describe('checkConformance', () => {
  it('accepts a row that matches the declaration', () => {
    const verdict = checkConformance({
      schema: productSchema,
      value: { id: 'p1', title: 'Widget', status: 'active' },
    });

    expect(verdict).toEqual({ state: 'conforming' });
  });

  it('reports the path of a field the row does not carry', () => {
    const verdict = checkConformance({
      schema: productSchema,
      value: { id: 'p1', title: 'Widget' },
    });

    expect(verdict.state).toBe('nonconforming');
    expect(verdict.state === 'nonconforming' ? verdict.issues.map((i) => i.path) : []).toEqual([
      ['status'],
    ]);
  });

  it('reports the path of a field the row carries in the wrong shape', () => {
    const verdict = checkConformance({
      schema: productSchema,
      value: { id: 'p1', title: 'Widget', status: { code: 'soldout' } },
    });

    expect(verdict.state === 'nonconforming' ? verdict.issues[0]?.path : undefined).toEqual([
      'status',
    ]);
  });

  // §4: extra keys are stripped by z.object and must not become an error — a
  // resolver returning one more column than the ontology names is the ordinary
  // state of a project mid migration.
  it('accepts a row carrying keys the schema does not mention', () => {
    const verdict = checkConformance({
      schema: productSchema,
      value: { id: 'p1', title: 'Widget', status: 'active', internalNote: 'ignore me' },
    });

    expect(verdict).toEqual({ state: 'conforming' });
  });

  // §4: a declared-optional field that is absent is conforming, and today's
  // behaviour for it is already correct.
  it('accepts an absent field the schema declares optional', () => {
    const verdict = checkConformance({
      schema: z.object({ id: z.string(), status: z.string().optional() }),
      value: { id: 'p1' },
    });

    expect(verdict).toEqual({ state: 'conforming' });
  });

  // §4: the schema is not always a ZodObject. Matching on the reported PATH is
  // what makes these travel through the same code path.
  it('handles a union schema', () => {
    const schema = z.union([
      z.object({ kind: z.literal('a'), status: z.string() }),
      z.object({ kind: z.literal('b'), status: z.number() }),
    ]);

    expect(checkConformance({ schema, value: { kind: 'a', status: 'ok' } })).toEqual({
      state: 'conforming',
    });
    expect(checkConformance({ schema, value: { kind: 'a', status: 5 } }).state).toBe(
      'nonconforming',
    );
  });

  it('handles a refined schema', () => {
    const schema = productSchema.refine((row) => row.title.length > 2, {
      message: 'title is too short',
      path: ['title'],
    });

    const verdict = checkConformance({
      schema,
      value: { id: 'p1', title: 'W', status: 'active' },
    });

    expect(verdict.state === 'nonconforming' ? verdict.issues[0]?.path : undefined).toEqual([
      'title',
    ]);
  });

  // §4: the verdict is computed from the parse RESULT the consumer would see —
  // which here means the check answers about the INPUT the consumer holds, and
  // the transformed output is discarded. The gate reads the raw row and the
  // transport serves the raw row, so an output nobody holds must not be the
  // thing that was checked.
  it('answers about the value handed in, not a schema transform output', () => {
    const schema = z.object({ id: z.string() }).transform((row) => ({ id: row.id.toUpperCase() }));

    expect(checkConformance({ schema, value: { id: 'p1' } })).toEqual({ state: 'conforming' });
    expect(checkConformance({ schema, value: { id: 7 } }).state).toBe('nonconforming');
  });

  // §4: conformance is computed over arbitrary user data. A parse that throws
  // must land somewhere a caller can route, not escape.
  it('reports a parse that throws as unreadable rather than throwing', () => {
    const row = {
      id: 'p1',
      title: 'Widget',
      get status(): string {
        throw new Error('column dropped');
      },
    };

    expect(checkConformance({ schema: productSchema, value: row })).toEqual({
      state: 'unreadable',
      error: 'column dropped',
    });
  });

  it('reports a thrown non-Error without trusting it to describe itself', () => {
    const schema = z.custom(() => {
      throw Object.create(null);
    });

    const verdict = checkConformance({ schema, value: {} });

    expect(verdict.state).toBe('unreadable');
  });

  it('reports a row that is not an object at all at the root', () => {
    const verdict = checkConformance({ schema: productSchema, value: 'a string' });

    expect(verdict.state === 'nonconforming' ? verdict.issues[0]?.path : undefined).toEqual([]);
  });
});

describe('conformanceOfField', () => {
  const drifted = checkConformance({
    schema: productSchema,
    value: { id: 'p1', title: 7, status: 'active' },
  });

  // AC-3, and the whole reason this is a bugfix rather than a breaking change.
  it('says nothing about a field the issues do not name', () => {
    expect(conformanceOfField({ conformance: drifted, field: 'status' })).toEqual({
      state: 'conforming',
    });
  });

  it('reports the field the issues do name', () => {
    const verdict = conformanceOfField({ conformance: drifted, field: 'title' });

    expect(verdict.state).toBe('nonconforming');
  });

  it('passes a conforming verdict through for any field', () => {
    const verdict = checkConformance({
      schema: productSchema,
      value: { id: 'p1', title: 'Widget', status: 'active' },
    });

    expect(conformanceOfField({ conformance: verdict, field: 'status' })).toEqual({
      state: 'conforming',
    });
  });

  it('passes an unreadable verdict through for any field', () => {
    expect(
      conformanceOfField({
        conformance: { state: 'unreadable', error: 'boom' },
        field: 'status',
      }),
    ).toEqual({ state: 'unreadable', error: 'boom' });
  });

  // A row that is not an object cannot be trusted for ANY field.
  it('applies a root-level issue to every field', () => {
    const verdict = checkConformance({ schema: productSchema, value: 'a string' });

    expect(conformanceOfField({ conformance: verdict, field: 'status' }).state).toBe(
      'nonconforming',
    );
  });
});

describe('renderConformancePath', () => {
  it('names a root as $ and a nested path as a reader would', () => {
    expect(renderConformancePath({ path: [] })).toBe('$');
    expect(renderConformancePath({ path: ['status'] })).toBe('status');
    expect(renderConformancePath({ path: ['items', 0, 'id'] })).toBe('items[0].id');
    expect(renderConformancePath({ path: ['mix', 'hi'] })).toBe('mix.hi');
  });
});

describe('conformanceReason', () => {
  it('names the object, the path and zod own sentence', () => {
    const reason = conformanceReason({
      issues: [{ path: ['status'], message: 'Required' }],
      objectName: 'Product',
    });

    expect(reason).toBe('not what Product declares — status: Required');
  });

  it('joins several issues into one sentence', () => {
    const reason = conformanceReason({
      issues: [
        { path: ['status'], message: 'Required' },
        { path: ['title'], message: 'Expected string' },
      ],
      objectName: 'Product',
    });

    expect(reason).toContain('status: Required');
    expect(reason).toContain('title: Expected string');
  });
});

describe('markNonconforming', () => {
  it('returns a conforming value untouched and by reference', () => {
    const row = { id: 'p1', title: 'Widget', status: 'active' };
    const marked = markNonconforming({
      value: row,
      conformance: { state: 'conforming' },
      objectName: 'Product',
    });

    expect(marked.value).toBe(row);
    expect(marked.issues).toEqual([]);
  });

  it('writes the key a row omitted rather than leaving the silence', () => {
    const row = { id: 'p1', title: 'Widget' };
    const marked = markNonconforming({
      value: row,
      conformance: checkConformance({ schema: productSchema, value: row }),
      objectName: 'Product',
    });

    const value = marked.value as Record<string, unknown>;

    expect(String(value['status'])).toContain(UNRENDERABLE_PREFIX);
    expect(String(value['status'])).toContain('not what Product declares here');
    expect(value['title']).toBe('Widget');
  });

  it('does not mutate the row it was handed', () => {
    const row: Record<string, unknown> = { id: 'p1', title: 'Widget' };

    markNonconforming({
      value: row,
      conformance: checkConformance({ schema: productSchema, value: row }),
      objectName: 'Product',
    });

    expect(row).toEqual({ id: 'p1', title: 'Widget' });
  });

  it('marks a nested path without touching its siblings', () => {
    const schema = z.object({ id: z.string(), mix: z.object({ hi: z.number(), lo: z.number() }) });
    const row = { id: 'p1', mix: { hi: 'lots', lo: 2 } };

    const marked = markNonconforming({
      value: row,
      conformance: checkConformance({ schema, value: row }),
      objectName: 'Employee',
    });

    const mix = (marked.value as { mix: Record<string, unknown> }).mix;

    expect(String(mix['hi'])).toContain(UNRENDERABLE_PREFIX);
    expect(mix['lo']).toBe(2);
  });

  it('replaces the whole value when the row is not the declared shape at all', () => {
    const marked = markNonconforming({
      value: 'a string',
      conformance: checkConformance({ schema: productSchema, value: 'a string' }),
      objectName: 'Product',
    });

    expect(String(marked.value)).toContain(UNRENDERABLE_PREFIX);
  });

  it('marks an unreadable value with the reason it could not be read', () => {
    const marked = markNonconforming({
      value: {},
      conformance: { state: 'unreadable', error: 'column dropped' },
      objectName: 'Product',
    });

    expect(String(marked.value)).toContain('not readable as Product — column dropped');
    expect(marked.issues).toEqual([{ path: [], message: 'column dropped' }]);
  });
});
