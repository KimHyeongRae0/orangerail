import { randomUUID } from 'node:crypto';

import { hashApprovalInput, persistedForm } from '../audit/chain';
import { isNotImplemented } from '../define/action';
import { readPublicDiagnostic, type PublicDiagnostic } from '../diagnostic';
import { authorizeApprover } from '../identity/contract';
import { evaluateWhere } from '../policy/where';
import type { Registry } from '../registry';
import type {
  ApprovalRecord,
  AuditInput,
  AuditPhase,
  AuditPrior,
  ConsumeApprovalResult,
  Store,
} from '../store/contract';
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
 * Audit-only masking hook for the PRIOR target row (§3.9 / ONT-057). Separate
 * from {@link RedactAudit} on purpose, and the separation is the safety property
 * rather than an API accident.
 *
 * `redactAudit` is written against an action's INPUT. A prior row is a different
 * shape: it carries every column the object declares, including ones no input
 * ever mentions. Handing a row to an input-shaped redactor would mask the fields
 * it happens to know and silently publish the rest — a `password_hash` that
 * never appears in an `updateUser` input would land in the audit log the first
 * time this feature shipped. There is no way to ask a function whether it
 * handles a shape it was not written for, so the opt-in is explicit: supply this
 * and the row is masked by it; supply only `redactAudit` and the row is withheld
 * (`{ state: 'withheld' }`) rather than guessed at.
 *
 * Returning `undefined` is read as "mask the whole thing" and also yields
 * `withheld` — a `value` of `undefined` would serialize away and be
 * indistinguishable from a row that was never read.
 *
 * To opt a project back into verbatim rows after configuring `redactAudit`,
 * pass the identity: `redactPrior: ({ prior }) => prior`.
 */
export type RedactPrior = (args: { actionName: string; prior: unknown }) => unknown;

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
  /**
   * The side effect LANDED and the chain holds no terminal record for it — not
   * even the minimal marker, so the store is refusing every write (§3.5 /
   * ONT-069). `result` is the action's own return value and is carried so a
   * caller can still hand it back; the outcome is not `executed` because
   * answering "success" for a write nothing recorded is the silent path this
   * status exists to remove. A caller MUST NOT retry it: the write is done.
   */
  | ({ status: 'audit_unrecorded'; result: unknown } & FailureDetail)
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

/**
 * How the engine reads the target of an action — the ONE read path, shared by
 * the `where` gate and the prior-state capture (§3.11) so the two can never
 * disagree about which row this action is about.
 */
export type TargetFetch =
  | { kind: 'no_target'; reason: 'no_target' | 'no_id' }
  | { kind: 'ok'; object: unknown }
  | ({ kind: 'resolve_error' } & Omit<FailureDetail, 'correlationId'>);

/**
 * Read the action's target through the read contract the ontology already
 * declares (`target.resolve.get`, keyed by `targetIdFrom`). Module-scope and
 * exported because the CLI's approver view reads the same row the same way —
 * two spellings of "the object this action is about" is one more than the
 * design can afford.
 *
 * A missing id VALUE short-circuits instead of issuing `get(String(undefined))`.
 * `where` is unaffected — it maps every non-`ok` fetch to a `null` object
 * either way — and the datasource stops being asked about a row the input never
 * named.
 */
export const fetchTarget = async ({
  action,
  input,
}: {
  action: RuntimeAction;
  input: unknown;
}): Promise<TargetFetch> => {
  const target = action.target;
  const field = action.targetIdFrom;

  if (!target?.resolve || field === undefined) {
    return { kind: 'no_target', reason: 'no_target' };
  }

  const id = (input as Record<string, unknown>)[field];
  if (id === undefined || id === null) {
    return { kind: 'no_target', reason: 'no_id' };
  }

  try {
    const object = await target.resolve.get({ id: String(id) });
    return { kind: 'ok', object };
  } catch (err) {
    return { kind: 'resolve_error', ...failureOf({ err }) };
  }
};

