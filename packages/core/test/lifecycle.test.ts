import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createEngine } from '../src/lifecycle/engine';
import { createMemoryStore } from '../src/store/memory';
import {
  agent,
  buildCouponFixture,
  buildNoRolesFixture,
  csManager,
  devIdentity,
  wrapStoreThrowingOn,
  wrongApprover,
} from './fixtures';

const stageAndApprove = async ({
  amount = 10,
}: {
  amount?: number;
} = {}) => {
  const fixture = buildCouponFixture();
  const staged = await fixture.engine.stage({
    actionName: 'issueCoupon',
    input: { productId: 'p1', amount },
    caller: agent,
  });

  if (staged.status !== 'approval_pending') {
    throw new Error(`expected approval_pending, got ${staged.status}`);
  }

  await fixture.engine.approve({ approvalId: staged.approvalId, approver: csManager });

  return { ...fixture, approvalId: staged.approvalId };
};

describe('lifecycle — happy path', () => {
  it('stages, approves, executes and audits the full chain', async () => {
    const { engine, store, approvalId } = await stageAndApprove({});

    const executed = await engine.execute({ approvalId });
    expect(executed.status).toBe('executed');
    if (executed.status === 'executed') {
      expect(executed.result).toEqual({ couponId: 'c-p1', amount: 10 });
    }

    const consumed = await store.getApproval({ id: approvalId });
    expect(consumed?.status).toBe('consumed');

    const audit = await store.readAudit({});
    const phases = audit.items.map((r) => r.phase);
    expect(phases).toEqual(['staged', 'approved', 'execution_started', 'succeeded']);
  });
});

describe('lifecycle — staging authorization (§4.5 step 0)', () => {
  it('denies anonymous staging (deny-first)', async () => {
    const { engine } = buildCouponFixture();

    const result = await engine.stage({
      actionName: 'issueCoupon',
      input: { productId: 'p1', amount: 1 },
      caller: null,
    });

    expect(result).toEqual({ status: 'denied', reason: 'anonymous' });
  });

  it('ALLOWS an authenticated non-approver to stage (roles never gate staging)', async () => {
    const { engine } = buildCouponFixture();

    const result = await engine.stage({
      actionName: 'issueCoupon',
      input: { productId: 'p1', amount: 1 },
      caller: agent,
    });

    expect(result.status).toBe('approval_pending');
  });

  it('rejects invalid input at staging', async () => {
    const { engine } = buildCouponFixture();

    const result = await engine.stage({
      actionName: 'issueCoupon',
      input: { productId: 'p1', amount: 'nope' },
      caller: agent,
    });

    expect(result.status).toBe('invalid_input');
  });
});

describe('lifecycle — approval authorization (§4.6)', () => {
  it('rejects a wrong-role approve without consuming the CAS', async () => {
    const fixture = buildCouponFixture();
    const staged = await fixture.engine.stage({
      actionName: 'issueCoupon',
      input: { productId: 'p1', amount: 1 },
      caller: agent,
    });
    if (staged.status !== 'approval_pending') {
      throw new Error('staging failed');
    }

    const wrong = await fixture.engine.approve({
      approvalId: staged.approvalId,
      approver: wrongApprover,
    });
    expect(wrong.status).toBe('rejected_role');

    const still = await fixture.store.getApproval({ id: staged.approvalId });
    expect(still?.status).toBe('pending');

    const right = await fixture.engine.approve({
      approvalId: staged.approvalId,
      approver: csManager,
    });
    expect(right.status).toBe('approved');
  });

  it('lets any authenticated identity approve when the policy has no roles', async () => {
    const { engine } = buildNoRolesFixture();

    const staged = await engine.stage({
      actionName: 'noteAction',
      input: { note: 'hello' },
      caller: agent,
    });
    if (staged.status !== 'approval_pending') {
      throw new Error('staging failed');
    }

    const approved = await engine.approve({ approvalId: staged.approvalId, approver: agent });
    expect(approved.status).toBe('approved');
  });
});

