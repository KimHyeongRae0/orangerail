import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { verifyAudit } from '../src/audit/verify';
import { createEngine } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createFileStore } from '../src/store/file';
import { createMemoryStore } from '../src/store/memory';
import type { Store } from '../src/store/contract';
import type { Identity } from '../src/types';

const agent: Identity = { subject: 'agent-1', roles: ['viewer'] };
const approver: Identity = { subject: 'alice', roles: ['ops'] };

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'ont-040-'));

/**
 * A destructive action with an OBSERVABLE side effect. Every test here asserts
 * on `sideEffects` rather than on the returned status alone — the property under
 * test is "did the write actually happen", which a status string cannot prove.
 */
const buildWidgetFixture = ({ store }: { store: Store }) => {
  const sideEffects: { tag: string; widgetId: string }[] = [];

  const registry = createRegistry();
  registry.defineAction({
    name: 'deleteWidget',
    input: z.object({ widgetId: z.string(), reason: z.string() }),
    policy: { approval: 'required' },
    execute: async ({ input }) => {
      sideEffects.push({ tag: 'deleteWidget', widgetId: input.widgetId });
      return { deleted: input.widgetId };
    },
  });

  return { registry, sideEffects, engine: createEngine({ registry, store }) };
};

/** Stage one `deleteWidget` and return its approval id (throws if staging failed). */
const stageDelete = async ({
  engine,
  input,
}: {
  engine: ReturnType<typeof buildWidgetFixture>['engine'];
  input: { widgetId: string; reason: string };
}): Promise<string> => {
  const staged = await engine.stage({ actionName: 'deleteWidget', input, caller: agent });
  if (staged.status !== 'approval_pending') {
    throw new Error(`staging failed: ${staged.status}`);
  }

  return staged.approvalId;
};

/** Append a raw line to the event-sourced approvals log (the attacker's move). */
const forgeApprovalEvent = ({ dir, event }: { dir: string; event: unknown }): void => {
  appendFileSync(join(dir, 'approvals.jsonl'), `${JSON.stringify(event)}\n`);
};

