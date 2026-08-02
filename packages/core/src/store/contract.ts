import type { ConformanceIssue } from '../conformance';
import type { Identity } from '../types';

/** Approval record lifecycle status (§3.4 state machine). */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed';

/** A staged approval record persisted by the store. */
export interface ApprovalRecord {
  id: string;
  actionName: string;
  input: unknown;
  signatureHash: string;
  /**
   * `hashApprovalInput(input)` as of creation — the approve-what-you-execute
   * binding (§3.4 / ONT-040). `signatureHash` covers the action's DECLARED
   * shape only, so without this an input edited in the store between approval
   * and execution runs unchallenged. Stores MUST stamp it in `createApproval`;
   * `execute` recomputes it over the input it is about to run and fails closed
   * on a mismatch.
   *
   * Optional ONLY because a record persisted by 0.1.0 carries none. `execute`
   * treats an absent hash as unverifiable and refuses (a 0.1.0 approval still
   * pending across an upgrade must be re-staged); `verifyAudit` does NOT treat
   * absence as tampering, because it cannot tell a 0.1.0 record from a stripped
   * one — that swap is caught by the staged-vs-executed input cross-check.
   */
  inputHash?: string;
  status: ApprovalStatus;
  requestedBy: string;
  /**
   * The staging caller's roles, persisted so execute-time re-evaluation
   * reconstructs the SAME identity that staged (§3.8 — closes the ONT-002
   * `roles: []` drift). A functional `where` reading `identity.roles` now
   * evaluates identically at staging and re-eval.
   */
  requestedByRoles: string[];
  devMode: boolean;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

/** Fields the engine supplies when creating an approval (store fills the rest). */
export interface CreateApprovalInput {
  actionName: string;
  input: unknown;
  signatureHash: string;
  requestedBy: string;
  requestedByRoles: string[];
  devMode: boolean;
}

/** Audit lifecycle phases (§4.7 v0 scope: the action lifecycle). */
export type AuditPhase =
  | 'staged'
  | 'approved'
  | 'rejected'
  | 'rejected_where'
  | 'resolve_error'
  | 'condition_changed'
  | 'invalidated'
  | 'execution_started'
  | 'succeeded'
  | 'failed'
  /**
   * An attempt that appended `execution_started` and then lost the consume CAS
   * to another attempt (§3.4 / ONT-069). The record is appended BEFORE the
   * claim, so the approval survives an append that fails — and so a race leaves
   * a losing `execution_started` behind. This is the loser saying so: nothing
   * ran under it, and `verifyAudit` must not count it as a second execution.
   */
  | 'execution_aborted'
  /**
   * The action ran and its terminal record could not be appended (§3.5 /
   * ONT-069) — a minimal marker carrying no input, prior or result, so it can
   * land where the full record did not. Terminal for the started->terminal
   * pairing, and its own reported issue: the chain knows a write happened and
   * cannot describe it, which is a different fact from a process that died
   * mid-execution and must not be reported as one.
   */
  | 'terminal_unrecorded'
  /** Sandbox dry-run terminal record (§3.6) — the would-be input, never executed. */
  | 'dry_run'
  /** A `notImplemented` stub rejected at staging before any approval (§3.7). */
  | 'not_implemented'
  /**
   * The `where` gate refused because the row it had to read did not match the
   * shape its object declares (§3.3 / ONT-074). Distinct from `rejected_where`
   * on purpose: that one says the condition did not hold, this one says the
   * condition could not be evaluated on the value it was handed, and the two
   * are different repairs — one is a data state, the other is a declaration
   * that stopped describing the datasource.
   *
   * Its `error` carries the field and zod's own sentence and is OPERATOR-facing
   * (§3.10): a transport answering an untrusted agent tells it WHICH field, and
   * not what the stored value was.
   */
  | 'target_nonconforming';

/**
 * The state of an action's target object as it stood immediately BEFORE the
 * write (§3.11 / ONT-057). Without it an audit record for a successful update
 * carries the input and the resulting row and nothing else, so the log can say
 * that `stock` is now `25` and cannot say what it was — the change cannot be
 * described and cannot be undone from the record.
 *
 * A discriminated union rather than a bare value, because "there was no prior
 * row" (a create, or an id that does not exist), "the prior read failed", and
 * "this action declares nothing readable" are three different facts and a
 * recovery attempt has to tell them apart. Collapsing them onto a nullable
 * field would make a failed read indistinguishable from an empty table.
 *
 * NOT a transactional snapshot. It is read on the same connection as the write
 * but not inside its transaction, so a concurrent writer landing between the
 * read and the write makes the recorded value stale. It is a witness of what
 * orangerail saw, which is what an audit log can honestly claim, and it is the
 * same value the `where` gate evaluated when the action declares one.
 */
export type AuditPrior =
  /**
   * The target existed and was read. `value` is the row as of just before the
   * write.
   *
   * `nonconforming` is present only when the row did NOT match the shape its
   * object declares and the engine already knew that — i.e. the action carried a
   * `where` gate, which is the one case that computes a conformance verdict at
   * all (ONT-074 AC-6 keeps an ungated action paying nothing for this). It is
   * carried so the record an operator reconciles from says the field was absent
   * or wrong, rather than showing a row with a field silently missing from it
   * and leaving the reader to notice.
   *
   * Dropped by {@link maskAuditPrior} whenever redaction touches the row: zod's
   * message can quote the value it refused, so a project that withheld the row
   * must not get it back one sentence at a time.
   */
  | { state: 'value'; value: unknown; nonconforming?: ConformanceIssue[] }
  /** The read succeeded and there was no such object — a create, or a stale id. */
  | { state: 'none' }
  /**
   * The read threw. The write still ran: a datasource hiccup on a best-effort
   * read must never become a failure of a write a human already approved
   * (§3.11). `error` is the full driver text and is OPERATOR-facing, exactly
   * like {@link AuditRecord.error} — a transport answering an untrusted agent
   * must not forward it.
   */
  | { state: 'unreadable'; error: string }
  /**
   * A prior value existed but audit redaction policy refused to persist it.
   * Emitted when a `redactAudit` is configured and no `redactPrior` is: the
   * project has declared its data sensitive and has said nothing about the row,
   * and a row can carry columns the input never mentions (a `password_hash`, a
   * `ssn`). Recording it under an input-shaped mask would make this feature a
   * leak. The state is persisted rather than omitted so the reader learns that
   * a value existed and policy withheld it, instead of concluding there was none.
   */
  | { state: 'withheld' }
  /**
   * Nothing was read because the action declares nothing to read: no `target`
   * object, or a target with no `resolve` contract (`no_target`), or an input
   * carrying no value at `targetIdFrom` (`no_id`). Recorded rather than omitted
   * so a record written by this version always states its own coverage — an
   * ABSENT `prior` means a pre-ONT-057 record, never "we tried and got nothing".
   */
  | { state: 'unavailable'; reason: 'no_target' | 'no_id' };

/**
 * A hash-chained audit record. `prevHash`/`hash`/`seq` are owned and computed
 * by {@link Store.appendAudit} (§3.5 chain ownership) — callers never set them.
 */
export interface AuditRecord {
  seq: number;
  phase: AuditPhase;
  actionName: string;
  approvalId?: string;
  /**
   * Correlates an auto-action's `execution_started` with its terminal record
   * (§3.2 / AC-2). Set ONLY for auto actions (no `approvalId`); `verifyAudit`
   * keys the started->terminal cross-check on `approvalId ?? correlationId`, so
   * an auto execution truncated to a bare `execution_started` is still flagged.
   * Additive + optional: records without it hash exactly as before.
   */
  correlationId?: string;
  requestedBy?: string;
  approver?: string;
  input?: unknown;
  /**
   * What the action's target looked like BEFORE the write (§3.11 / ONT-057).
   *
   * Set ONLY on `execution_started`, and deliberately not on `succeeded`. That
   * append is the fail-closed one — a throw there aborts before the approval is
   * claimed and before `execute` runs ("no record, no start") — while the
   * terminal append happens after the side effect and can only be degraded, not
   * refused. Putting the recovery value on the terminal record would lose it
   * in exactly the case where recovery matters most: the process that died
   * between the side effect and its terminal append. The pair is joined on
   * `approvalId ?? correlationId`, which `verifyAudit` already forces to exist.
   *
   * Additive + optional, following {@link AuditRecord.correlationId}: every
   * optional field is spread only when present, so a record without it hashes
   * exactly as before and a 0.1.0-era chain still verifies. `verifyAudit`
   * therefore never requires it — absence is legal forever.
   */
  prior?: AuditPrior;
  result?: unknown;
  error?: string;
  devMode?: boolean;
  timestamp: string;
  prevHash: string;
  hash: string;
}

/** The engine-supplied portion of an audit record (chain fields excluded). */
export type AuditInput = Omit<AuditRecord, 'seq' | 'prevHash' | 'hash'>;

/**
 * A monotonic high-water checkpoint of the last appended audit record (§3.1 /
 * AC-1..AC-3). Persisted OUTSIDE the chain (a separate `audit.head.json` for the
 * file store) so a naive tail-truncation of `audit.jsonl` alone is detectable.
 * `verifyAudit` applies a CONTAINMENT rule: the on-disk chain must contain a
 * record at `seq` whose `hash` matches, and be at least `seq` long — a shorter
 * or diverged chain fails; a chain LONGER than the checkpoint (the single
 * crash-between-append-and-head-write window) passes with no false positive.
 */
export interface AuditHead {
  seq: number;
  hash: string;
  count: number;
}

/** Result of the {@link Store.resolveApproval} CAS. */
export type ResolveApprovalResult =
  { ok: true; record: ApprovalRecord } | { ok: false; reason: 'already_resolved' | 'not_found' };

/** Result of the {@link Store.consumeApproval} CAS. */
export type ConsumeApprovalResult =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; reason: 'not_approved' | 'not_found' | 'already_consumed' };

