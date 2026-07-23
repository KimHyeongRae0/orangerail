import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GENESIS_HASH, hashAuditRecord } from '../audit/chain';
import type { Identity } from '../types';
import type {
  ApprovalRecord,
  AuditHead,
  AuditInput,
  AuditRecord,
  ConsumeApprovalResult,
  CreateApprovalInput,
  ResolveApprovalResult,
  Store,
} from './contract';
import { acquireLock, isLockOwner, releaseLock, unlockStore, type UnlockResult } from './file-lock';

/**
 * Event-sourced JSONL {@link Store} for cross-process operation (§3.1). Two
 * append-only files under `dir`, guarded by the mkdir directory lock:
 *
 * - `approvals.jsonl` — approval *events* (`created` / `resolved` / `consumed`);
 *   current state is a fold. Records are never rewritten in place.
 * - `audit.jsonl` — the hash chain, one {@link AuditRecord} per line.
 *
 * Every mutation runs acquire-lock → read/fold → check CAS precondition →
 * append → release under mutual exclusion, so `resolveApproval` is
 * single-winner and `consumeApproval` closes the double-execute race across an
 * MCP process and a CLI process. `appendAudit` reads the tail hash under the
 * lock and links, so the chain cannot fork between concurrent writers. A torn
 * tail line (crash mid-append) makes reads/appends throw fail-closed — no
 * writer extends a corrupt chain and `verifyAudit` reports it as corruption.
 *
 * WARNING: inputs, execution results, and error messages are stored in
 * PLAINTEXT (see the engine's `redactAudit` hook, which masks audit records
 * only — approval records persist verbatim by design). Do not put secrets in
 * action inputs or return them from `execute`.
 */

/** A file store exposes the operator {@link unlock} recovery plus its `dir`. */
export interface FileStore extends Store {
  readonly kind: 'file';
  readonly dir: string;
  unlock: () => UnlockResult;
}

/**
 * Whether a store is a {@link FileStore} (feature detection for `store unlock`).
 * Returns `boolean` (not a type predicate) because a predicate cannot reference
 * a destructured binding; callers cast to {@link FileStore} after this passes.
 */
export const isFileStore = ({ store }: { store: Store }): boolean =>
  (store as Partial<FileStore>).kind === 'file' &&
  typeof (store as Partial<FileStore>).unlock === 'function';

type ApprovalEvent =
  | { type: 'created'; record: ApprovalRecord }
  | {
      type: 'resolved';
      id: string;
      decision: 'approved' | 'rejected';
      decidedBy: string;
      decidedAt: string;
    }
  | { type: 'consumed'; id: string };

const now = (): string => new Date().toISOString();

/** Read a JSONL file into parsed lines; missing file ⇒ `[]`; torn line ⇒ throw. */
const readJsonl = ({ path }: { path: string }): unknown[] => {
  let raw: string;

  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const lines = raw.split('\n').filter((line) => line.trim() !== '');

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`corrupt JSONL at ${path}:${index + 1} — torn or malformed line`);
    }
  });
};

/**
 * Create a cross-process JSONL file store rooted at `dir` (created lazily).
 * See the module doc for the atomicity model and the plaintext-storage warning.
 */
