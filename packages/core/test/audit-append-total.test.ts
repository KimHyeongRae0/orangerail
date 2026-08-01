import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { hashApprovalInput, persistedForm } from '../src/audit/chain';
import { verifyAudit } from '../src/audit/verify';
import { createEngine } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createFileStore } from '../src/store/file';
import { createMemoryStore } from '../src/store/memory';
import type { AuditRecord, Store } from '../src/store/contract';
import type { Identity } from '../src/types';

/**
 * ONT-069. Both defects were found while testing `BigInt` and neither is about
 * `BigInt`, so everything here is driven by a value that is unserializable for a
 * DIFFERENT reason — a self-reference, a `Symbol`, a function-valued field —
 * and none of it depends on how `BigInt` is published.
 */

const agent: Identity = { subject: 'agent-1', roles: ['viewer'] };
const approver: Identity = { subject: 'alice', roles: ['cs-manager'] };

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'ont-069-'));

/** An object that JSON refuses: a row that points back at itself. */
const circularRow = (): Record<string, unknown> => {
  const row: Record<string, unknown> = { id: 'w-1', label: 'widget' };
  row.self = row;

  return row;
};

/**
 * A registry with one gated and one auto action, both returning whatever the
 * caller decides — the shape under test is the RESULT, not the action.
 */
const buildFixture = ({ result }: { result: () => unknown }) => {
  const registry = createRegistry();
  const executed: unknown[] = [];

  const run = async ({ input }: { input: unknown }): Promise<unknown> => {
    executed.push(input);

    return result();
  };

  registry.defineAction({
    name: 'gatedWrite',
    input: z.object({ id: z.string() }),
    policy: { approval: 'required', roles: ['cs-manager'] },
    execute: run,
  });

  registry.defineAction({
    name: 'autoWrite',
    input: z.object({ id: z.string() }),
    execute: run,
  });

  return { registry, executed };
};

/** Stage + approve a `gatedWrite`, returning its approval id. */
const stageAndApprove = async ({
  engine,
}: {
  engine: ReturnType<typeof createEngine>;
}): Promise<string> => {
  const staged = await engine.stage({
    actionName: 'gatedWrite',
    input: { id: 'w-1' },
    caller: agent,
  });
  if (staged.status !== 'approval_pending') {
    throw new Error(`staging failed: ${staged.status}`);
  }

  await engine.approve({ approvalId: staged.approvalId, approver });

  return staged.approvalId;
};

/** A store whose `appendAudit` throws until the caller turns it back on. */
const breakableStore = ({
  base,
}: {
  base: Store;
}): { store: Store; broken: { value: boolean } } => {
  const broken = { value: true };

  return {
    broken,
    store: {
      ...base,
      appendAudit: async ({ record }) => {
        if (broken.value) {
          throw new Error('EACCES: permission denied, open audit.jsonl');
        }

        return base.appendAudit({ record });
      },
    },
  };
};

const readChain = async ({ store }: { store: Store }): Promise<AuditRecord[]> =>
  (await store.readAudit({})).items;

