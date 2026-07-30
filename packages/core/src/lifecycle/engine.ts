import { randomUUID } from 'node:crypto';

import { hashApprovalInput } from '../audit/chain';
import { isNotImplemented } from '../define/action';
import { readPublicDiagnostic, type PublicDiagnostic } from '../diagnostic';
import { authorizeApprover } from '../identity/contract';
import { evaluateWhere } from '../policy/where';
import type { Registry } from '../registry';
import type { ApprovalRecord, AuditInput, AuditPhase, Store } from '../store/contract';
import type { Identity, RuntimeAction } from '../types';

/** Engine execution mode (§3.6). `dry_run` powers the sandbox preset. */
export type EngineMode = 'live' | 'dry_run';

/**
 * Audit-only input masking hook (§3.9). Applied to `input` on audit records
 * ONLY — approval records persist verbatim (approve-what-you-execute). Never
 * called against the payload the engine actually executes.
 */
export type RedactAudit = (args: { actionName: string; input: unknown }) => unknown;

/**
 * The detail carried by every failing outcome (§3.10).
 *
 * `error` is the FULL underlying text (a driver/datasource message, a store
 * failure) and is OPERATOR-facing: it names tables, constraints, and file
 * paths. A transport that answers an untrusted agent MUST NOT forward it —
 * `orangerail-mcp` redacts it and returns `correlationId` instead.
 *
 * `correlationId` is the audit lookup key: the `approvalId` when the attempt
 * came from an approval, otherwise the id minted for this attempt and stamped
 * on its audit records. It is exactly the key `verifyAudit` pairs records on
 * (`approvalId ?? correlationId`), so an operator can find the full text in the
 * audit log from what the agent was told.
 *
 * `diagnostic` is the AGENT-facing half and is deliberately not text: it is a
 * code from a closed set (plus an identifier-shaped subject), set only where the
 * failing layer could positively classify itself. A transport may render its own
 * sentence for that code; it still must not forward `error`. Absent on any
 * failure orangerail cannot classify, which is the default.
 */
export interface FailureDetail {
  error: string;
  correlationId: string;
  diagnostic?: PublicDiagnostic;
}

/** Result of {@link Engine.execute} (also folded into {@link StageResult} for auto actions). */
export type ExecuteResult =
  | { status: 'executed'; result: unknown }
  | { status: 'consume_failed'; reason: 'not_approved' | 'not_found' | 'already_consumed' }
  /**
   * `signature` — the action's declared shape drifted; `schema` — the staged
   * input no longer parses; `input` — the staged input no longer matches the
   * `inputHash` stamped when it was approved, i.e. the payload was swapped in
   * the store after a human approved it (§3.4 / ONT-040).
   *
   * `stale_approval` — the record carries NO `inputHash` at all, so the payload
   * cannot be bound to the approval either way. Execution refuses identically
   * (§3.4 fails closed on both), but the two are not the same finding and must
   * never share a name: `input` accuses somebody of editing the store, and
   * `stale_approval` says the approval was written by a core older than the one
   * running it — the ordinary result of upgrading the `orangerail` CLI while a
   * project's own `orangerail-core` stays at `0.1.0` (ONT-058). Reporting the
   * upgrade as tampering sent one operator hunting a breach and another
   * concluding the tool could not complete a write at all.
   */
  | { status: 'invalidated'; reason: 'signature' | 'schema' | 'input' | 'stale_approval' }
  | { status: 'condition_changed' }
  /** A `dry_run` engine (sandbox preset) refuses to complete an approval (§3.6). */
  | { status: 'dry_run' }
  | ({ status: 'resolve_error' } & FailureDetail)
  | ({ status: 'audit_blocked' } & FailureDetail)
  | ({ status: 'failed' } & FailureDetail);

/** Result of {@link Engine.stage}. */
export type StageResult =
  | { status: 'approval_pending'; approvalId: string }
  | { status: 'denied'; reason: 'anonymous' }
  | { status: 'not_found' }
  | { status: 'invalid_input'; issues: unknown }
  | { status: 'rejected_where' }
  | { status: 'dry_run' }
  | { status: 'not_implemented' }
  | ExecuteResult;