/**
 * The prior state of an action's target, derived from what the ontology already
 * declares (§3.11 / ONT-057).
 *
 * The engine is generic and cannot know how to read an arbitrary action's
 * target — but an ontology that declares `target` + `targetIdFrom` + a
 * `resolve.get` has already said exactly that, and `where` has been calling it
 * since §3.1. Deriving the prior value from the SAME declaration is why a
 * generated Prisma `update` and a hand-written one both get recoverability with
 * nothing new to remember, and why a record's `prior` describes the row the
 * gate approved rather than some second opinion about it.
 *
 * `fetched` lets a caller hand in a read it already performed (the `where`
 * gate's), so a gated action pays no extra round-trip at all.
 */
export const readActionPrior = async ({
  action,
  input,
  fetched,
}: {
  action: RuntimeAction;
  input: unknown;
  fetched?: TargetFetch | undefined;
}): Promise<AuditPrior> => {
  const target = fetched ?? (await fetchTarget({ action, input }));

  if (target.kind === 'no_target') {
    return { state: 'unavailable', reason: target.reason };
  }

  // A read that threw is recorded and moved past. Failing the write here would
  // trade a governed side effect a human already approved for a hiccup on a
  // best-effort read — the audit log would gain nothing and the operator would
  // lose the write (§3.11).
  if (target.kind === 'resolve_error') {
    return { state: 'unreadable', error: target.error };
  }

  return target.object === null || target.object === undefined
    ? { state: 'none' }
    : { state: 'value', value: target.object };
};

/**
 * Apply audit redaction policy to a prior value (§3.9). Exported so the CLI's
 * approver view masks exactly what the audit log would — one definition of the
 * policy, or the two surfaces drift and the safer-looking one is the lie.
 *
 * Fail-closed by construction: a project that configured `redactAudit` and no
 * `redactPrior` has declared its data sensitive and said nothing about rows, so
 * the row is withheld rather than published under a mask written for a
 * different shape. See {@link RedactPrior}.
 */
export const maskAuditPrior = ({
  actionName,
  prior,
  redactAudit,
  redactPrior,
}: {
  actionName: string;
  prior: AuditPrior;
  redactAudit?: RedactAudit | undefined;
  redactPrior?: RedactPrior | undefined;
}): AuditPrior => {
  if (prior.state !== 'value') {
    // `unreadable` carries driver text and is deliberately NOT masked here: it
    // is the same operator-facing text the record's existing `error` field has
    // always carried unredacted, so withholding this one copy would buy no
    // confidentiality while costing the only explanation of a missing row.
    return prior;
  }

  if (redactPrior) {
    const masked = redactPrior({ actionName, prior: prior.value });

    return masked === undefined ? { state: 'withheld' } : { state: 'value', value: masked };
  }

  return redactAudit ? { state: 'withheld' } : prior;
};

/**
 * Render a prior state into the form the store will hold (§3.5 / ONT-069). Only
 * the `value` arm carries caller data; the other arms are the engine's own
 * closed vocabulary and are already persistable.
 */
const persistedPrior = ({ prior }: { prior: AuditPrior }): AuditPrior =>
  prior.state === 'value'
    ? { state: 'value', value: persistedForm({ value: prior.value }) }
    : prior;