describe('ONT-069 AC-1 — hashing is total', () => {
  it('returns a digest for a BigInt, a circular reference and a Symbol-keyed field', () => {
    const symbolKeyed = { [Symbol('secret')]: 'x', kept: 1 };

    for (const value of [
      9007199254740994n,
      { id: 1n, nested: { big: 2n } },
      circularRow(),
      symbolKeyed,
      { fn: () => 1, sym: Symbol('s'), kept: 'yes' },
      [1n, circularRow()],
    ]) {
      expect(hashApprovalInput({ input: value })).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is stable: the same refused value hashes to the same digest twice', () => {
    expect(hashApprovalInput({ input: circularRow() })).toBe(
      hashApprovalInput({ input: circularRow() }),
    );
  });

  it('states what it replaced and keeps everything else', () => {
    expect(persistedForm({ value: circularRow() })).toEqual({
      id: 'w-1',
      label: 'widget',
      self: '[unserializable: circular reference]',
    });

    expect(persistedForm({ value: { id: 9007199254740994n, name: 'row' } })).toEqual({
      id: '[unserializable: bigint 9007199254740994]',
      name: 'row',
    });

    // A Symbol or a function is DROPPED by JSON rather than refused, so the
    // ordinary round-trip still handles it and the rendering does not change.
    expect(persistedForm({ value: { fn: () => 1, sym: Symbol('s'), kept: 'yes' } })).toEqual({
      kept: 'yes',
    });
  });

  it('does not call a repeated reference circular', () => {
    // The same object twice side by side serializes fine. Only an ANCESTOR is a
    // cycle, and an audit record that says "circular" about a DAG is a false
    // statement about what the action returned.
    const shared = { id: 'shared' };
    const value = { left: shared, right: shared, big: 1n };

    expect(persistedForm({ value })).toEqual({
      left: { id: 'shared' },
      right: { id: 'shared' },
      big: '[unserializable: bigint 1]',
    });
  });

  it('leaves an ordinary value byte-identical to the plain round-trip', () => {
    const value = { id: 'w-1', at: new Date('2026-08-02T00:00:00.000Z'), n: [1, 2, null] };

    expect(persistedForm({ value })).toEqual(JSON.parse(JSON.stringify(value)));
  });
});

describe('ONT-069 AC-2 — a write cannot land with nothing in the chain', () => {
  it('writes a terminal record with a stated fallback rendering (gated, audit.jsonl)', async () => {
    const dir = freshDir();
    const store = createFileStore({ dir });
    const { registry, executed } = buildFixture({ result: circularRow });
    const engine = createEngine({ registry, store });

    const approvalId = await stageAndApprove({ engine });
    const result = await engine.execute({ approvalId });

    expect(result.status).toBe('executed');
    expect(executed).toHaveLength(1);

    // Read the log the operator reads, not the store API.
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AuditRecord);

    expect(lines.map((record) => record.phase)).toEqual([
      'staged',
      'approved',
      'execution_started',
      'succeeded',
    ]);

    const terminal = lines[lines.length - 1];
    expect(terminal?.result).toEqual({
      id: 'w-1',
      label: 'widget',
      self: '[unserializable: circular reference]',
    });

    expect((await verifyAudit({ store })).issues).toEqual([]);
  });

  it('writes a terminal record for an auto action returning a refused value', async () => {
    const store = createMemoryStore();
    const { registry } = buildFixture({ result: circularRow });
    const engine = createEngine({ registry, store });

    const result = await engine.stage({
      actionName: 'autoWrite',
      input: { id: 'w-1' },
      caller: agent,
    });

    expect(result.status).toBe('executed');
    expect((await readChain({ store })).map((record) => record.phase)).toEqual([
      'execution_started',
      'succeeded',
    ]);
    expect((await verifyAudit({ store })).ok).toBe(true);
  });

  it('records a Symbol-valued and a function-valued field without refusing the append', async () => {
    const store = createMemoryStore();
    const { registry } = buildFixture({
      result: () => ({ token: Symbol('opaque'), retry: () => undefined, id: 'w-1' }),
    });
    const engine = createEngine({ registry, store });

    expect(
      (await engine.stage({ actionName: 'autoWrite', input: { id: 'w-1' }, caller: agent })).status,
    ).toBe('executed');

    const terminal = (await readChain({ store })).find((record) => record.phase === 'succeeded');
    expect(terminal?.result).toEqual({ id: 'w-1' });
    expect((await verifyAudit({ store })).ok).toBe(true);
  });

  it('records a refused PRIOR row and a fine result, and the reverse', async () => {
    const registry = createRegistry();
    const widget = registry.defineObject({
      name: 'widget',
      schema: z.object({ id: z.string() }),
      resolve: { get: async () => circularRow() },
    });

    registry.defineAction({
      name: 'updateWidget',
      target: widget,
      targetIdFrom: 'id',
      input: z.object({ id: z.string() }),
      execute: async () => ({ ok: true }),
    });

    const store = createMemoryStore();
    const engine = createEngine({ registry, store });

    expect(
      (await engine.stage({ actionName: 'updateWidget', input: { id: 'w-1' }, caller: agent }))
        .status,
    ).toBe('executed');

    const records = await readChain({ store });
    const started = records.find((record) => record.phase === 'execution_started');

    expect(started?.prior).toEqual({
      state: 'value',
      value: { id: 'w-1', label: 'widget', self: '[unserializable: circular reference]' },
    });
    expect(records.find((record) => record.phase === 'succeeded')?.result).toEqual({ ok: true });
    expect((await verifyAudit({ store })).ok).toBe(true);
  });
});

