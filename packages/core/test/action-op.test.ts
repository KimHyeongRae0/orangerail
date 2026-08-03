import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRegistry } from '../src/registry';

/**
 * `op` is provenance the generator records (ONT-091): a syntactic fact about
 * what the action does to its target, carried so that it survives independently
 * of the `policy` block it happened to produce.
 */
describe('defineAction — op (ONT-091)', () => {
  const input = z.object({ orderId: z.string() });

  it('carries a declared op onto the definition', () => {
    const registry = createRegistry();

    const action = registry.defineAction({
      name: 'deleteOrder',
      op: 'delete',
      input,
      execute: async () => undefined,
    });

    expect(action.op).toBe('delete');
    expect(registry.getAction({ name: 'deleteOrder' })?.op).toBe('delete');
  });

  it('leaves the key ABSENT — not undefined — when none is declared', () => {
    const registry = createRegistry();

    const action = registry.defineAction({
      name: 'refundOrder',
      input,
      execute: async () => undefined,
    });

    // The distinction the studio reads: an action that declared nothing must
    // not arrive as a key holding `undefined`, because that is one JSON
    // round-trip away from looking like a value someone chose.
    expect('op' in action).toBe(false);
    expect(action.op).toBeUndefined();
  });

  it('does NOT move the signature hash', () => {
    const registry = createRegistry();

    const withoutOp = registry.defineAction({
      name: 'deleteOrder',
      input,
      policy: { approval: 'required' },
      execute: async () => undefined,
    });

    const other = createRegistry();
    const withOp = other.defineAction({
      name: 'deleteOrder',
      op: 'delete',
      input: z.object({ orderId: z.string() }),
      policy: { approval: 'required' },
      execute: async () => undefined,
    });

    // The load-bearing assertion of ONT-091. The hash is what staging compares
    // against at execution time, so if `op` entered it, every approval staged
    // before a project regenerated its ontology would fail its signature check
    // — over a field that says nothing about what the action does when it runs.
    expect(withOp.signatureHash).toBe(withoutOp.signatureHash);
  });

  it('accepts all three ops and nothing else at the type level', () => {
    const registry = createRegistry();

    const ops = (['create', 'update', 'delete'] as const).map((op) =>
      registry.defineAction({
        name: `${op}Order`,
        op,
        input,
        execute: async () => undefined,
      }),
    );

    expect(ops.map((action) => action.op)).toEqual(['create', 'update', 'delete']);
  });
});
