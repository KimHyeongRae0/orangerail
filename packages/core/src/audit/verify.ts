import type { AuditRecord, Store } from '../store/contract';
import { GENESIS_HASH, hashAuditRecord } from './chain';

/** Outcome of {@link verifyAudit}: `ok` plus a human-readable issue list. */
export interface AuditVerifyResult {
  ok: boolean;
  issues: string[];
  count: number;
}

const readAll = async ({ store }: { store: Store }): Promise<AuditRecord[]> => {
  const all: AuditRecord[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await store.readAudit(cursor === undefined ? {} : { cursor });
    all.push(...page.items);

    if (page.nextCursor === undefined) {
      break;
    }

    cursor = page.nextCursor;
  }

  return all;
};

/**
 * Walk the audit chain and report integrity issues (§3.5 / AC-7):
 *
 * - each record's `prevHash` must equal the prior record's `hash` (genesis for
 *   the first) — a break means deletion or reordering;
 * - each record's `hash` must equal a recomputation over its content — a
 *   mismatch means the record was tampered with;
 * - every `execution_started` must have a matching `succeeded`/`failed` for the
 *   same approval — a gap means an incomplete execution (side effect without a
 *   terminal record);
 * - every `consumed` approval must have an `execution_started` record — a gap
 *   means a crash between `consumeApproval` and the audit append (§3.2 third
 *   check, AC-5). An empty store verifies.
 */
export const verifyAudit = async ({ store }: { store: Store }): Promise<AuditVerifyResult> => {
  const records = await readAll({ store });
  const issues: string[] = [];

  let prev = GENESIS_HASH;

  for (const record of records) {
    if (record.prevHash !== prev) {
      issues.push(`chain break at seq ${record.seq}: prevHash does not match the previous record`);
    }

    const { hash, ...rest } = record;
    const recomputed = hashAuditRecord({ record: rest });
    if (recomputed !== hash) {
      issues.push(`tampered record at seq ${record.seq}: hash mismatch`);
    }

    prev = record.hash;
  }

  const started = new Set<string>();
  const finished = new Set<string>();

  for (const record of records) {
    if (record.approvalId === undefined) {
      continue;
    }

    if (record.phase === 'execution_started') {
      started.add(record.approvalId);
    }
    if (record.phase === 'succeeded' || record.phase === 'failed') {
      finished.add(record.approvalId);
    }
  }

  for (const approvalId of started) {
    if (!finished.has(approvalId)) {
      issues.push(`incomplete execution for approval ${approvalId}: started but never finished`);
    }
  }

  // A consumed approval is accounted-for once execute has appended ANY of its
  // post-consume outcomes (execution_started, or a pre-execute abort:
  // invalidated / condition_changed / resolve_error). A consumed approval with
  // none of these is a crash between consumeApproval and that append (§3.2).
  const accounted = new Set<string>();
  for (const record of records) {
    if (record.approvalId === undefined) {
      continue;
    }
    if (
      record.phase === 'execution_started' ||
      record.phase === 'invalidated' ||
      record.phase === 'condition_changed' ||
      record.phase === 'resolve_error'
    ) {
      accounted.add(record.approvalId);
    }
  }

  const approvals = await store.listApprovals();
  for (const approval of approvals) {
    if (approval.status === 'consumed' && !accounted.has(approval.id)) {
      issues.push(
        `orphaned consumed approval ${approval.id}: consumed but no post-consume audit record`,
      );
    }
  }

  return { ok: issues.length === 0, issues, count: records.length };
};