describe('ONT-069 AC-3/AC-4 — an approval that could not be executed stays executable', () => {
  it('leaves the approval untouched when the execution_started append fails, then executes it', async () => {
    const base = createMemoryStore();
    const { store, broken } = breakableStore({ base });
    const { registry, executed } = buildFixture({ result: circularRow });

    // Stage and approve against the WORKING store: the failure under test is the
    // execution_started append, not the queue.
    const staging = createEngine({ registry, store: base });
    const approvalId = await stageAndApprove({ engine: staging });

    const blocked = await createEngine({ registry, store }).execute({ approvalId });
    expect(blocked.status).toBe('audit_blocked');
    expect(executed).toEqual([]);

    // AC-3 / AC-4: not consumed, so `check_approval` cannot answer
    // "Already executed (consumed)." — that answer comes from `consume_failed`
    // with `already_consumed`, and this approval is still `approved`.
    expect((await base.getApproval({ id: approvalId }))?.status).toBe('approved');
    expect((await verifyAudit({ store: base })).issues).toEqual([]);

    broken.value = false;
    const executedResult = await createEngine({ registry, store }).execute({ approvalId });

    expect(executedResult.status).toBe('executed');
    expect(executed).toHaveLength(1);
    expect((await base.getApproval({ id: approvalId }))?.status).toBe('consumed');

    const verdict = await verifyAudit({ store: base });
    expect(verdict.ok).toBe(true);
    expect(verdict.issues.some((issue) => issue.includes('orphaned consumed approval'))).toBe(
      false,
    );
  });

  it('keeps the approval intact when the store itself is unwritable mid-call', async () => {
    // Nothing about the value is wrong here — the store is. The pre-existing
    // `audit_blocked` answer is unchanged; what changed is that the approval it
    // refuses to execute is still there afterwards.
    const dir = freshDir();
    const base = createFileStore({ dir });
    const { store, broken } = breakableStore({ base });
    const { registry, executed } = buildFixture({ result: () => ({ ok: true }) });

    const approvalId = await stageAndApprove({ engine: createEngine({ registry, store: base }) });

    const blocked = await createEngine({ registry, store }).execute({ approvalId });
    expect(blocked.status).toBe('audit_blocked');
    expect(executed).toEqual([]);
    expect((await base.getApproval({ id: approvalId }))?.status).toBe('approved');

    broken.value = false;
    expect((await createEngine({ registry, store }).execute({ approvalId })).status).toBe(
      'executed',
    );
    expect((await verifyAudit({ store: base })).issues).toEqual([]);
  });

  it('still spends an approval it refuses on integrity grounds', async () => {
    // The ordering change must not turn a tampered approval into a retryable
    // one (ONT-040): the refusal is recorded first and the approval is spent
    // after, so it is spent either way and the record explaining it exists.
    const store = createMemoryStore();
    const { registry } = buildFixture({ result: () => ({ ok: true }) });
    const engine = createEngine({ registry, store });

    const approvalId = await stageAndApprove({ engine });

    const stored = await store.getApproval({ id: approvalId });
    if (!stored) {
      throw new Error('approval vanished');
    }
    vi.spyOn(store, 'getApproval').mockResolvedValue({
      ...stored,
      input: { id: 'SOMETHING-ELSE' },
    });

    expect(await engine.execute({ approvalId })).toEqual({
      status: 'invalidated',
      reason: 'input',
    });

    vi.restoreAllMocks();
    expect((await store.getApproval({ id: approvalId }))?.status).toBe('consumed');
    expect((await readChain({ store })).map((record) => record.phase)).toContain('invalidated');

    // Not an orphan: the refusal is on the chain ahead of the consumption. The
    // swap itself is still reported, which is X5 doing its job.
    const verdict = await verifyAudit({ store });
    expect(verdict.issues.some((issue) => issue.includes('orphaned consumed approval'))).toBe(
      false,
    );
    expect(verdict.issues.some((issue) => issue.includes('swapped input'))).toBe(true);
  });
});

describe('ONT-069 AC-6 — an orphan already on the chain still fails', () => {
  it('reports a consumed approval with no post-consume record, exactly as before', async () => {
    const store = createMemoryStore();
    const { registry } = buildFixture({ result: () => ({ ok: true }) });
    const engine = createEngine({ registry, store });

    const approvalId = await stageAndApprove({ engine });

    // The 0.1.1 accident, reproduced at the store level: the approval is burned
    // and nothing follows it on the chain. This ticket stops NEW ones; it must
    // not launder the ones already written.
    await store.consumeApproval({ id: approvalId });

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(
      verdict.issues.some((issue) =>
        issue.includes(`orphaned consumed approval ${approvalId}: consumed but no post-consume`),
      ),
    ).toBe(true);
  });
});
