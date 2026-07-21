import { authorizeApprover } from '../identity/contract';
import { evaluateWhere } from '../policy/where';
import type { Registry } from '../registry';
import type { ApprovalRecord, AuditInput, AuditPhase, Store } from '../store/contract';
import type { Identity, RuntimeAction } from '../types';

/** Result of {@link Engine.execute} (also folded into {@link StageResult} for auto actions). */
export type ExecuteResult =
  | { status: 'executed'; result: unknown }
  | { status: 'consume_failed'; reason: 'not_approved' | 'not_found' | 'already_consumed' }
  | { status: 'invalidated'; reason: 'signature' | 'schema' }
  | { status: 'condition_changed' }
  | { status: 'resolve_error'; error: string }
  | { status: 'audit_blocked'; error: string }
  | { status: 'failed'; error: string };

/** Result of {@link Engine.stage}. */
export type StageResult =
  | { status: 'approval_pending'; approvalId: string }
  | { status: 'denied'; reason: 'anonymous' }
  | { status: 'not_found' }
  | { status: 'invalid_input'; issues: unknown }
  | { status: 'rejected_where' }
  | ExecuteResult;

/** Result of {@link Engine.approve}. */
export type ApproveResult =
  | { status: 'approved'; record: ApprovalRecord }
  | { status: 'denied'; reason: 'anonymous' }
  | { status: 'not_found' }
  | { status: 'rejected_role' }
  | { status: 'already_resolved' };

/** Result of {@link Engine.reject}. */
export type RejectResult =
  | { status: 'rejected' }
  | { status: 'denied'; reason: 'anonymous' }
  | { status: 'not_found' }
  | { status: 'rejected_role' }
  | { status: 'already_resolved' };

const errorMessage = ({ err }: { err: unknown }): string =>
  err instanceof Error ? err.message : String(err);

type WhereCheck = { kind: 'pass' } | { kind: 'fail' } | { kind: 'resolve_error'; error: string };

/**
 * The governed action lifecycle engine (§3.4 / §4.5). Binds a registry + store;
 * exposes stage / approve / reject / execute. The execute wrapper owns the six
 * ordered steps and the fail-closed audit invariant — it is never bypassed.
 */
