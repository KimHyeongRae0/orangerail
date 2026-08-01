/**
 * ONT-070 e2e driver — `approvals show` is total (ticket §5).
 *
 * Stages a gated `delete_product` against a row whose live read carries a cycle,
 * a function-valued column and a symbol-keyed one (tests/e2e/fixtures/ont-070),
 * then drives the SHIPPED CLI (packages/cli/dist/main.js) exactly as an approver
 * would:
 *
 *   1. `approvals list`        — the queue shows the pending decision.
 *   2. `approvals show <id>`   — exit 0, the row printed, every part that could
 *                                not be printed named by key, nothing on stderr.
 *   3. `approvals show --full` — the same, uncapped: the 4 KB column arrives
 *                                whole where the default view truncated it, and
 *                                the marker list is there either way.
 *   4. `approvals reject <id>` — the decision path still works on that approval.
 *
 * No `BigInt` anywhere in the fixture, deliberately: this crash has to be fixed
 * for any unrenderable value, so leaning on the `BigInt` contract (ONT-068)
 * would prove nothing about this one.
 *
 * No database: the target read is the fixture's own resolver, which is where a
 * driver-shaped row comes from as far as this surface can tell.
 *
 * RED (pre-implementation): step 2 exits 1 with
 * `orangerail: Converting circular structure to JSON` on stderr and prints
 * nothing at all — the approver can see a decision is waiting and cannot read
 * what it is.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-070', 'config.mjs');
const STORE = join(ROOT, '.docs', 'scratch', 'ont-070-store');

const fail = ({ message }) => {
  console.error(`ONT-070 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

/** Runs the shipped CLI to completion and captures both streams. */
const runCli = ({ args }) => {
  const res = spawnSync('node', [CLI, ...args, '--config', FIXTURE], {
    cwd: ROOT,
    env: { ...process.env, ORANGERAIL_E2E_STORE: STORE },
    encoding: 'utf8',
    timeout: 30_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

rmSync(STORE, { recursive: true, force: true });
mkdirSync(STORE, { recursive: true });
process.env.ORANGERAIL_E2E_STORE = STORE;

const { createEngine } = await import('orangerail-core');
const { default: config } = await import(FIXTURE);

const staged = await createEngine({ registry: config.registry, store: config.store }).stage({
  actionName: 'delete_product',
  input: { id: 'p3' },
  caller: { subject: 'agent', roles: [] },
});

assert({
  ok: staged.status === 'approval_pending',
  message: `staging did not stage: ${staged.status}`,
});

const id = staged.approvalId;

// 1. The queue — the surface that worked all along, asserted so the fix cannot
//    buy the detail view at its expense.
const listed = runCli({ args: ['approvals', 'list'] });

assert({ ok: listed.status === 0, message: `approvals list exited ${listed.status}` });
assert({ ok: listed.stdout.includes(id), message: 'approvals list did not show the staged id' });

// 2. The screen the gate exists for.
const shown = runCli({ args: ['approvals', 'show', id] });

assert({
  ok: shown.status === 0,
  message: `approvals show exited ${shown.status}\nstderr: ${shown.stderr}`,
});
assert({
  ok: shown.stderr === '',
  message: `approvals show wrote to stderr: ${shown.stderr}`,
});

for (const expected of [
  'action:       "delete_product"',
  'target (current state, read now):',
  '"title": "Blue Mug"',
  'NOT SHOWN AS-IS',
  '$.self — a circular reference',
  '$.loadOrders — a function (loadOrders)',
  'Symbol(internal.rowVersion)',
  'input (agent-supplied):',
  '"id": "p3"',
]) {
  assert({
    ok: shown.stdout.includes(expected),
    message: `approvals show did not print ${JSON.stringify(expected)}\n--- stdout ---\n${shown.stdout}`,
  });
}

// The 4 KB column pushes the block past the default cap, so this run also
// proves the marker list survives truncation: the cut lands before `self`, and
// the approver is still told `self` is not a value.
assert({
  ok: shown.stdout.includes('TRUNCATED'),
  message: 'the default view did not cap a 4 KB row (the cap is what --full lifts)',
});

// 3. `--full` — same answer, nothing withheld.
const full = runCli({ args: ['approvals', 'show', id, '--full'] });

assert({
  ok: full.status === 0,
  message: `approvals show --full exited ${full.status}\nstderr: ${full.stderr}`,
});
assert({
  ok: full.stderr === '',
  message: `approvals show --full wrote to stderr: ${full.stderr}`,
});
assert({
  ok: !full.stdout.includes('TRUNCATED'),
  message: '--full truncated the row it exists to print whole',
});
assert({
  ok: full.stdout.includes('A'.repeat(4096)),
  message: '--full did not print the 4 KB column whole',
});
assert({
  ok: full.stdout.includes('$.self — a circular reference'),
  message: '--full lost the marker list the default view carries',
});

// 4. The decision path, on the same approval.
const rejected = runCli({ args: ['approvals', 'reject', id] });

assert({
  ok: rejected.status === 0,
  message: `approvals reject exited ${rejected.status}\nstderr: ${rejected.stderr}`,
});

const afterReject = runCli({ args: ['approvals', 'list'] });

assert({
  ok: !afterReject.stdout.includes(id),
  message: 'the rejected approval is still in the pending queue',
});

console.log('ONT-070 e2e: approvals show is total over an unrenderable target row');
