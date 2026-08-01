import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { hashAuditRecord } from '../src/audit/chain';
import {
  DECIMAL_INTEGER_SOURCE,
  isDecimalInteger,
  isDecimalIntegerField,
  renderBigInts,
} from '../src/json';
import { notImplemented } from '../src/define/action';
import { createRegistry } from '../src/registry';

/**
 * ONT-068 — a `BigInt` crosses a JSON boundary as a decimal string.
 *
 * RED against `752ff7b`: `renderBigInts` and its siblings did not exist, and an
 * action returning a row with a `BigInt` in it produced a `TypeError` from
 * `hashAuditRecord` — swallowed by the engine, so the write happened and the
 * chain recorded only that it had started.
 */

const decimal = new RegExp(DECIMAL_INTEGER_SOURCE);

describe('isDecimalInteger — the accepted wire form of a BigInt (ONT-068 section 4)', () => {
  it('accepts every width a 64-bit key reaches, above 2^53 included', () => {
    for (const value of [
      '0',
      '1',
      '9007199254740993',
      '18446744073709551615',
      '-9223372036854775808',
    ]) {
      expect(isDecimalInteger({ value })).toBe(true);
    }
  });

  it('accepts a negative id and "-0"', () => {
    expect(isDecimalInteger({ value: '-1' })).toBe(true);
    expect(isDecimalInteger({ value: '-0' })).toBe(true);
  });

  it('accepts leading zeros and refuses padding — the decision, stated', () => {
    // `"007"` names the same row the datasource would return for `"7"`, so
    // refusing it would be this layer inventing a rule the database does not
    // have. A padded id is a caller bug far more often than an intent, and one
    // clear refusal beats a silent success on a row nobody named.
    expect(isDecimalInteger({ value: '007' })).toBe(true);
    expect(isDecimalInteger({ value: ' 1' })).toBe(false);
    expect(isDecimalInteger({ value: '1 ' })).toBe(false);
    expect(isDecimalInteger({ value: '1\n' })).toBe(false);
  });

  it('refuses everything a driver would answer with a raw throw', () => {
    for (const value of ['', 'not-a-number', '1.5', '0x10', '1e3', '+1', '--1']) {
      expect(isDecimalInteger({ value })).toBe(false);
    }
  });

  it('refuses a non-string, so a JSON number never reaches the datasource', () => {
    for (const value of [1, 9007199254740993, null, undefined, true, ['1'], { id: '1' }]) {
      expect(isDecimalInteger({ value })).toBe(false);
    }
  });
});

describe('isDecimalIntegerField — telling a BigInt column from a String one', () => {
  it('recognizes the node the emitter renders, through optional and nullable', () => {
    const base = z.string().regex(decimal);

    expect(isDecimalIntegerField({ node: base })).toBe(true);
    // The probe asks what the node ACCEPTS, so a wrapper chain answers the same
    // way its inner node does. `deriveFilterSpec` unwraps first anyway; this is
    // the property that makes the order of the two not matter.
    expect(isDecimalIntegerField({ node: base.optional() })).toBe(true);
    expect(isDecimalIntegerField({ node: base.nullable() })).toBe(true);
  });

  it('does not claim a plain string, a number, an enum or a non-zod value', () => {
    expect(isDecimalIntegerField({ node: z.string() })).toBe(false);
    expect(isDecimalIntegerField({ node: z.number() })).toBe(false);
    expect(isDecimalIntegerField({ node: z.bigint() })).toBe(false);
    expect(isDecimalIntegerField({ node: z.enum(['a', 'b']) })).toBe(false);
    expect(isDecimalIntegerField({ node: undefined })).toBe(false);
    expect(isDecimalIntegerField({ node: { safeParse: 'not a function' } })).toBe(false);
  });
});

describe('renderBigInts (ONT-068 section 4)', () => {
  it('renders a BigInt nested in an object, in an array, and inside a JSON column', () => {
    const rendered = renderBigInts({
      value: {
        id: 9007199254740993n,
        name: 'signed-huge',
        tags: [1n, { deep: [{ deeper: 2n }] }],
        meta: { refs: { ids: [3n, 4n] } },
      },
    });

    expect(rendered).toEqual({
      id: '9007199254740993',
      name: 'signed-huge',
      tags: ['1', { deep: [{ deeper: '2' }] }],
      meta: { refs: { ids: ['3', '4'] } },
    });
  });

  it('keeps the digits a JSON number would lose', () => {
    expect(renderBigInts({ value: 9007199254740993n })).toBe('9007199254740993');
    expect(Number('9007199254740993').toString()).toBe('9007199254740992');
  });

  it('leaves a Date alone, so a timestamped write still verifies', () => {
    // Rebuilding a Date as a plain object reduces it to `{}` in memory while the
    // store persists an ISO string, which is how every timestamped write starts
    // failing `verifyAudit` (ONT-023).
    const createdAt = new Date('2026-08-02T00:00:00.000Z');
    const rendered = renderBigInts({ value: { id: 1n, createdAt } }) as { createdAt: unknown };

    expect(rendered.createdAt).toBe(createdAt);
  });

  it('passes a value that points at itself back untouched instead of spinning', () => {
    const cyclic: Record<string, unknown> = { id: 1n };
    cyclic['self'] = cyclic;

    const rendered = renderBigInts({ value: cyclic }) as Record<string, unknown>;

    expect(rendered['id']).toBe('1');
    expect(rendered['self']).toBe(cyclic);
  });

  it('leaves a primitive, null and undefined exactly as they are', () => {
    expect(renderBigInts({ value: null })).toBeNull();
    expect(renderBigInts({ value: undefined })).toBeUndefined();
    expect(renderBigInts({ value: 'x' })).toBe('x');
    expect(renderBigInts({ value: 3 })).toBe(3);
  });

  it('makes a row with a BigInt hashable, which is the whole point', () => {
    const record = {
      seq: 1,
      prevHash: '0'.repeat(64),
      phase: 'succeeded' as const,
      actionName: 'updateSigned',
      at: '2026-08-02T00:00:00.000Z',
      result: { id: 9007199254740993n },
    };

    expect(() => hashAuditRecord({ record: record as never })).toThrow(/BigInt/);
    expect(() =>
      hashAuditRecord({ record: renderBigInts({ value: record }) as never }),
    ).not.toThrow();
  });
});

describe('defineAction renders its result before the engine can audit it', () => {
  it('turns a BigInt an execute returns into a decimal string', async () => {
    const registry = createRegistry();
    const action = registry.defineAction({
      name: 'deleteSigned',
      input: z.object({ id: z.string() }),
      execute: async () => ({ id: 9007199254740993n, signedId: 42n }),
    });

    await expect(action.execute({ input: { id: '1' }, identity: null as never })).resolves.toEqual({
      id: '9007199254740993',
      signedId: '42',
    });
  });

  it('leaves the notImplemented stub detectable, so staging still rejects it', async () => {
    const registry = createRegistry();
    const action = registry.defineAction({
      name: 'stub',
      input: z.object({ id: z.string() }),
      execute: notImplemented,
    });

    expect(action.execute).toBe(notImplemented);
  });
});