export const createEngine = ({ registry, store }: { registry: Registry; store: Store }) => {
  const mkAudit = ({
    phase,
    actionName,
    approvalId,
    requestedBy,
    approver,
    input,
    result,
    error,
    devMode,
  }: {
    phase: AuditPhase;
    actionName: string;
    approvalId?: string | undefined;
    requestedBy?: string | undefined;
    approver?: string | undefined;
    input?: unknown;
    result?: unknown;
    error?: string | undefined;
    devMode?: boolean | undefined;
  }): AuditInput => ({
    phase,
    actionName,
    timestamp: new Date().toISOString(),
    ...(approvalId !== undefined ? { approvalId } : {}),
    ...(requestedBy !== undefined ? { requestedBy } : {}),
    ...(approver !== undefined ? { approver } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(devMode !== undefined ? { devMode } : {}),
  });

  const fetchTarget = async ({
    action,
    input,
  }: {
    action: RuntimeAction;
    input: unknown;
  }): Promise<
    | { kind: 'no_target' }
    | { kind: 'ok'; object: unknown }
    | { kind: 'resolve_error'; error: string }
  > => {
    const target = action.target;
    const field = action.targetIdFrom;

    if (!target?.resolve || field === undefined) {
      return { kind: 'no_target' };
    }

    const id = (input as Record<string, unknown>)[field];

    try {
      const object = await target.resolve.get({ id: String(id) });
      return { kind: 'ok', object };
    } catch (err) {
      return { kind: 'resolve_error', error: errorMessage({ err }) };
    }
  };

  const checkWhere = async ({
    action,
    input,
    identity,
  }: {
    action: RuntimeAction;
    input: unknown;
    identity: Identity;
  }): Promise<WhereCheck> => {
    const where = action.policy?.where;

    if (!where) {
      return { kind: 'pass' };
    }

    const fetched = await fetchTarget({ action, input });
    if (fetched.kind === 'resolve_error') {
      return { kind: 'resolve_error', error: fetched.error };
    }

    const object = fetched.kind === 'ok' ? fetched.object : null;

    return evaluateWhere({ where, object, input, identity }) ? { kind: 'pass' } : { kind: 'fail' };
  };

  /**
   * The audited execution wrapper shared by the approval path and auto actions.
   * `execution_started` is appended BEFORE `execute` and a failed append aborts
   * without executing ("no record, no start"). A post-execute append failure is
   * swallowed so the side effect is not hidden — it survives as an
   * `execution_started` with no terminal record for `verifyAudit` to flag.
   */
  const runExecute = async ({
    action,
    input,
    identity,
    audit,
  }: {
    action: RuntimeAction;
    input: unknown;
    identity: Identity;
    audit: {
      actionName: string;
      approvalId?: string | undefined;
      requestedBy?: string | undefined;
      approver?: string | undefined;
      input?: unknown;
      devMode?: boolean | undefined;
    };
  }): Promise<ExecuteResult> => {
    try {
      await store.appendAudit({ record: mkAudit({ ...audit, phase: 'execution_started' }) });
    } catch (err) {
      return { status: 'audit_blocked', error: errorMessage({ err }) };
    }

    try {
      const result = await action.execute({ input, identity });
      await store
        .appendAudit({ record: mkAudit({ ...audit, phase: 'succeeded', result }) })
        .catch(() => undefined);

      return { status: 'executed', result };
    } catch (err) {
      const error = errorMessage({ err });
      await store
        .appendAudit({ record: mkAudit({ ...audit, phase: 'failed', error }) })
        .catch(() => undefined);

      return { status: 'failed', error };
    }
  };

  const stage = async ({
    actionName,
    input,
    caller,
  }: {
    actionName: string;
    input: unknown;
    caller: Identity | null;
  }): Promise<StageResult> => {
    if (caller === null) {
      return { status: 'denied', reason: 'anonymous' };
    }

    const action = registry.getAction({ name: actionName });
    if (!action) {
      return { status: 'not_found' };
    }

    const parsed = action.input.safeParse(input);
    if (!parsed.success) {
      return { status: 'invalid_input', issues: parsed.error.issues };
    }

    const parsedInput: unknown = parsed.data;

    const where = await checkWhere({ action, input: parsedInput, identity: caller });
    if (where.kind === 'resolve_error') {
      await store.appendAudit({
        record: mkAudit({
          phase: 'resolve_error',
          actionName,
          requestedBy: caller.subject,
          input: parsedInput,
          error: where.error,
          devMode: caller.devMode,
        }),
      });

      return { status: 'resolve_error', error: where.error };
    }
    if (where.kind === 'fail') {
      await store.appendAudit({
        record: mkAudit({
          phase: 'rejected_where',
          actionName,
          requestedBy: caller.subject,
          input: parsedInput,
          devMode: caller.devMode,
        }),
      });

      return { status: 'rejected_where' };
    }

    // Auto action (no approval gate): run through the same audited wrapper.
    if (action.policy?.approval !== 'required') {
      return runExecute({
        action,
        input: parsedInput,
        identity: caller,
        audit: {
          actionName,
          requestedBy: caller.subject,
          input: parsedInput,
          devMode: caller.devMode,
        },
      });
    }

    const approval = await store.createApproval({
      record: {
        actionName,
        input: parsedInput,
        signatureHash: action.signatureHash,
        requestedBy: caller.subject,
        devMode: caller.devMode === true,
      },
    });

    await store.appendAudit({
      record: mkAudit({
        phase: 'staged',
        actionName,
        approvalId: approval.id,
        requestedBy: caller.subject,
        input: parsedInput,
        devMode: caller.devMode,
      }),
    });

    return { status: 'approval_pending', approvalId: approval.id };
  };

  const approve = async ({
    approvalId,
    approver,
  }: {
    approvalId: string;
    approver: Identity | null;
  }): Promise<ApproveResult> => {
    if (approver === null) {
      return { status: 'denied', reason: 'anonymous' };
    }

    const existing = await store.getApproval({ id: approvalId });
    if (!existing) {
      return { status: 'not_found' };
    }

    const action = registry.getAction({ name: existing.actionName });
    if (!authorizeApprover({ approver, roles: action?.policy?.roles })) {
      return { status: 'rejected_role' };
    }

    const res = await store.resolveApproval({ id: approvalId, decision: 'approved', approver });
    if (!res.ok) {
      return { status: res.reason === 'not_found' ? 'not_found' : 'already_resolved' };
    }

    await store.appendAudit({
      record: mkAudit({
        phase: 'approved',
        actionName: existing.actionName,
        approvalId,
        requestedBy: existing.requestedBy,
        approver: approver.subject,
        input: existing.input,
        devMode: approver.devMode,
      }),
    });

    return { status: 'approved', record: res.record };
  };

  const reject = async ({
    approvalId,
    approver,
  }: {
    approvalId: string;
    approver: Identity | null;
  }): Promise<RejectResult> => {
    if (approver === null) {
      return { status: 'denied', reason: 'anonymous' };
    }

    const existing = await store.getApproval({ id: approvalId });
    if (!existing) {
      return { status: 'not_found' };
    }

    const action = registry.getAction({ name: existing.actionName });
    if (!authorizeApprover({ approver, roles: action?.policy?.roles })) {
      return { status: 'rejected_role' };
    }

    const res = await store.resolveApproval({ id: approvalId, decision: 'rejected', approver });
    if (!res.ok) {
      return { status: res.reason === 'not_found' ? 'not_found' : 'already_resolved' };
    }

    await store.appendAudit({
      record: mkAudit({
        phase: 'rejected',
        actionName: existing.actionName,
        approvalId,
        requestedBy: existing.requestedBy,
        approver: approver.subject,
        input: existing.input,
        devMode: approver.devMode,
      }),
    });

    return { status: 'rejected' };
  };

  const execute = async ({ approvalId }: { approvalId: string }): Promise<ExecuteResult> => {
    // Step 1: consume CAS (approved -> consumed) — single-winner, closes the
    // double-execute race. A consumed approval stays consumed on every outcome.
    const consume = await store.consumeApproval({ id: approvalId });
    if (!consume.ok) {
      return { status: 'consume_failed', reason: consume.reason };
    }

    const record = consume.record;
    const action = registry.getAction({ name: record.actionName });

    const executeIdentity: Identity = {
      subject: record.requestedBy,
      roles: [],
      devMode: record.devMode,
    };

    const audit = {
      actionName: record.actionName,
      approvalId,
      requestedBy: record.requestedBy,
      approver: record.decidedBy,
      input: record.input,
      devMode: record.devMode,
    };

    // Step 2: signature check (mismatch / missing action -> invalidated).
    if (!action || action.signatureHash !== record.signatureHash) {
      await store.appendAudit({ record: mkAudit({ ...audit, phase: 'invalidated' }) });
      return { status: 'invalidated', reason: 'signature' };
    }

    // Step 3: re-parse staged input against the CURRENT schema (deep drift).
    const reparsed = action.input.safeParse(record.input);
    if (!reparsed.success) {
      await store.appendAudit({ record: mkAudit({ ...audit, phase: 'invalidated' }) });
      return { status: 'invalidated', reason: 'schema' };
    }

    const freshInput: unknown = reparsed.data;

    // Step 4: authoritative where re-evaluation (TOCTOU -> condition_changed).
    const where = await checkWhere({ action, input: freshInput, identity: executeIdentity });
    if (where.kind === 'resolve_error') {
      await store.appendAudit({
        record: mkAudit({ ...audit, phase: 'resolve_error', error: where.error }),
      });
      return { status: 'resolve_error', error: where.error };
    }
    if (where.kind === 'fail') {
      await store.appendAudit({ record: mkAudit({ ...audit, phase: 'condition_changed' }) });
      return { status: 'condition_changed' };
    }

    // Steps 5-6: execution_started (fail-closed) -> execute -> terminal record.
    return runExecute({ action, input: freshInput, identity: executeIdentity, audit });
  };

  return { stage, approve, reject, execute };
};

/** The bound lifecycle engine returned by {@link createEngine}. */
export type Engine = ReturnType<typeof createEngine>;
