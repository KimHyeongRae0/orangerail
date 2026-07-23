import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyAudit } from '../src/audit/verify';
import { createEngine } from '../src/lifecycle/engine';
import { createFileStore } from '../src/store/file';
import type { CreateApprovalInput } from '../src/store/contract';
import type { Identity } from '../src/types';
import { buildCouponFixture } from './fixtures';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..');

const approver: Identity = { subject: 'alice', roles: ['cs-manager'] };

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'ont-003-fs-'));

const pending = ({
  actionName = 'a',
  input = { x: 1 },
  requestedByRoles = [],
}: Partial<CreateApprovalInput> = {}): CreateApprovalInput => ({
  actionName,
  input,
  signatureHash: 'sig',
  requestedBy: 'agent',
  requestedByRoles,
  devMode: false,
});

describe('file store — approval contract parity', () => {
  it('creates, reads back, and lists an approval', async () => {
    const store = createFileStore({ dir: freshDir() });
    const created = await store.createApproval({
      record: pending({ requestedByRoles: ['editor'] }),
    });

    expect(created.status).toBe('pending');
    expect(created.requestedByRoles).toEqual(['editor']);

    const fetched = await store.getApproval({ id: created.id });
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.requestedByRoles).toEqual(['editor']);

    expect(await store.listPending()).toHaveLength(1);
    expect(await store.listApprovals()).toHaveLength(1);
  });

  it('returns null for a missing approval', async () => {
    const store = createFileStore({ dir: freshDir() });
    expect(await store.getApproval({ id: 'nope' })).toBeNull();
  });

  it('resolveApproval is single-winner across concurrent calls (in-process)', async () => {
    const store = createFileStore({ dir: freshDir() });
    const created = await store.createApproval({ record: pending() });

    const results = await Promise.all([
      store.resolveApproval({ id: created.id, decision: 'approved', approver }),
      store.resolveApproval({ id: created.id, decision: 'approved', approver }),
      store.resolveApproval({ id: created.id, decision: 'approved', approver }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'already_resolved')).toHaveLength(2);
  });

  it('consumeApproval CAS closes the double-execute race', async () => {
    const store = createFileStore({ dir: freshDir() });
    const created = await store.createApproval({ record: pending() });
    await store.resolveApproval({ id: created.id, decision: 'approved', approver });

    const results = await Promise.all([
      store.consumeApproval({ id: created.id }),
      store.consumeApproval({ id: created.id }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'already_consumed')).toHaveLength(1);
  });

  it('listPending excludes resolved records, listApprovals includes them', async () => {
    const store = createFileStore({ dir: freshDir() });
    const a = await store.createApproval({ record: pending() });
    await store.createApproval({ record: pending() });
    await store.resolveApproval({ id: a.id, decision: 'rejected', approver });

    expect(await store.listPending()).toHaveLength(1);
    expect(await store.listApprovals()).toHaveLength(2);
  });
});

describe('file store — audit chain', () => {
  it('links a hash chain across appends that verifyAudit accepts', async () => {
    const store = createFileStore({ dir: freshDir() });
    await store.appendAudit({
      record: { phase: 'staged', actionName: 'a', timestamp: new Date().toISOString() },
    });
    await store.appendAudit({
      record: { phase: 'approved', actionName: 'a', timestamp: new Date().toISOString() },
    });

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(true);
    expect(verdict.count).toBe(2);
  });

  it('runs the full governed lifecycle to a green chain on the file store', async () => {
    const dir = freshDir();
    const store = createFileStore({ dir });
    const { registry } = buildCouponFixture();
    const engine = createEngine({ registry, store });

    const staged = await engine.stage({
      actionName: 'issueCoupon',
      input: { productId: 'p1', amount: 4 },
      caller: { subject: 'agent', roles: ['viewer'] },
    });
    if (staged.status !== 'approval_pending') {
      throw new Error(`stage failed: ${staged.status}`);
    }

    await engine.approve({ approvalId: staged.approvalId, approver });
    const executed = await engine.execute({ approvalId: staged.approvalId });
    expect(executed.status).toBe('executed');

    expect((await verifyAudit({ store })).ok).toBe(true);
  });

  it('throws fail-closed on a torn tail line (crash mid-append)', async () => {
    const dir = freshDir();
    const store = createFileStore({ dir });
    await store.appendAudit({
      record: { phase: 'staged', actionName: 'a', timestamp: new Date().toISOString() },
    });

    appendFileSync(join(dir, 'audit.jsonl'), '{"partial":');

    await expect(
      store.appendAudit({
        record: { phase: 'approved', actionName: 'a', timestamp: new Date().toISOString() },
      }),
    ).rejects.toThrow(/corrupt JSONL/);
    await expect(store.readAudit({})).rejects.toThrow(/corrupt JSONL/);
  });
});

describe('file store — anchored-head checkpoint (§3.1, AC-1)', () => {
  it('returns null before the first append then {seq,hash,count} matching the last record', async () => {
    const dir = freshDir();
    const store = createFileStore({ dir });

    expect(await store.readAuditHead()).toBeNull();

    const first = await store.appendAudit({
      record: { phase: 'staged', actionName: 'a', timestamp: new Date().toISOString() },
    });
    expect(await store.readAuditHead()).toEqual({ seq: first.seq, hash: first.hash, count: 1 });
    expect(existsSync(join(dir, 'audit.head.json'))).toBe(true);

    const second = await store.appendAudit({
      record: { phase: 'approved', actionName: 'a', timestamp: new Date().toISOString() },
    });
    expect(await store.readAuditHead()).toEqual({ seq: second.seq, hash: second.hash, count: 2 });
  });

  it('fails verify when audit.jsonl is tail-truncated but the head file is intact (file-level PoC)', async () => {
    const dir = freshDir();
    const store = createFileStore({ dir });

    for (const phase of ['staged', 'approved', 'execution_started', 'succeeded'] as const) {
      await store.appendAudit({
        record: { phase, actionName: 'a', timestamp: new Date().toISOString() },
      });
    }
    expect((await verifyAudit({ store })).ok).toBe(true);

    // Drop the last two chain lines on disk, leaving audit.head.json intact.
    const auditPath = join(dir, 'audit.jsonl');
    const kept = readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(0, -2);
    writeFileSync(auditPath, `${kept.join('\n')}\n`);

    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.includes('truncated'))).toBe(true);
  });
});