describe('lifecycle — TOCTOU authoritative re-evaluation (AC-5)', () => {
  it('refuses execution with condition_changed when the target drifts, keeping the approval consumed', async () => {
    const { backend, engine, store, approvalId } = await stageAndApprove({ amount: 5 });

    const row = backend.get('p1');
    if (row) {
      row.status = 'soldout';
    }

    const executed = await engine.execute({ approvalId });
    expect(executed.status).toBe('condition_changed');

    const consumed = await store.getApproval({ id: approvalId });
    expect(consumed?.status).toBe('consumed');

    const retry = await engine.execute({ approvalId });
    expect(retry).toEqual({ status: 'consume_failed', reason: 'already_consumed' });

    const audit = await store.readAudit({});
    expect(audit.items.some((r) => r.phase === 'condition_changed')).toBe(true);
    expect(audit.items.some((r) => r.phase === 'execution_started')).toBe(false);
  });
});

describe('lifecycle — signature invalidation (AC-6)', () => {
  it('invalidates when the stored signature hash no longer matches', async () => {
    const { engine, store } = buildCouponFixture();

    const approval = await store.createApproval({
      record: {
        actionName: 'issueCoupon',
        input: { productId: 'p1', amount: 1 },
        signatureHash: 'STALE-HASH',
        requestedBy: 'agent-1',
        devMode: false,
      },
    });
    await store.resolveApproval({ id: approval.id, decision: 'approved', approver: csManager });

    const result = await engine.execute({ approvalId: approval.id });
    expect(result).toEqual({ status: 'invalidated', reason: 'signature' });
  });

  it('invalidates when the action no longer exists', async () => {
    const { engine, store } = buildCouponFixture();

    const approval = await store.createApproval({
      record: {
        actionName: 'ghostAction',
        input: {},
        signatureHash: 'whatever',
        requestedBy: 'agent-1',
        devMode: false,
      },
    });
    await store.resolveApproval({ id: approval.id, decision: 'approved', approver: csManager });

    const result = await engine.execute({ approvalId: approval.id });
    expect(result.status).toBe('invalidated');
  });

  it('invalidates when the staged input no longer parses against the CURRENT schema (deep drift)', async () => {
    const { engine, registry, store } = buildCouponFixture();

    const action = registry.getAction({ name: 'issueCoupon' });
    if (!action) {
      throw new Error('action missing');
    }

    const approval = await store.createApproval({
      record: {
        actionName: 'issueCoupon',
        input: { productId: 'p1', amount: 'not-a-number' },
        signatureHash: action.signatureHash,
        requestedBy: 'agent-1',
        devMode: false,
      },
    });
    await store.resolveApproval({ id: approval.id, decision: 'approved', approver: csManager });

    const result = await engine.execute({ approvalId: approval.id });
    expect(result).toEqual({ status: 'invalidated', reason: 'schema' });
  });
});

describe('lifecycle — fail-closed audit (AC-7)', () => {
  it('blocks execution when the execution_started append fails ("no record, no start")', async () => {
    const base = createMemoryStore();
    const store = wrapStoreThrowingOn({ base, phases: ['execution_started'] });

    const executeSpy = vi.fn(async () => ({ ran: true }));

    // Rebuild a fixture against the wrapped store with a spied execute.
    const fixture = buildCouponFixture();
    fixture.registry.defineAction({
      name: 'blockedAction',
      input: z.object({ note: z.string() }),
      policy: { approval: 'required' },
      execute: executeSpy,
    });
    const engine = createEngine({ registry: fixture.registry, store });

    const staged = await engine.stage({
      actionName: 'blockedAction',
      input: { note: 'x' },
      caller: agent,
    });
    if (staged.status !== 'approval_pending') {
      throw new Error('staging failed');
    }
    await engine.approve({ approvalId: staged.approvalId, approver: csManager });

    const result = await engine.execute({ approvalId: staged.approvalId });
    expect(result.status).toBe('audit_blocked');
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe('lifecycle — dev-mode stamping (AC-8)', () => {
  it('stamps devMode:true onto the audit records of a dev-mode identity', async () => {
    const fixture = buildCouponFixture();

    const staged = await fixture.engine.stage({
      actionName: 'issueCoupon',
      input: { productId: 'p1', amount: 3 },
      caller: devIdentity,
    });
    if (staged.status !== 'approval_pending') {
      throw new Error('staging failed');
    }

    await fixture.engine.approve({ approvalId: staged.approvalId, approver: devIdentity });
    await fixture.engine.execute({ approvalId: staged.approvalId });

    const audit = await fixture.store.readAudit({});
    expect(audit.items.length).toBeGreaterThan(0);
    expect(audit.items.every((r) => r.devMode === true)).toBe(true);
  });
});