export const createFileStore = ({ dir }: { dir: string }): FileStore => {
  const approvalsPath = join(dir, 'approvals.jsonl');
  const auditPath = join(dir, 'audit.jsonl');
  const auditHeadPath = join(dir, 'audit.head.json');

  const foldApprovals = (): Map<string, ApprovalRecord> => {
    const events = readJsonl({ path: approvalsPath }) as ApprovalEvent[];
    const state = new Map<string, ApprovalRecord>();

    for (const event of events) {
      if (event.type === 'created') {
        state.set(event.record.id, { ...event.record });
        continue;
      }

      const record = state.get(event.id);
      if (!record) {
        continue;
      }

      if (event.type === 'resolved') {
        record.status = event.decision;
        record.decidedBy = event.decidedBy;
        record.decidedAt = event.decidedAt;
      }
      if (event.type === 'consumed') {
        record.status = 'consumed';
      }
    }

    return state;
  };

  const withLock = async <T>({
    fn,
  }: {
    fn: (args: { verify: () => void }) => Promise<T>;
  }): Promise<T> => {
    const token = await acquireLock({ dir });

    const verify = (): void => {
      if (!isLockOwner({ dir, token })) {
        throw new Error('store lock ownership lost mid-operation (out-of-band unlock?)');
      }
    };

    try {
      return await fn({ verify });
    } finally {
      releaseLock({ dir, token });
    }
  };

  const appendApprovalEvent = ({ event, verify }: { event: ApprovalEvent; verify: () => void }) => {
    verify();
    appendFileSync(approvalsPath, `${JSON.stringify(event)}\n`);
  };

  const createApproval = async ({
    record,
  }: {
    record: CreateApprovalInput;
  }): Promise<ApprovalRecord> =>
    withLock({
      fn: async ({ verify }) => {
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

        appendApprovalEvent({ event: { type: 'created', record: stored }, verify });

        return { ...stored };
      },
    });

  const getApproval = async ({ id }: { id: string }): Promise<ApprovalRecord | null> =>
    withLock({
      fn: async () => {
        const record = foldApprovals().get(id);
        return record ? { ...record } : null;
      },
    });

  const resolveApproval = async ({
    id,
    decision,
    approver,
  }: {
    id: string;
    decision: 'approved' | 'rejected';
    approver: Identity;
  }): Promise<ResolveApprovalResult> =>
    withLock({
      fn: async ({ verify }) => {
        const record = foldApprovals().get(id);

        if (!record) {
          return { ok: false, reason: 'not_found' };
        }
        if (record.status !== 'pending') {
          return { ok: false, reason: 'already_resolved' };
        }

        const decidedAt = now();
        appendApprovalEvent({
          event: { type: 'resolved', id, decision, decidedBy: approver.subject, decidedAt },
          verify,
        });

        return {
          ok: true,
          record: { ...record, status: decision, decidedBy: approver.subject, decidedAt },
        };
      },
    });

  const consumeApproval = async ({ id }: { id: string }): Promise<ConsumeApprovalResult> =>
    withLock({
      fn: async ({ verify }) => {
        const record = foldApprovals().get(id);

        if (!record) {
          return { ok: false, reason: 'not_found' };
        }
        if (record.status === 'consumed') {
          return { ok: false, reason: 'already_consumed' };
        }
        if (record.status !== 'approved') {
          return { ok: false, reason: 'not_approved' };
        }

        appendApprovalEvent({ event: { type: 'consumed', id }, verify });

        return { ok: true, record: { ...record, status: 'consumed' } };
      },
    });

  const listPending = async (): Promise<ApprovalRecord[]> =>
    withLock({
      fn: async () => [...foldApprovals().values()].filter((record) => record.status === 'pending'),
    });

  const listApprovals = async (): Promise<ApprovalRecord[]> =>
    withLock({ fn: async () => [...foldApprovals().values()] });

  const appendAudit = async ({ record }: { record: AuditInput }): Promise<AuditRecord> =>
    withLock({
      fn: async ({ verify }) => {
        const existing = readJsonl({ path: auditPath }) as AuditRecord[];
        const head = existing[existing.length - 1];
        const prevHash = head ? head.hash : GENESIS_HASH;
        const seq = head ? head.seq + 1 : 1;

        const base: Omit<AuditRecord, 'hash'> = { ...record, seq, prevHash };
        const hash = hashAuditRecord({ record: base });
        const full: AuditRecord = { ...base, hash };

        verify();
        appendFileSync(auditPath, `${JSON.stringify(full)}\n`);

        // Advance the anchored-head checkpoint for the record just appended,
        // inside the SAME lock hold so append + checkpoint are one atomic
        // critical section (§3.1). Crash-atomic: write a temp then rename (an
        // atomic replace on local filesystems), so a crash mid-write never
        // leaves a torn head file.
        const headRecord: AuditHead = { seq: full.seq, hash: full.hash, count: seq };
        const tmpPath = `${auditHeadPath}.${randomUUID()}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(headRecord));
        renameSync(tmpPath, auditHeadPath);

        return full;
      },
    });

  const readAuditHead = async (): Promise<AuditHead | null> =>
    withLock({
      fn: async () => {
        let raw: string;

        try {
          raw = readFileSync(auditHeadPath, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
          }
          throw err;
        }

        return JSON.parse(raw) as AuditHead;
      },
    });

  const readAudit = async ({
    cursor,
    limit,
  }: {
    cursor?: string;
    limit?: number;
  }): Promise<{ items: AuditRecord[]; nextCursor?: string }> =>
    withLock({
      fn: async () => {
        const all = readJsonl({ path: auditPath }) as AuditRecord[];
        const start = cursor === undefined ? 0 : Number(cursor);
        const end = limit === undefined ? all.length : Math.min(start + limit, all.length);
        const items = all.slice(start, end);

        return end < all.length ? { items, nextCursor: String(end) } : { items };
      },
    });

  return {
    kind: 'file',
    dir,
    createApproval,
    getApproval,
    resolveApproval,
    consumeApproval,
    listPending,
    listApprovals,
    appendAudit,
    readAudit,
    readAuditHead,
    unlock: () => unlockStore({ dir }),
  };
};
