import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { createRegistry } from '../src/registry';

/**
 * Type-level fixtures. The `@ts-expect-error` lines are validated by
 * `tsc --noEmit` (the package typecheck), which errors on an unused
 * expect-error — so a rule that stops holding fails the build. The bodies live
 * inside arrows that are never called, so nothing runs at runtime.
 */
describe('type-level rules', () => {
  const registry = createRegistry();

  it('rejects roles without approval: "required" (AC-3)', () => {
    const fixture = () => {
      registry.defineAction({
        name: 'noApprovalWithRoles',
        input: z.object({ id: z.string() }),
        // @ts-expect-error roles require approval: 'required'
        policy: { roles: ['cs-manager'] },
        execute: async () => undefined,
      });
    };

    expect(typeof fixture).toBe('function');
  });

  it('rejects a where whose target object has no resolve contract (AC-1)', () => {
    const fixture = () => {
      const NoResolve = registry.defineObject({
        name: 'NoResolve',
        schema: z.object({ id: z.string() }),
      });

      registry.defineAction({
        name: 'whereWithoutResolve',
        target: NoResolve,
        input: z.object({ noResolveId: z.string() }),
        policy: {
          approval: 'required',
          // @ts-expect-error where requires a target object carrying a resolve contract
          where: { field: 'id', op: 'eq', value: 'x' },
        },
        execute: async () => undefined,
      });
    };

    expect(typeof fixture).toBe('function');
  });

  it('rejects a targetIdFrom that is not a key of the input schema (AC-1)', () => {
    const fixture = () => {
      const Resolvable = registry.defineObject({
        name: 'Resolvable',
        schema: z.object({ id: z.string() }),
        resolve: { get: async () => null },
      });

      registry.defineAction({
        name: 'badTargetId',
        target: Resolvable,
        // @ts-expect-error targetIdFrom must name a key of the input schema
        targetIdFrom: 'nope',
        input: z.object({ realId: z.string() }),
        execute: async () => undefined,
      });
    };

    expect(typeof fixture).toBe('function');
  });
});

describe('type-level inference', () => {
  const registry = createRegistry();

  it('flows the input schema type into execute', () => {
    const fixture = () => {
      registry.defineAction({
        name: 'cleanInference',
        input: z.object({ amount: z.number(), label: z.string() }),
        execute: async ({ input }) => {
          expectTypeOf(input).toEqualTypeOf<{ amount: number; label: string }>();
          return input.amount;
        },
      });
    };

    expect(typeof fixture).toBe('function');
  });
});