describe('file store — process restart between staging and approval (edge case)', () => {
  it('persists the approval across a store re-open and consumes exactly once', async () => {
    const dir = freshDir();

    const staging = createFileStore({ dir });
    const created = await staging.createApproval({ record: pending() });

    // "Restart": a brand-new store instance over the same directory.
    const reopened = createFileStore({ dir });
    const fetched = await reopened.getApproval({ id: created.id });
    expect(fetched?.status).toBe('pending');

    const resolved = await reopened.resolveApproval({
      id: created.id,
      decision: 'approved',
      approver,
    });
    expect(resolved.ok).toBe(true);

    const first = await reopened.consumeApproval({ id: created.id });
    const second = await reopened.consumeApproval({ id: created.id });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });
});

describe('file store — cross-process single-winner race (real node processes)', () => {
  it('resolves exactly one winner when several OS processes contend', async () => {
    const dir = freshDir();
    const store = createFileStore({ dir });
    const created = await store.createApproval({ record: pending() });

    const worker = join(HERE, 'helpers', 'resolve-worker.mts');

    const run = (): Promise<{ ok: boolean }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', worker, dir, created.id], {
          cwd: CORE_ROOT,
          stdio: ['ignore', 'pipe', 'inherit'],
        });

        let out = '';
        child.stdout.on('data', (chunk) => {
          out += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('exit', () => {
          try {
            resolve(JSON.parse(out));
          } catch (err) {
            reject(new Error(`worker output not JSON: ${out} (${String(err)})`));
          }
        });
      });

    const results = await Promise.all([run(), run(), run(), run()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  }, 30_000);
});

describe('file store — redactAudit is audit-only (§3.9)', () => {
  const dir = freshDir();

  afterEach(() => undefined);

  it('masks audit-record input but keeps the approval record verbatim', async () => {
    const store = createFileStore({ dir });
    const { registry } = buildCouponFixture();
    const engine = createEngine({
      registry,
      store,
      redactAudit: () => '[redacted]',
    });

    const staged = await engine.stage({
      actionName: 'issueCoupon',
      input: { productId: 'p1', amount: 7 },
      caller: { subject: 'agent', roles: ['viewer'] },
    });
    if (staged.status !== 'approval_pending') {
      throw new Error('stage failed');
    }

    const approval = await store.getApproval({ id: staged.approvalId });
    expect(approval?.input).toEqual({ productId: 'p1', amount: 7 });

    const auditLines = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    const stagedRecord = auditLines.find((r) => r.phase === 'staged');
    expect(stagedRecord.input).toBe('[redacted]');
  });

  it('detects an orphaned consumed approval (consumed, no execution_started)', async () => {
    const store = createFileStore({ dir: freshDir() });
    const created = await store.createApproval({ record: pending() });
    await store.resolveApproval({ id: created.id, decision: 'approved', approver });
    await store.consumeApproval({ id: created.id });

    // No execution_started audit record was ever written (simulated crash).
    const verdict = await verifyAudit({ store });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.includes('orphaned consumed approval'))).toBe(true);
  });

  it('tampering with a persisted audit line is detected', async () => {
    const dir = freshDir();
    const store = createFileStore({ dir });
    await store.appendAudit({
      record: { phase: 'staged', actionName: 'a', timestamp: new Date().toISOString() },
    });

    const path = join(dir, 'audit.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"phase":"staged"', '"phase":"edited"'));

    expect((await verifyAudit({ store })).ok).toBe(false);
  });
});
