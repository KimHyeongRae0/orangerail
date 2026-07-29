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
  /** Sandbox dry-run terminal record (§3.6) — the would-be input, never executed. */
  | 'dry_run'
  /** A `notImplemented` stub rejected at staging before any approval (§3.7). */
  | 'not_implemented';

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
   * `execution_started` audit record is a crash between consume and the append.
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
