import { randomUUID } from 'node:crypto';

import { GENESIS_HASH, hashAuditRecord } from '../audit/chain';
import type { Identity } from '../types';
import type {
  ApprovalRecord,
  AuditInput,
  AuditRecord,
  ConsumeApprovalResult,
  CreateApprovalInput,
  ResolveApprovalResult,
  Store,
} from './contract';

const clone = ({ record }: { record: ApprovalRecord }): ApprovalRecord => ({ ...record });

const now = (): string => new Date().toISOString();

/**
 * In-memory reference {@link Store}. CAS single-winner semantics hold because
 * each mutating operation performs its status check and write synchronously
 * (no `await` between them), so JS single-threading linearizes concurrent
 * callers — the same guarantee ONT-003's cross-process store must reproduce
 * with a lock. State is process-local and lost on restart (dev / tests only).
 */
export const createMemoryStore = (): Store => {
  const approvals = new Map<string, ApprovalRecord>();
  const audit: AuditRecord[] = [];

  const createApproval = async ({
    record,
  }: {
    record: CreateApprovalInput;
  }): Promise<ApprovalRecord> => {
    const stored: ApprovalRecord = {
      id: randomUUID(),
      actionName: record.actionName,
      input: record.input,
      signatureHash: record.signatureHash,
      status: 'pending',
      requestedBy: record.requestedBy,
      requestedByRoles: [...record.requestedByRoles],
      devMode: record.devMode,
      createdAt: now(),
    };

    approvals.set(stored.id, stored);

    return clone({ record: stored });
  };

  const getApproval = async ({ id }: { id: string }): Promise<ApprovalRecord | null> => {
    const record = approvals.get(id);

    return record ? clone({ record }) : null;
  };

  const resolveApproval = async ({
    id,
    decision,
    approver,
  }: {
    id: string;
    decision: 'approved' | 'rejected';
    approver: Identity;
  }): Promise<ResolveApprovalResult> => {
    const record = approvals.get(id);

    // Critical section: check + set with no intervening await (single-winner).
    if (!record) {
      return { ok: false, reason: 'not_found' };
    }
    if (record.status !== 'pending') {
      return { ok: false, reason: 'already_resolved' };
    }

    record.status = decision === 'approved' ? 'approved' : 'rejected';
    record.decidedBy = approver.subject;
    record.decidedAt = now();

    return { ok: true, record: clone({ record }) };
  };

  const consumeApproval = async ({ id }: { id: string }): Promise<ConsumeApprovalResult> => {
    const record = approvals.get(id);

    // Critical section: check + set with no intervening await (single-winner).
    if (!record) {
      return { ok: false, reason: 'not_found' };
    }
    if (record.status === 'consumed') {
      return { ok: false, reason: 'already_consumed' };
    }
    if (record.status !== 'approved') {
      return { ok: false, reason: 'not_approved' };
    }

    record.status = 'consumed';

    return { ok: true, record: clone({ record }) };
  };

  const listPending = async (): Promise<ApprovalRecord[]> =>
    [...approvals.values()]
      .filter((r) => r.status === 'pending')
      .map((record) => clone({ record }));

  const listApprovals = async (): Promise<ApprovalRecord[]> =>
    [...approvals.values()].map((record) => clone({ record }));

  const appendAudit = async ({ record }: { record: AuditInput }): Promise<AuditRecord> => {
    const head = audit[audit.length - 1];
    const prevHash = head ? head.hash : GENESIS_HASH;
    const seq = audit.length + 1;

    const base: Omit<AuditRecord, 'hash'> = { ...record, seq, prevHash };
    const hash = hashAuditRecord({ record: base });
    const full: AuditRecord = { ...base, hash };

    audit.push(full);

    return full;
  };

  const readAudit = async ({
    cursor,
    limit,
  }: {
    cursor?: string;
    limit?: number;
  }): Promise<{ items: AuditRecord[]; nextCursor?: string }> => {
    const start = cursor === undefined ? 0 : Number(cursor);
    const end = limit === undefined ? audit.length : Math.min(start + limit, audit.length);
    const items = audit.slice(start, end);

    return end < audit.length ? { items, nextCursor: String(end) } : { items };
  };

  return {
    createApproval,
    getApproval,
    resolveApproval,
    consumeApproval,
    listPending,
    listApprovals,
    appendAudit,
    readAudit,
  };
};
