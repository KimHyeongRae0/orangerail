import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { computeSignatureHash } from '../src/signature';

describe('computeSignatureHash (§3.4)', () => {
  const input = z.object({ productId: z.string(), amount: z.number() });

  it('is stable for the same action shape and policy', () => {
    const a = computeSignatureHash({
      actionName: 'issueCoupon',
      input,
      policy: { approval: 'required', roles: ['cs-manager'] },
    });
    const b = computeSignatureHash({
      actionName: 'issueCoupon',
      input: z.object({ productId: z.string(), amount: z.number() }),
      policy: { approval: 'required', roles: ['cs-manager'] },
    });
    expect(a).toBe(b);
  });

  it('is role-order independent', () => {
    const a = computeSignatureHash({
      actionName: 'x',
      input,
      policy: { approval: 'required', roles: ['a', 'b'] },
    });
    const b = computeSignatureHash({
      actionName: 'x',
      input,
      policy: { approval: 'required', roles: ['b', 'a'] },
    });
    expect(a).toBe(b);
  });

  it('changes when a top-level input field type changes', () => {
    const a = computeSignatureHash({ actionName: 'x', input });
    const b = computeSignatureHash({
      actionName: 'x',
      input: z.object({ productId: z.string(), amount: z.string() }),
    });
    expect(a).not.toBe(b);
  });

  it('changes when the declarative where changes', () => {
    const a = computeSignatureHash({
      actionName: 'x',
      input,
      policy: { approval: 'required', where: { field: 'status', op: 'neq', value: 'soldout' } },
    });
    const b = computeSignatureHash({
      actionName: 'x',
      input,
      policy: { approval: 'required', where: { field: 'status', op: 'eq', value: 'soldout' } },
    });
    expect(a).not.toBe(b);
  });

  it('collapses a functional where to a constant (body changes are undetectable — §3.4)', () => {
    const a = computeSignatureHash({
      actionName: 'x',
      input,
      policy: { approval: 'required', where: () => true },
    });
    const b = computeSignatureHash({
      actionName: 'x',
      input,
      policy: { approval: 'required', where: () => false },
    });
    expect(a).toBe(b);
  });
});
