/**
 * Cross-process race worker (§3.1 / AC-1). A separate OS process that opens the
 * shared file store and attempts to resolve one approval, printing the CAS
 * result as JSON. The parent spawns several of these concurrently and asserts
 * exactly one `ok: true` — proving single-winner semantics hold between real
 * processes, not just under JS single-threading.
 */
import { createFileStore } from '../../src/index.ts';

const dir = process.argv[2];
const id = process.argv[3];

if (dir === undefined || id === undefined) {
  throw new Error('usage: resolve-worker <dir> <approvalId>');
}

const store = createFileStore({ dir });

const result = await store.resolveApproval({
  id,
  decision: 'approved',
  approver: { subject: `pid-${process.pid}`, roles: [] },
});

process.stdout.write(JSON.stringify(result));
