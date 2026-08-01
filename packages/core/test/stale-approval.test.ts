import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { markCoreInstance } from '../src/instance';
import { createEngine } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createMemoryStore } from '../src/store/memory';
import type { ApprovalRecord, Store } from '../src/store/contract';
import type { Identity } from '../src/types';

const agent: Identity = { subject: 'agent-1', roles: ['viewer'] };
const approver: Identity = { subject: 'alice', roles: ['ops'] };

/**
 * A `0.1.0`-era store: conforming in every respect except that it never stamps
 * `inputHash`, because the version that wrote it had no such field.
 *
 * This is the actual failing deployment, not a synthetic one. A project's
 * `orangerail.config.mjs` imports `createFileStore` from the `orangerail-core`
 * installed beside it; a newer `orangerail` binary runs that config and brings
 * its own core. Every approval in the process is created by the old store and
 * executed by the new engine.
 */
const legacyStore = ({ inner }: { inner: Store }): Store => {
  const strip = <T extends ApprovalRecord | null>(record: T): T => {
    if (record === null) {
      return record;
    }

    const copy = { ...record };
    delete (copy as { inputHash?: string }).inputHash;

    return copy as T;
  };

  return {
    ...inner,
    createApproval: async (args) => strip(await inner.createApproval(args)),
    getApproval: async (args) => strip(await inner.getApproval(args)),
    consumeApproval: async (args) => {
      const result = await inner.consumeApproval(args);

      return result.ok ? { ok: true, record: strip(result.record) } : result;
    },
    listPending: async () => (await inner.listPending()).map((record) => strip(record)),
    listApprovals: async () => (await inner.listApprovals()).map((record) => strip(record)),
  };
};

/** A destructive action with an OBSERVABLE side effect. */
const buildFixture = ({ store }: { store: Store }) => {
  const sideEffects: { widgetId: string }[] = [];

  const registry = createRegistry();
  registry.defineAction({
    name: 'deleteWidget',
    input: z.object({ widgetId: z.string() }),
    policy: { approval: 'required' },
    execute: async ({ input }) => {
      sideEffects.push({ widgetId: input.widgetId });
      return { deleted: input.widgetId };
    },
  });

  return { registry, sideEffects, engine: createEngine({ registry, store }) };
};