describe('ONT-040 defect A — a forged approval event must not verify', () => {
  it('flags an execution whose approval has no "approved" audit record', async () => {
    // The PoC: no human ever sees the approval. One appended line flips the
    // event-sourced fold to `approved`, and `execute` runs. The tell is already
    // in the chain — `engine.approve` was never called, so no `approved` record
    // exists — and `verifyAudit` must say so.
    const dir = freshDir();
    const store = createFileStore({ dir });
    const { engine, sideEffects } = buildWidgetFixture({ store });

    const approvalId = await stageDelete({
      engine,
      input: { widgetId: 'NEVER-APPROVED-BY-A-HUMAN', reason: 'forged' },
    });

    forgeApprovalEvent({
      dir,
      event: {
        type: 'resolved',
        id: approvalId,
        decision: 'approved',
        decidedBy: 'alice@corp.com',
        decidedAt: new Date().toISOString(),
      },
    });

    const executed = await engine.execute({ approvalId });
    expect(executed.status).toBe('executed');
    expect(sideEffects).toHaveLength(1);

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.includes('no "approved" audit record'))).toBe(true);
  });

  it('flags a forged approver name on a genuinely approved approval', async () => {
    // Editing the `resolved` line puts a different name on a decision a real
    // human made. The audit chain still records who actually decided, so the
    // two logs are made to disagree by exactly the edit.
    const dir = freshDir();
    const store = createFileStore({ dir });
    const { engine } = buildWidgetFixture({ store });

    const approvalId = await stageDelete({
      engine,
      input: { widgetId: 'w-1', reason: 'real' },
    });
    await engine.approve({ approvalId, approver });

    const path = join(dir, 'approvals.jsonl');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('"decidedBy":"alice"', '"decidedBy":"mallory"'),
    );

    expect((await store.getApproval({ id: approvalId }))?.decidedBy).toBe('mallory');

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.includes('approver'))).toBe(true);
  });

  it('flags an approval injected straight into the store with no staging', async () => {
    // A fabricated `created` event bypasses stage() entirely — no schema parse,
    // no `where`, no `staged` audit record. Approving and executing it then
    // looks ordinary from the approvals log alone.
    const dir = freshDir();
    const store = createFileStore({ dir });
    const { engine } = buildWidgetFixture({ store });

    forgeApprovalEvent({
      dir,
      event: {
        type: 'created',
        record: {
          id: 'injected-1',
          actionName: 'deleteWidget',
          input: { widgetId: 'w-2', reason: 'injected' },
          signatureHash: 'sig',
          status: 'pending',
          requestedBy: 'agent-1',
          requestedByRoles: [],
          devMode: false,
          createdAt: new Date().toISOString(),
        },
      },
    });
    await engine.approve({ approvalId: 'injected-1', approver });

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.includes('no "staged" audit record'))).toBe(true);
  });

  it('flags a replayed approval (consumed event erased by a second resolve)', async () => {
    // `consumed` is an event, not a column: appending a fresh `resolved` line
    // after execution folds the record back to `approved` and re-arms it.
    const dir = freshDir();
    const store = createFileStore({ dir });
    const { engine, sideEffects } = buildWidgetFixture({ store });

    const approvalId = await stageDelete({ engine, input: { widgetId: 'w-3', reason: 'once' } });
    await engine.approve({ approvalId, approver });
    expect((await engine.execute({ approvalId })).status).toBe('executed');

    forgeApprovalEvent({
      dir,
      event: {
        type: 'resolved',
        id: approvalId,
        decision: 'approved',
        decidedBy: 'alice',
        decidedAt: new Date().toISOString(),
      },
    });

    const second = await engine.execute({ approvalId });
    expect(second.status).toBe('consume_failed');
    expect(sideEffects).toHaveLength(1);
  });

  it('flags pending approvals standing against a wiped chain', async () => {
    // Deleting audit.jsonl alone is caught by the anchored head; deleting the
    // anchor too takes the evidence with it and used to report "chain OK — 0
    // record(s)" while the queue still held approvals nobody could account for.
    // Zero records against a non-empty approvals store is inconsistent on its
    // face, and the approvals store is the witness that says so.
    const dir = freshDir();
    const store = createFileStore({ dir });
    const { engine } = buildWidgetFixture({ store });

    for (const widgetId of ['w-a', 'w-b', 'w-c']) {
      await stageDelete({ engine, input: { widgetId, reason: 'queued' } });
    }

    rmSync(join(dir, 'audit.jsonl'));
    rmSync(join(dir, 'audit.head.json'));

    const verdict = await verifyAudit({ store });
    expect(verdict.count).toBe(0);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.issues.filter((issue) => issue.includes('no "staged" audit record')),
    ).toHaveLength(3);
  });

  it('reports a clean governed write as OK (no false positive)', async () => {
    const dir = freshDir();
    const store = createFileStore({ dir });
    const { engine } = buildWidgetFixture({ store });

    const approvalId = await stageDelete({ engine, input: { widgetId: 'w-4', reason: 'ok' } });
    await engine.approve({ approvalId, approver });
    expect((await engine.execute({ approvalId })).status).toBe('executed');

    const verdict = await verifyAudit({ store });
    expect(verdict.issues).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

describe('ONT-040 defect B — the approved input must not be swappable', () => {
  it('refuses to execute an approval whose stored input was edited after approval', async () => {
    // The operator saw and approved `harmless-test-widget`. One sed later the
    // store holds `PRODUCTION-CUSTOMER-TABLE`, and step 2 compares only the
    // action's DECLARED shape — which did not change.
    const dir = freshDir();
    const store = createFileStore({ dir });
    const { engine, sideEffects } = buildWidgetFixture({ store });

    const approvalId = await stageDelete({
      engine,
      input: { widgetId: 'harmless-test-widget', reason: 'qa smoke' },
    });
    await engine.approve({ approvalId, approver });

    const path = join(dir, 'approvals.jsonl');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replaceAll('harmless-test-widget', 'PRODUCTION-CUSTOMER-TABLE'),
    );

    const executed = await engine.execute({ approvalId });
    expect(executed).toEqual({ status: 'invalidated', reason: 'input' });
    expect(sideEffects).toEqual([]);
  });

  it('flags an already-executed swap after the fact', async () => {
    // The swap ran under 0.1.0, so the side effect is done. The chain still
    // carries the approved input at `staged`/`approved` and the executed input
    // at `execution_started`/`succeeded` — two witnesses that must agree.
    const store = createMemoryStore();
    const created = await store.createApproval({
      record: {
        actionName: 'deleteWidget',
        input: { widgetId: 'harmless-test-widget', reason: 'qa smoke' },
        signatureHash: 'sig',
        requestedBy: 'agent-1',
        requestedByRoles: [],
        devMode: false,
      },
    });
    await store.resolveApproval({ id: created.id, decision: 'approved', approver });
    await store.consumeApproval({ id: created.id });

    const approved = { widgetId: 'harmless-test-widget', reason: 'qa smoke' };
    const executedInput = { widgetId: 'PRODUCTION-CUSTOMER-TABLE', reason: 'qa smoke' };
    const timestamp = new Date().toISOString();

    for (const [phase, input] of [
      ['staged', approved],
      ['approved', approved],
      ['execution_started', executedInput],
      ['succeeded', executedInput],
    ] as const) {
      await store.appendAudit({
        record: {
          phase,
          actionName: 'deleteWidget',
          approvalId: created.id,
          approver: approver.subject,
          input,
          timestamp,
        },
      });
    }

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.includes('input changed'))).toBe(true);
  });

  it('leaves a 0.1.0-era chain (no inputHash anywhere) verifying', async () => {
    // Records written before this ticket carry no input hash on either side.
    // Absence is not evidence of tampering — it must not be reported as such.
    const store = createMemoryStore();
    const created = await store.createApproval({
      record: {
        actionName: 'deleteWidget',
        input: { widgetId: 'w-5', reason: 'legacy' },
        signatureHash: 'sig',
        requestedBy: 'agent-1',
        requestedByRoles: [],
        devMode: false,
      },
    });
    const legacy: Store = {
      ...store,
      listApprovals: async () =>
        (await store.listApprovals()).map((record) => {
          const copy = { ...record };
          delete (copy as { inputHash?: string }).inputHash;
          return copy;
        }),
    };

    await store.resolveApproval({ id: created.id, decision: 'approved', approver });
    await store.consumeApproval({ id: created.id });

    const timestamp = new Date().toISOString();
    for (const phase of ['staged', 'approved', 'execution_started', 'succeeded'] as const) {
      await store.appendAudit({
        record: {
          phase,
          actionName: 'deleteWidget',
          approvalId: created.id,
          approver: approver.subject,
          input: { widgetId: 'w-5', reason: 'legacy' },
          timestamp,
        },
      });
    }

    const verdict = await verifyAudit({ store: legacy });
    expect(verdict.issues).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

describe('ONT-040 defect C — a dry-run engine causes no effects', () => {
  it('refuses to complete a live-approved approval and leaves it unconsumed', async () => {
    const store = createMemoryStore();
    const { registry, sideEffects, engine } = buildWidgetFixture({ store });
    const sandbox = createEngine({ registry, store, mode: 'dry_run' });

    const approvalId = await stageDelete({ engine, input: { widgetId: 'w-6', reason: 'live' } });
    await engine.approve({ approvalId, approver });

    expect(await sandbox.execute({ approvalId })).toEqual({ status: 'dry_run' });
    expect(sideEffects).toEqual([]);
    expect((await store.getApproval({ id: approvalId }))?.status).toBe('approved');

    // The live engine still completes it — the sandbox neither ran nor burned it.
    expect((await engine.execute({ approvalId })).status).toBe('executed');
    expect(sideEffects).toHaveLength(1);
  });
});
