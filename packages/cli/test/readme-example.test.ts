import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { issueCoupon } from './readme-example';

/**
 * The README's flagship declaration must be code that actually compiles against
 * the shipped API. `readme-example.ts` IS that snippet: the package typecheck
 * (verify gate 6) compiles it, and this test asserts the README still prints it
 * verbatim — so a reader copying it out cannot land on something that never
 * compiled, and the two cannot drift apart.
 */
const README_PATH = fileURLToPath(new URL('../../../README.md', import.meta.url));
const SNIPPET_PATH = fileURLToPath(new URL('./readme-example.ts', import.meta.url));

const readmeTsBlock = (): string => {
  const match = /```ts\n([\s\S]*?)```/.exec(readFileSync(README_PATH, 'utf8'));

  if (match?.[1] === undefined) {
    throw new Error('README.md has no ```ts fenced block');
  }

  return match[1];
};

describe('the README defineAction example', () => {
  it('is printed in the README verbatim', () => {
    expect(readmeTsBlock()).toBe(readFileSync(SNIPPET_PATH, 'utf8'));
  });

  it('registers exactly what the surrounding prose claims', () => {
    expect(issueCoupon.policy?.approval).toBe('required');
    expect(issueCoupon.policy?.where).toEqual({ field: 'status', op: 'neq', value: 'soldout' });
    expect(issueCoupon.targetIdFrom).toBe('productId');
  });
});