describe('ONT-058 — an unverifiable approval is not a tampered one', () => {
  it('reproduces the original failure end to end: the write silently never happens', async () => {
    // The whole reported symptom, in order. Everything reports success and the
    // side effect never occurs — which is why the reason string is the only
    // thing standing between an operator and the wrong conclusion.
    const store = legacyStore({ inner: createMemoryStore() });
    const { engine, sideEffects } = buildFixture({ store });

    const staged = await engine.stage({
      actionName: 'deleteWidget',
      input: { widgetId: 'w-1' },
      caller: agent,
    });
    expect(staged.status).toBe('approval_pending');
    const approvalId = staged.status === 'approval_pending' ? staged.approvalId : '';

    const approved = await engine.approve({ approvalId, approver });
    expect(approved.status).toBe('approved');

    const executed = await engine.execute({ approvalId });

    // Fails CLOSED, exactly as before — that half was never the defect.
    expect(sideEffects).toEqual([]);
    // And names the actual cause. Pre-fix this was `reason: 'input'`, which is
    // documented as "the payload was swapped in the store after a human
    // approved it": an operator who had upgraded their CLI and nothing else was
    // told they had been tampered with.
    expect(executed).toEqual({ status: 'invalidated', reason: 'stale_approval' });
    expect(executed).not.toEqual({ status: 'invalidated', reason: 'input' });
  });

  it('still reports a genuinely swapped payload as `input`', async () => {
    // The distinction only pays if the tampering case keeps its own name. The
    // hash is present here and disagrees with the payload — that IS an edit.
    const inner = createMemoryStore();
    const { engine, sideEffects } = buildFixture({ store: inner });

    const staged = await engine.stage({
      actionName: 'deleteWidget',
      input: { widgetId: 'harmless-test-widget' },
      caller: agent,
    });
    const approvalId = staged.status === 'approval_pending' ? staged.approvalId : '';
    await engine.approve({ approvalId, approver });

    // The swap is modelled at the store boundary, on BOTH reads of the approval
    // — `execute` reads it before it claims it (ONT-069) — so the test states
    // "the store hands back a payload that is not the approved one" rather than
    // which call the engine happens to learn it from.
    const swapped: Store = {
      ...inner,
      getApproval: async (args) => {
        const record = await inner.getApproval(args);

        return record === null ? null : { ...record, input: { widgetId: 'PRODUCTION-TABLE' } };
      },
      consumeApproval: async (args) => {
        const result = await inner.consumeApproval(args);

        return result.ok
          ? { ok: true, record: { ...result.record, input: { widgetId: 'PRODUCTION-TABLE' } } }
          : result;
      },
    };

    const executed = await createEngine({
      registry: buildFixture({ store: swapped }).registry,
      store: swapped,
    }).execute({ approvalId });

    expect(executed).toEqual({ status: 'invalidated', reason: 'input' });
    expect(sideEffects).toEqual([]);
  });

  it('audits the refusal, so the chain shows the approval was spent', async () => {
    // Fail-closed still means "consumed and recorded". A stale approval must
    // not look retryable, or an operator burns the queue one id at a time.
    const store = legacyStore({ inner: createMemoryStore() });
    const { engine } = buildFixture({ store });

    const staged = await engine.stage({
      actionName: 'deleteWidget',
      input: { widgetId: 'w-2' },
      caller: agent,
    });
    const approvalId = staged.status === 'approval_pending' ? staged.approvalId : '';
    await engine.approve({ approvalId, approver });
    await engine.execute({ approvalId });

    const { items } = await store.readAudit({});
    expect(items.map((record) => record.phase)).toContain('invalidated');
    expect((await store.getApproval({ id: approvalId }))?.status).toBe('consumed');

    // A second attempt cannot re-burn it either.
    expect(await engine.execute({ approvalId })).toEqual({
      status: 'consume_failed',
      reason: 'already_consumed',
    });
  });
});

describe('ONT-058 — the core instance marker', () => {
  // Read exactly as a consumer must: a bare `Symbol.for` off the object, with
  // no import from this package. That is the contract — the reader is always in
  // the other package, holding an object built by a core that may export
  // nothing — so the test reaches for it the same way.
  const tokenOf = ({ value }: { value: object }): unknown =>
    (value as Record<symbol, unknown>)[Symbol.for('orangerail.coreInstance')];

  it('stamps every registry this copy of core builds with one shared token', () => {
    const first = tokenOf({ value: createRegistry() });

    expect(first).toBeDefined();
    expect(tokenOf({ value: createRegistry() })).toBe(first);
  });

  it('gives a second copy of core a token that cannot equal this one', () => {
    // What another module instance produces: the same Symbol.for key (the
    // cross-realm registry, so both copies agree on it) holding its own token.
    const foreign = { defineAction: () => undefined };
    Object.defineProperty(foreign, Symbol.for('orangerail.coreInstance'), {
      value: Object.freeze({ package: 'orangerail-core' }),
      enumerable: false,
    });

    expect(tokenOf({ value: foreign })).toBeDefined();
    expect(tokenOf({ value: foreign })).not.toBe(tokenOf({ value: createRegistry() }));
  });

  it('leaves a 0.1.0-era object unmarked — the state that breaks writes', () => {
    expect(tokenOf({ value: { defineAction: () => undefined } })).toBeUndefined();
  });

  it('keeps the mark off spreads and JSON, so a wrapper cannot inherit the claim', () => {
    // `withholdActions` builds a wrapper around the declared registry. If the
    // mark rode along, a filtered registry would vouch for a core that never
    // touched it.
    const marked = markCoreInstance({ value: { a: 1 } });

    expect(tokenOf({ value: { ...marked } })).toBeUndefined();
    expect(JSON.stringify(marked)).toBe('{"a":1}');
  });
});
