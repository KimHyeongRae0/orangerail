import type { Identity } from '../types';

/** Approval record lifecycle status (§3.4 state machine). */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed';

/** A staged approval record persisted by the store. */
export interface ApprovalRecord {
  id: string;
  actionName: string;
  input: unknown;
  signatureHash: string;
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
}
