import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { canonicalJson } from '../src/introspect';
import { createEngine } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createFileStore } from '../src/store/file';
import { csManager, devIdentity } from './fixtures';

/**
 * Negative-value regression fence (ONT-034).
 *
 * The backlog carried "C6: negative-value edge case in an action input (known
 * limitation)". Driving the real path found NO defect: a negative number is
 * validated, staged, persisted, re-parsed and executed with its sign intact.
 * The note came from a scenario suite that filed an identical situation (an
 * empty string against a `z.string()` with no `.min()`) as an INFO and the
 * negative one as a FINDING; a Prisma `Int` carries no non-negativity
 * constraint, so `z.number().int()` accepting `-500` is a faithful mapping and
 * a domain gap, not a bug.
 *
 * These tests change no production behavior — they pin the behavior that was
 * measured, so a future coercion (a `Math.abs`, an unsigned parse, a store that
 * normalizes numbers) fails here instead of silently flipping a sign between
 * what a human approved and what actually ran.
 */

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'ont-034-'));

/** A cross-process (file-store) fixture recording exactly what `execute` saw. */
const buildPriceFixture = () => {
  const executed: unknown[] = [];
  const registry = createRegistry();

  registry.defineAction({
    name: 'createProduct',
    input: z.object({ name: z.string(), priceCents: z.number().int() }),
    policy: { approval: 'required', roles: ['cs-manager'] },
    execute: async ({ input }) => {
      executed.push(input);
      return { created: input.name, priceCents: input.priceCents };
    },
  });

  const dir = freshDir();
  const store = createFileStore({ dir });

  return { dir, store, executed, engine: createEngine({ registry, store }) };
};