/** Result of {@link Engine.approve}. */
export type ApproveResult =
  | { status: 'approved'; record: ApprovalRecord }
  | { status: 'denied'; reason: 'anonymous' }
  | { status: 'not_found' }
  | { status: 'rejected_role' }
  /** Separation-of-duty (§3.4 / AC-5): the approver is the requester (non-dev). */
  | { status: 'rejected_self' }
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

/**
 * Split a caught value into its two audiences: the full text (operator) and the
 * classification, if the throwing layer attached one (agent). Every failure
 * capture in this file goes through it, so the two never drift apart and no
 * capture can accidentally forget the diagnostic half.
 */
const failureOf = ({ err }: { err: unknown }): { error: string; diagnostic?: PublicDiagnostic } => {
  const diagnostic = readPublicDiagnostic({ error: err });

  return { error: errorMessage({ err }), ...(diagnostic ? { diagnostic } : {}) };
};

type WhereCheck =
  | { kind: 'pass' }
  | { kind: 'fail' }
  | ({ kind: 'resolve_error' } & Omit<FailureDetail, 'correlationId'>);

/**
 * The governed action lifecycle engine (§3.4 / §4.5). Binds a registry + store;
 * exposes stage / approve / reject / execute. The execute wrapper owns the
 * ordered steps and the fail-closed audit invariant — it is never bypassed.
 */