/**
 * Persistence adapter for the approval queue and audit log (§4.7 / §3.5).
 *
 * Atomicity / linearization requirements a conforming store MUST satisfy — the
 * in-memory reference relies on JS single-threading; ONT-003's cross-process
 * file store must reproduce these (e.g. via a file lock):
 *
 * - `createApproval` stamps {@link ApprovalRecord.inputHash} over the supplied
 *   `input` (§3.4 / ONT-040) — a store that skips it makes every approval it
 *   creates unexecutable, because `execute` fails closed on an absent hash.
 * - `resolveApproval` is a single-winner CAS on `pending -> approved|rejected`:
 *   under concurrent calls exactly one succeeds, the rest get `already_resolved`.
 * - `consumeApproval` is a single-winner CAS on `approved -> consumed`: it
 *   closes the double-execute race.
 * - `appendAudit` OWNS chain integrity — it links each record to the current
 *   head's hash internally and MUST linearize appends so the chain stays linear
 *   even when an MCP process and a CLI process append concurrently. A throwing
 *   `appendAudit` blocks execution ("no record, no start" — §4.5).
 */
export interface Store {
  createApproval: (args: { record: CreateApprovalInput }) => Promise<ApprovalRecord>;
  getApproval: (args: { id: string }) => Promise<ApprovalRecord | null>;
  resolveApproval: (args: {
    id: string;
    decision: 'approved' | 'rejected';
    approver: Identity;
  }) => Promise<ResolveApprovalResult>;
  consumeApproval: (args: { id: string }) => Promise<ConsumeApprovalResult>;
  listPending: () => Promise<ApprovalRecord[]>;
  /**
   * Every approval record regardless of status. Feeds `verifyAudit`'s
   * orphaned-consumed cross-check (§3.2): a `consumed` approval with no
   * post-consume audit record at all. The engine appends before it claims
   * (ONT-069), so a new one of these cannot be produced by an append that
   * failed — what is left is a store that consumed an approval nothing in this
   * engine asked about, and the chains written before that ordering existed.
   */
  listApprovals: () => Promise<ApprovalRecord[]>;
  appendAudit: (args: { record: AuditInput }) => Promise<AuditRecord>;
  readAudit: (args: { cursor?: string; limit?: number }) => Promise<{
    items: AuditRecord[];
    nextCursor?: string;
  }>;
  /**
   * The persisted anchored-head checkpoint of the last appended audit record
   * (§3.1), or `null` when no record has been appended (empty store). Written
   * inside `appendAudit`'s critical section right after the chain append, so it
   * cannot fork across concurrent writers; `verifyAudit` reads it to detect
   * tail-truncation the internally-consistent chain walk cannot see.
   */
  readAuditHead: () => Promise<AuditHead | null>;
}