/** The raw `created` event line for an approval id, straight off disk. */
const persistedInput = ({ dir, approvalId }: { dir: string; approvalId: string }): unknown => {
  const line = readFileSync(join(dir, 'approvals.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .find((l) => l.includes(approvalId));

  return JSON.parse(line ?? '{}').record?.input;
};

describe('negative action input — sign fidelity end to end (ONT-034)', () => {
  it('stages, persists, approves and executes a negative integer unchanged', async () => {
    const { dir, store, engine, executed } = buildPriceFixture();

    const staged = await engine.stage({
      actionName: 'createProduct',
      input: { name: 'refund-credit', priceCents: -500 },
      caller: devIdentity,
    });

    expect(staged.status).toBe('approval_pending');
    if (staged.status !== 'approval_pending') {
      return;
    }

    // The approver reads the persisted record, so the SIGN ON DISK is the
    // governance-relevant value — approve-what-you-execute.
    expect(persistedInput({ dir, approvalId: staged.approvalId })).toEqual({
      name: 'refund-credit',
      priceCents: -500,
    });

    const record = await store.getApproval({ id: staged.approvalId });
    expect((record?.input as { priceCents: number }).priceCents).toBe(-500);

    expect(
      (await engine.approve({ approvalId: staged.approvalId, approver: csManager })).status,
    ).toBe('approved');

    const result = await engine.execute({ approvalId: staged.approvalId });

    expect(result.status).toBe('executed');
    expect(executed).toEqual([{ name: 'refund-credit', priceCents: -500 }]);
  });

  it('keeps full precision for the most negative safe integer', async () => {
    const { dir, engine, executed } = buildPriceFixture();

    const staged = await engine.stage({
      actionName: 'createProduct',
      input: { name: 'floor', priceCents: Number.MIN_SAFE_INTEGER },
      caller: devIdentity,
    });

    if (staged.status !== 'approval_pending') {
      throw new Error(`expected approval_pending, got ${staged.status}`);
    }

    expect(persistedInput({ dir, approvalId: staged.approvalId })).toEqual({
      name: 'floor',
      priceCents: Number.MIN_SAFE_INTEGER,
    });

    await engine.approve({ approvalId: staged.approvalId, approver: csManager });
    await engine.execute({ approvalId: staged.approvalId });

    expect(executed).toEqual([{ name: 'floor', priceCents: Number.MIN_SAFE_INTEGER }]);
  });

  it('rejects a negative non-integer at staging, before any approval exists', async () => {
    const { store, engine, executed } = buildPriceFixture();

    const staged = await engine.stage({
      actionName: 'createProduct',
      input: { name: 'fractional', priceCents: -1.5 },
      caller: devIdentity,
    });

    expect(staged.status).toBe('invalid_input');
    expect(await store.listPending()).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('rejects negative infinity at staging (never reaches the store)', async () => {
    const { store, engine, executed } = buildPriceFixture();

    const staged = await engine.stage({
      actionName: 'createProduct',
      input: { name: 'unbounded', priceCents: Number.NEGATIVE_INFINITY },
      caller: devIdentity,
    });

    expect(staged.status).toBe('invalid_input');
    expect(await store.listPending()).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('normalizes negative zero to zero through the store — known and harmless', async () => {
    const { dir, engine, executed } = buildPriceFixture();

    const staged = await engine.stage({
      actionName: 'createProduct',
      input: { name: 'free', priceCents: -0 },
      caller: devIdentity,
    });

    if (staged.status !== 'approval_pending') {
      throw new Error(`expected approval_pending, got ${staged.status}`);
    }

    // JSON has no signed zero, so the store round-trip yields +0. This is the
    // ONLY sign that does not survive, and it changes nothing: `-0 === 0`, so
    // no `where` comparison, audit hash, or execution branch can differ. Pinned
    // here so the normalization stays a documented property rather than a
    // surprise.
    const persisted = persistedInput({ dir, approvalId: staged.approvalId }) as {
      priceCents: number;
    };
    expect(persisted.priceCents).toBe(0);
    expect(Object.is(persisted.priceCents, -0)).toBe(false);

    // Inert: the two spell the same canonical JSON, so no audit hash can differ
    // either, and every ordered `where` comparison sees one value.
    expect(canonicalJson({ value: { priceCents: -0 } })).toBe(
      canonicalJson({ value: { priceCents: 0 } }),
    );

    await engine.approve({ approvalId: staged.approvalId, approver: csManager });
    await engine.execute({ approvalId: staged.approvalId });

    expect(executed).toEqual([{ name: 'free', priceCents: 0 }]);
  });
});

describe('negative action input — declared bounds are authoritative (ONT-034)', () => {
  it('rejects a negative when the author declares a non-negative bound', async () => {
    const registry = createRegistry();
    const executed: unknown[] = [];

    registry.defineAction({
      name: 'chargeCard',
      input: z.object({ amountCents: z.number().int().min(0) }),
      policy: { approval: 'required' },
      execute: async ({ input }) => {
        executed.push(input);
        return { charged: input.amountCents };
      },
    });

    const store = createFileStore({ dir: freshDir() });
    const engine = createEngine({ registry, store });

    const staged = await engine.stage({
      actionName: 'chargeCard',
      input: { amountCents: -1 },
      caller: devIdentity,
    });

    // A `.min(0)` the AUTHOR wrote is enforced by the engine's own safeParse —
    // the MCP tool schema advertises no bound (advisory by design), so this is
    // the layer that has to hold.
    expect(staged.status).toBe('invalid_input');
    expect(await store.listPending()).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('evaluates a negative against a declarative where bound with the right sign', async () => {
    const registry = createRegistry();

    const Account = registry.defineObject({
      name: 'Account',
      schema: z.object({ id: z.string(), balanceCents: z.number() }),
      resolve: { get: async ({ id }) => ({ id, balanceCents: -250 }) },
    });

    registry.defineAction({
      name: 'closeAccount',
      target: Account,
      targetIdFrom: 'accountId',
      input: z.object({ accountId: z.string() }),
      policy: { approval: 'required', where: { field: 'balanceCents', op: 'gte', value: 0 } },
      execute: async () => ({ closed: true }),
    });

    const engine = createEngine({ registry, store: createFileStore({ dir: freshDir() }) });

    // -250 is NOT >= 0. An unsigned comparison would wrongly let this through.
    const staged = await engine.stage({
      actionName: 'closeAccount',
      input: { accountId: 'a1' },
      caller: devIdentity,
    });

    expect(staged.status).toBe('rejected_where');
  });
});