export const createEngine = ({
  registry,
  store,
  mode = 'live',
  redactAudit,
}: {
  registry: Registry;
  store: Store;
  mode?: EngineMode;
  redactAudit?: RedactAudit;
}) => {
  const mkAudit = ({
    phase,
    actionName,
    approvalId,
    correlationId,
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
    correlationId?: string | undefined;
    requestedBy?: string | undefined;
    approver?: string | undefined;
    input?: unknown;
    result?: unknown;
    error?: string | undefined;
    devMode?: boolean | undefined;
  }): AuditInput => {
    // Redaction applies to audit-record input ONLY (§3.9) — never to the
    // approval record, which the engine re-parses and executes verbatim.
    const auditInput =
      input !== undefined && redactAudit ? redactAudit({ actionName, input }) : input;

    // Every optional field is spread ONLY when present, so a record without a
    // correlationId (every existing record) hashes exactly as before (§3.2).
    return {
      phase,
      actionName,
      timestamp: new Date().toISOString(),
      ...(approvalId !== undefined ? { approvalId } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(requestedBy !== undefined ? { requestedBy } : {}),
      ...(approver !== undefined ? { approver } : {}),
      ...(auditInput !== undefined ? { input: auditInput } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(devMode !== undefined ? { devMode } : {}),
    };
  };

  const fetchTarget = async ({
    action,
    input,
  }: {
    action: RuntimeAction;
    input: unknown;
  }): Promise<
    | { kind: 'no_target' }
    | { kind: 'ok'; object: unknown }
    | ({ kind: 'resolve_error' } & Omit<FailureDetail, 'correlationId'>)
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
      return { kind: 'resolve_error', ...failureOf({ err }) };
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
      return fetched;
    }

    const object = fetched.kind === 'ok' ? fetched.object : null;

    // A functional `where` runs the user predicate verbatim (`where.ts`). Wrap
    // it so a throw fails CLOSED to a `resolve_error` — the same audited path a
    // failing `fetchTarget` already takes — instead of escaping uncaught after
    // the approval was consumed (§3.6 / AC-6). `verifyAudit` counts
    // `resolve_error` as an accounted post-consume record, so the consumed
    // approval is not left an unexplained orphan.
    try {
      return evaluateWhere({ where, object, input, identity })
        ? { kind: 'pass' }
        : { kind: 'fail' };
    } catch (err) {
      return { kind: 'resolve_error', ...failureOf({ err }) };
    }
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
    // Auto actions carry no approvalId, so the started->terminal cross-check has
    // nothing to key on. Mint a per-execute correlationId and thread it onto
    // BOTH the execution_started and the terminal record so `verifyAudit` can
    // pair them (§3.2 / AC-2). Approval-path executions keep their approvalId
    // and no correlationId — their records hash exactly as before.
    //
    // The same key is returned on every failing outcome (§3.10): it is the one
    // handle an agent can quote to an operator who then reads the full error
    // off the audit record.
    const correlationId = audit.approvalId ?? randomUUID();
    const correlated = audit.approvalId === undefined ? { ...audit, correlationId } : audit;

    try {
      await store.appendAudit({ record: mkAudit({ ...correlated, phase: 'execution_started' }) });
    } catch (err) {
      // No audit record exists for this attempt (the append is what failed), so
      // the full text has no audit home — the transport's operator sink is the
      // only place it survives.
      return { status: 'audit_blocked', error: errorMessage({ err }), correlationId };
    }

    try {
      const result = await action.execute({ input, identity });
      await store
        .appendAudit({ record: mkAudit({ ...correlated, phase: 'succeeded', result }) })
        .catch(() => undefined);

      return { status: 'executed', result };
    } catch (err) {
      const failure = failureOf({ err });
      await store
        .appendAudit({
          record: mkAudit({ ...correlated, phase: 'failed', error: failure.error }),
        })
        .catch(() => undefined);

      return { status: 'failed', ...failure, correlationId };
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
      // A staging-time resolve error precedes any approval, so there is no
      // approvalId to key the record on. Mint the correlationId here too, so
      // this failure is quotable by the agent and findable by the operator
      // (§3.10) — `verifyAudit` keys started->terminal pairing on
      // execution_started/succeeded/failed only, so a correlated
      // `resolve_error` record adds no pairing obligation.
      const correlationId = randomUUID();

      await store.appendAudit({
        record: mkAudit({
          phase: 'resolve_error',
          actionName,
          correlationId,
          requestedBy: caller.subject,
          input: parsedInput,
          error: where.error,
          devMode: caller.devMode,
        }),
      });

      return {
        status: 'resolve_error',
        error: where.error,
        correlationId,
        ...(where.diagnostic ? { diagnostic: where.diagnostic } : {}),
      };
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

    // notImplemented stub (§3.7): rejected at staging, before any approval
    // record exists — routing a stub through approval would burn approver
    // attention on an action that can never run. Audited, then actionable
    // feedback to the agent.
    if (isNotImplemented({ execute: action.execute })) {
      await store.appendAudit({
        record: mkAudit({
          phase: 'not_implemented',
          actionName,
          requestedBy: caller.subject,
          input: parsedInput,
          devMode: caller.devMode,
        }),
      });

      return { status: 'not_implemented' };
    }

    // Sandbox dry-run (§3.6): identical path through auth/input/where, then a
    // terminal `dry_run` audit record instead of createApproval/execute — the
    // real approval flow is exercised by the approval-for-writes preset.
    if (mode === 'dry_run') {
      await store.appendAudit({
        record: mkAudit({
          phase: 'dry_run',
          actionName,
          requestedBy: caller.subject,
          input: parsedInput,
          devMode: caller.devMode,
        }),
      });

      return { status: 'dry_run' };
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
        requestedByRoles: [...caller.roles],
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

    // Separation of duty (§3.4 / AC-5): a real (non-dev) identity may not
    // approve its own staging. Pre-CAS and non-consuming — like the wrong-role
    // early return, the approval stays `pending`. Dev mode (itself an explicit
    // opt-in, §3.3) is the config-gated exception: a local operator holding all
    // roles implicitly may stage-and-approve.
    if (approver.devMode !== true && approver.subject === existing.requestedBy) {
      return { status: 'rejected_self' };
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
    // Step 0: sandbox dry-run (§3.6). `stage` has always branched on the mode,
    // but `execute` did not — so a sandbox server sharing a store with a live
    // one really completed approvals the live server staged, and the preset
    // whose entire point is "this server cannot cause effects" caused them
    // (ONT-040). BEFORE the consume CAS, so the sandbox does not burn a live
    // approval either: the approval stays `approved` and the live engine can
    // still complete it.
    if (mode === 'dry_run') {
      const record = await store.getApproval({ id: approvalId });

      await store.appendAudit({
        record: mkAudit({
          phase: 'dry_run',
          actionName: record?.actionName ?? 'unknown',
          approvalId,
          ...(record ? { requestedBy: record.requestedBy, input: record.input } : {}),
        }),
      });

      return { status: 'dry_run' };
    }

    // Step 1: consume CAS (approved -> consumed) — single-winner, closes the
    // double-execute race. A consumed approval stays consumed on every outcome.
    const consume = await store.consumeApproval({ id: approvalId });
    if (!consume.ok) {
      return { status: 'consume_failed', reason: consume.reason };
    }

    const record = consume.record;
    const action = registry.getAction({ name: record.actionName });

    // Reconstruct the SAME identity that staged (§3.8): persisted roles, not
    // an empty set — a functional `where` reading `identity.roles` evaluates
    // identically at staging and re-eval (closes the ONT-002 drift).
    const executeIdentity: Identity = {
      subject: record.requestedBy,
      roles: [...record.requestedByRoles],
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

    // Step 2: approve-what-you-execute (§3.4 / ONT-040). `signatureHash` covers
    // the action's DECLARED shape, never the staged payload, so on its own it
    // lets an input edited in the store between approval and execution run: the
    // operator approves `harmless-test-widget` and the engine deletes
    // `PRODUCTION-CUSTOMER-TABLE`. Re-hash the payload about to run and require
    // it to match the hash stamped at `createApproval`.
    //
    // An ABSENT hash is a record persisted by 0.1.0 (or by a store that does not
    // honor the contract) and is unverifiable, so it refuses too — nothing
    // executes on a payload whose approval cannot be bound to it. The approval
    // is already consumed here, exactly as on a signature/schema mismatch: a
    // tampered approval is spent, not retried.
    //
    // It refuses under its OWN reason, though (ONT-058). Failing closed was
    // always right; folding the two into `input` was not. Absence is a definite
    // statement about WHO WROTE the record — no core that stamps the hash can
    // produce it — so it identifies a version skew between the core that
    // created the approval and the core executing it, which is a thing an
    // operator fixes in a minute once told. Presence-but-mismatch is a
    // statement about somebody having edited an approved payload. Answering
    // both with "the payload was swapped after a human approved it" is how a
    // routine CLI upgrade reads as a break-in, and how a project whose every
    // governed write had stopped got diagnosed as a policy decision.
    if (record.inputHash === undefined) {
      await store.appendAudit({ record: mkAudit({ ...audit, phase: 'invalidated' }) });
      return { status: 'invalidated', reason: 'stale_approval' };
    }

    if (record.inputHash !== hashApprovalInput({ input: record.input })) {
      await store.appendAudit({ record: mkAudit({ ...audit, phase: 'invalidated' }) });
      return { status: 'invalidated', reason: 'input' };
    }

    // Step 3: signature check (mismatch / missing action -> invalidated).
    if (!action || action.signatureHash !== record.signatureHash) {
      await store.appendAudit({ record: mkAudit({ ...audit, phase: 'invalidated' }) });
      return { status: 'invalidated', reason: 'signature' };
    }

    // Step 4: re-parse staged input against the CURRENT schema (deep drift).
    const reparsed = action.input.safeParse(record.input);
    if (!reparsed.success) {
      await store.appendAudit({ record: mkAudit({ ...audit, phase: 'invalidated' }) });
      return { status: 'invalidated', reason: 'schema' };
    }

    const freshInput: unknown = reparsed.data;

    // Step 5: authoritative where re-evaluation (TOCTOU -> condition_changed).
    const where = await checkWhere({ action, input: freshInput, identity: executeIdentity });
    if (where.kind === 'resolve_error') {
      await store.appendAudit({
        record: mkAudit({ ...audit, phase: 'resolve_error', error: where.error }),
      });
      // On the approval path the approvalId IS the correlation key (§3.10).
      return {
        status: 'resolve_error',
        error: where.error,
        correlationId: approvalId,
        ...(where.diagnostic ? { diagnostic: where.diagnostic } : {}),
      };
    }
    if (where.kind === 'fail') {
      await store.appendAudit({ record: mkAudit({ ...audit, phase: 'condition_changed' }) });
      return { status: 'condition_changed' };
    }

    // Steps 6-7: execution_started (fail-closed) -> execute -> terminal record.
    return runExecute({ action, input: freshInput, identity: executeIdentity, audit });
  };

  return { stage, approve, reject, execute };
};

/** The bound lifecycle engine returned by {@link createEngine}. */
export type Engine = ReturnType<typeof createEngine>;