type WhereCheck =
  | { kind: 'pass'; target?: TargetFetch | undefined }
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
  redactPrior,
}: {
  registry: Registry;
  store: Store;
  mode?: EngineMode;
  redactAudit?: RedactAudit;
  redactPrior?: RedactPrior;
}) => {
  const mkAudit = ({
    phase,
    actionName,
    approvalId,
    correlationId,
    requestedBy,
    approver,
    input,
    prior,
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
    prior?: AuditPrior | undefined;
    result?: unknown;
    error?: string | undefined;
    devMode?: boolean | undefined;
  }): AuditInput => {
    // Redaction applies to audit-record input ONLY (§3.9) — never to the
    // approval record, which the engine re-parses and executes verbatim.
    const auditInput =
      input !== undefined && redactAudit ? redactAudit({ actionName, input }) : input;

    // Both masks live here, so §3.9 has exactly one home in the engine and a
    // new audited field cannot be added past redaction by accident. A throwing
    // redactor takes the same route it always has: mkAudit throws, the append
    // that wraps it fails, and `runExecute` returns `audit_blocked` WITHOUT
    // executing — redaction fails closed rather than open.
    const auditPrior =
      prior !== undefined
        ? maskAuditPrior({ actionName, prior, redactAudit, redactPrior })
        : undefined;

    // Every value the caller supplies is rendered into its persisted form HERE,
    // before it can reach the store (§3.5 / ONT-069). A value JSON refuses —
    // `execute` returning a row with a self-reference, a driver id that came
    // back as a BigInt — used to throw from inside `appendAudit`, which meant
    // the write had happened and the chain said nothing about it. An audit
    // record that states what it could not render is worth incomparably more
    // than an append that refuses to happen; see `persistedForm`. An ordinary
    // value round-trips unchanged, so existing chains hash bit-for-bit as
    // before.
    //
    // Every optional field is spread ONLY when present, so a record without a
    // correlationId or a prior (every existing record) hashes exactly as
    // before (§3.2 / §3.11).
    return {
      phase,
      actionName,
      timestamp: new Date().toISOString(),
      ...(approvalId !== undefined ? { approvalId } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(requestedBy !== undefined ? { requestedBy } : {}),
      ...(approver !== undefined ? { approver } : {}),
      ...(auditInput !== undefined ? { input: persistedForm({ value: auditInput }) } : {}),
      ...(auditPrior !== undefined ? { prior: persistedPrior({ prior: auditPrior }) } : {}),
      ...(result !== undefined ? { result: persistedForm({ value: result }) } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(devMode !== undefined ? { devMode } : {}),
    };
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

    // No gate, no read. The prior-state capture then does its own fetch in
    // `runExecute`; an un-gated action is exactly the case ONT-057 exists for,
    // so it is also the only case that pays for the extra round-trip.
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
      // The fetch rides along on a pass so `runExecute` records the row the
      // gate just approved, rather than re-reading and recording a possibly
      // different one. Zero extra round-trips for a gated action (§3.11 cost).
      return evaluateWhere({ where, object, input, identity })
        ? { kind: 'pass', target: fetched }
        : { kind: 'fail' };
    } catch (err) {
      return { kind: 'resolve_error', ...failureOf({ err }) };
    }
  };

  /**
   * Append the terminal record of an execution that ALREADY HAPPENED, in the
   * only order that keeps the side effect describable (§3.5 / ONT-069).
   *
   * The full record is tried first. If the store refuses it, the fallback is a
   * `terminal_unrecorded` marker carrying no input, no prior and no result —
   * the smallest record that still names the execution — because a store can
   * refuse a payload and accept a marker, and a chain that says "this ran and
   * the outcome is missing" is the difference between an operator reconciling
   * one row and an operator not knowing there is a row.
   *
   * This is where a `.catch(() => undefined)` used to be. Swallowing it was
   * argued as "do not hide the side effect"; measured, it did the opposite —
   * the row landed, the agent was told the call failed, and the chain held an
   * `execution_started` with nothing after it.
   */
  const appendTerminal = async ({
    record,
    marker,
  }: {
    record: AuditInput;
    marker: (args: { error: string }) => AuditInput;
  }): Promise<
    { outcome: 'recorded' } | { outcome: 'marked' } | { outcome: 'silent'; error: string }
  > => {
    try {
      await store.appendAudit({ record });

      return { outcome: 'recorded' };
    } catch (err) {
      const error = errorMessage({ err });

      try {
        await store.appendAudit({ record: marker({ error }) });

        return { outcome: 'marked' };
      } catch {
        return { outcome: 'silent', error };
      }
    }
  };

  /**
   * The audited execution wrapper shared by the approval path and auto actions.
   *
   * The order is: capture the prior state, append `execution_started`, CLAIM the
   * approval, execute, append the terminal record. A failed `execution_started`
   * append aborts without executing ("no record, no start") and — because the
   * claim has not happened yet — without spending the approval, so the operator
   * fixes the store and the same approval still runs (§3.4 / ONT-069). The
   * claim stays a single-winner CAS immediately before `execute`, so two
   * concurrent callers still cannot both execute; the loser says so with an
   * `execution_aborted` record for the `execution_started` it already wrote.
   *
   * The prior state (§3.11) is read BEFORE the `execution_started` append so the
   * value is durable before the side effect can happen, and stamped on that
   * record rather than the terminal one for the same reason.
   */
  const runExecute = async ({
    action,
    input,
    identity,
    target,
    audit,
    claim,
  }: {
    action: RuntimeAction;
    input: unknown;
    identity: Identity;
    /** A target read the `where` gate already performed, when there was one. */
    target?: TargetFetch | undefined;
    audit: {
      actionName: string;
      approvalId?: string | undefined;
      requestedBy?: string | undefined;
      approver?: string | undefined;
      input?: unknown;
      devMode?: boolean | undefined;
    };
    /**
     * The single-winner claim on the approval, run after `execution_started` is
     * durable and before `execute`. Absent for an auto action, which has no
     * approval to claim.
     */
    claim?: (() => Promise<ConsumeApprovalResult>) | undefined;
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

    // One read, on the same connection the write is about to use, and never
    // inside its transaction — `execute` is arbitrary user code and orangerail
    // has no transaction to enlist in. Free when a `where` gate already fetched
    // the row; skipped entirely when the action declares no readable target.
    const prior = await readActionPrior({ action, input, fetched: target });

    try {
      await store.appendAudit({
        record: mkAudit({ ...correlated, phase: 'execution_started', prior }),
      });
    } catch (err) {
      // No audit record exists for this attempt (the append is what failed), so
      // the full text has no audit home — the transport's operator sink is the
      // only place it survives. Nothing was claimed and nothing ran: the
      // approval behind this attempt is still exactly as the human left it.
      return { status: 'audit_blocked', error: errorMessage({ err }), correlationId };
    }

    // The smallest record that still identifies this attempt — the shape both
    // the abort and the unrecorded-terminal markers take, because the whole
    // point of a marker is that it can land where a fuller record did not.
    const bare = {
      actionName: audit.actionName,
      ...(audit.approvalId !== undefined ? { approvalId: audit.approvalId } : { correlationId }),
      ...(audit.devMode !== undefined ? { devMode: audit.devMode } : {}),
    };

    if (claim) {
      const claimed = await claim();

      if (!claimed.ok) {
        // Another attempt holds the approval. Say so against the
        // `execution_started` this attempt already wrote, or the chain reads as
        // two executions of a single-use approval — which is the tamper tell
        // `verifyAudit` keys on and must keep meaning what it says. If even this
        // append fails there is nothing further to write; the extra started
        // record is then reported, loudly and wrongly, as a replay.
        await store
          .appendAudit({
            record: mkAudit({
              ...bare,
              phase: 'execution_aborted',
              error: `the approval was claimed by another attempt (${claimed.reason}); nothing was executed`,
            }),
          })
          .catch(() => undefined);

        return { status: 'consume_failed', reason: claimed.reason };
      }
    }

    try {
      const result = await action.execute({ input, identity });
      const terminal = await appendTerminal({
        record: mkAudit({ ...correlated, phase: 'succeeded', result }),
        marker: ({ error }) =>
          mkAudit({
            ...bare,
            phase: 'terminal_unrecorded',
            error: `the action succeeded and its terminal record could not be appended: ${error}`,
          }),
      });

      return terminal.outcome === 'silent'
        ? { status: 'audit_unrecorded', result, error: terminal.error, correlationId }
        : { status: 'executed', result };
    } catch (err) {
      const failure = failureOf({ err });
      await appendTerminal({
        record: mkAudit({ ...correlated, phase: 'failed', error: failure.error }),
        marker: ({ error }) =>
          mkAudit({
            ...bare,
            phase: 'terminal_unrecorded',
            error: `the action failed and its terminal record could not be appended: ${error}`,
          }),
      });

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
        target: where.target,
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

    // Step 1: READ the approval — no claim yet (§3.4 / ONT-069). The consume CAS
    // used to run here, which meant every step below it spent the approval
    // before anything had been written down: when the `execution_started`
    // append then failed, the approval was gone, `check_approval` answered
    // "Already executed (consumed)." about an execution that never happened,
    // `approvals approve` refused with `already_resolved`, and `audit verify`
    // failed forever. An approval that could not be executed must remain
    // executable, so the claim moved to the last moment before `execute` runs
    // — after the record that describes it is durable.
    //
    // This is a read, not a claim, so it cannot decide a race. The steps below
    // each end in their own CAS, and the happy path hands one to `runExecute`.
    const record = await store.getApproval({ id: approvalId });
    if (!record) {
      return { status: 'consume_failed', reason: 'not_found' };
    }
    if (record.status !== 'approved') {
      return {
        status: 'consume_failed',
        reason: record.status === 'consumed' ? 'already_consumed' : 'not_approved',
      };
    }

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

    /**
     * A pre-execute refusal: record it, THEN spend the approval.
     *
     * Spending it is the ONT-040 rule — a tampered approval is spent, not
     * retried — and this order keeps that rule while removing the window it
     * used to carry. Consuming first and appending second is how a refusal
     * ended up as a `consumed` approval with nothing on the chain to explain
     * it; appending first means a store that cannot record the refusal leaves
     * the approval exactly as the human left it. A CAS that loses here lost to
     * another attempt that already spent it, which is the same outcome.
     */
    const abort = async ({
      phase,
      error,
    }: {
      phase: AuditPhase;
      error?: string;
    }): Promise<void> => {
      await store.appendAudit({
        record: mkAudit({ ...audit, phase, ...(error !== undefined ? { error } : {}) }),
      });

      await store.consumeApproval({ id: approvalId });
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
      await abort({ phase: 'invalidated' });
      return { status: 'invalidated', reason: 'stale_approval' };
    }

    if (record.inputHash !== hashApprovalInput({ input: record.input })) {
      await abort({ phase: 'invalidated' });
      return { status: 'invalidated', reason: 'input' };
    }

    // Step 3: signature check (mismatch / missing action -> invalidated).
    if (!action || action.signatureHash !== record.signatureHash) {
      await abort({ phase: 'invalidated' });
      return { status: 'invalidated', reason: 'signature' };
    }

    // Step 4: re-parse staged input against the CURRENT schema (deep drift).
    const reparsed = action.input.safeParse(record.input);
    if (!reparsed.success) {
      await abort({ phase: 'invalidated' });
      return { status: 'invalidated', reason: 'schema' };
    }

    const freshInput: unknown = reparsed.data;

    // Step 5: authoritative where re-evaluation (TOCTOU -> condition_changed).
    const where = await checkWhere({ action, input: freshInput, identity: executeIdentity });
    if (where.kind === 'resolve_error') {
      await abort({ phase: 'resolve_error', error: where.error });
      // On the approval path the approvalId IS the correlation key (§3.10).
      return {
        status: 'resolve_error',
        error: where.error,
        correlationId: approvalId,
        ...(where.diagnostic ? { diagnostic: where.diagnostic } : {}),
      };
    }
    if (where.kind === 'fail') {
      await abort({ phase: 'condition_changed' });
      return { status: 'condition_changed' };
    }

    // Steps 6-7: execution_started (fail-closed) -> claim -> execute -> terminal
    // record. The claim is handed down rather than performed here so nothing can
    // execute between the record and the CAS (§3.4 / ONT-069).
    return runExecute({
      action,
      input: freshInput,
      identity: executeIdentity,
      target: where.target,
      audit,
      claim: async () => store.consumeApproval({ id: approvalId }),
    });
  };

  return { stage, approve, reject, execute };
};

/** The bound lifecycle engine returned by {@link createEngine}. */
export type Engine = ReturnType<typeof createEngine>;
