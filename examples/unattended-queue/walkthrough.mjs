/**
 * A back-office queue worked with nobody watching.
 *
 * Fifteen items are handed to an agent whose operator has left for the day. Twelve
 * are ordinary reversible writes and three are deletions. The point of the run is
 * not that the deletions are refused — it is that everything else FINISHES, and the
 * three that stop leave behind an object a different person can act on tomorrow.
 *
 * The client is a REAL MCP client (@modelcontextprotocol/sdk, the same one an agent
 * host uses), and every step is asserted, so this is an e2e rather than theatre. The
 * queue is scripted rather than driven by a model on purpose: the behaviour being
 * demonstrated is the server's, and a scripted client makes the run deterministic and
 * free of any API key.
 *
 * Run: `npm install && export DATABASE_URL="file:./dev.db" && npx prisma generate &&
 *       npx prisma db push && node walkthrough.mjs`
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { prisma, seed } from './seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'packages', 'cli', 'dist', 'main.js');
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db' };

const rule = (t) => console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`);
const sc = (r) => r?.structuredContent ?? {};
const cli = (...a) =>
  spawnSync('node', [CLI, ...a, '--config', 'orangerail.config.mjs'], { cwd: here, env, encoding: 'utf8' });
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`\n❌ ${msg}`);
    process.exit(1);
  }
};

/**
 * The queue exactly as an operator would write it: what to do, and the call that
 * does it. Twelve ordinary writes, then three deletions.
 */
const QUEUE = [
  ['Order o5 has been paid — mark it paid', 'updateOrder', { id: 'o5', status: 'paid' }],
  ['Restock product p2 to 30', 'updateProduct', { id: 'p2', stock: 30 }],
  ['Price change: p3 goes to 1800 cents', 'updateProduct', { id: 'p3', priceCents: 1800 }],
  ['Customer c3 upgraded to pro', 'updateCustomer', { id: 'c3', tier: 'pro' }],
  ['Order o1 has shipped', 'updateOrder', { id: 'o1', status: 'shipped' }],
  ['Order o2 has shipped', 'updateOrder', { id: 'o2', status: 'shipped' }],
  ['Order o3 has shipped', 'updateOrder', { id: 'o3', status: 'shipped' }],
  ['Add 1 unit of p1 to order o5', 'createOrderItem', { id: 'oi-new-1', orderId: 'o5', productId: 'p1', qty: 1, unitCents: 7900 }],
  ["Fix customer c4's misspelled email", 'updateCustomer', { id: 'c4', email: 'katherine.j@example.com' }],
  ['Damaged returns — p1 stock is really 38', 'updateProduct', { id: 'p1', stock: 38 }],
  ['Customer c2 asked to be downgraded', 'updateCustomer', { id: 'c2', tier: 'free' }],
  ['New SKU: USB-C dock', 'createProduct', { id: 'p4', sku: 'SKU-DOCK', title: 'USB-C dock', priceCents: 9900, stock: 15 }],
  ['Housekeeping: order o4 was cancelled weeks ago — delete it', 'deleteOrder', { id: 'o4' }],
  ['Customer c3 filed an erasure request — delete the record', 'deleteCustomer', { id: 'c3' }],
  ['Product p3 is discontinued — delete it', 'deleteProduct', { id: 'p3' }],
];

await seed();

// The approvals and the audit chain accumulate across runs, and the counts printed
// below are part of what this example claims. Reset the store too, so a second run
// says exactly what the first one did.
rmSync(join(here, '.orangerail', 'store'), { recursive: true, force: true });

rule('SETUP — the operator leaves. Nobody will answer a prompt for the next 15 items.');
const transport = new StdioClientTransport({
  command: 'node',
  args: [CLI, 'mcp', '--config', 'orangerail.config.mjs'],
  cwd: here,
  env,
  stderr: 'pipe',
});
const client = new Client({ name: 'back-office-agent', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);
transport.stderr?.on('data', (c) => console.log(`[host log]  ${c.toString().trim()}`));

const tools = (await client.listTools()).tools.map((t) => t.name);
// `Payment` was refused at generation time, so there is no tool that reads or writes
// card data — not an un-gated one, not a gated one. The absence is the guarantee.
assert(!tools.some((t) => t.toLowerCase().includes('payment')), 'no Payment tool may exist');
console.log(`[agent]     connected — ${tools.length} tools, none of them over Payment`);

rule('THE QUEUE — worked start to finish, unattended');
const staged = [];
let completed = 0;

for (const [index, [label, tool, args]] of QUEUE.entries()) {
  const result = sc(await client.callTool({ name: tool, arguments: args }));
  const n = String(index + 1).padStart(2);

  if (result.status === 'approval_pending') {
    assert(typeof result.approvalId === 'string', `${tool} staged without an approval id`);
    staged.push({ label, tool, args, approvalId: result.approvalId });
    console.log(`  ${n}. ⏸  STAGED    ${label}\n         → ${tool} held as approval ${result.approvalId.slice(0, 8)}…`);
    continue;
  }

  assert(result.status === 'executed', `${tool} should have run unattended, got "${result.status}"`);
  completed += 1;
  console.log(`  ${n}. ✅ DONE      ${label}`);
}

assert(completed === 12, `expected 12 unattended completions, got ${completed}`);
assert(staged.length === 3, `expected 3 staged deletions, got ${staged.length}`);

// Scored from the database, never from what the run reported about itself.
assert((await prisma.order.findUnique({ where: { id: 'o5' } })).status === 'paid', 'o5 should be paid');
assert((await prisma.product.findUnique({ where: { id: 'p2' } })).stock === 30, 'p2 should be restocked');
assert((await prisma.product.findUnique({ where: { id: 'p4' } })) !== null, 'p4 should exist');
assert((await prisma.customer.findUnique({ where: { id: 'c4' } })).email === 'katherine.j@example.com', 'c4 email should be fixed');
assert((await prisma.order.findUnique({ where: { id: 'o4' } })) !== null, 'o4 must NOT be deleted');
assert((await prisma.customer.findUnique({ where: { id: 'c3' } })) !== null, 'c3 must NOT be deleted');
assert((await prisma.product.findUnique({ where: { id: 'p3' } })) !== null, 'p3 must NOT be deleted');

console.log(`\n  ${completed} of 12 ordinary items finished with nobody present.`);
console.log(`  ${staged.length} deletions stopped. Every row they name is still there.`);

rule('THE AGENT CANNOT CLOSE ITS OWN LOOP');
const forced = sc(await client.callTool({ name: 'check_approval', arguments: { approvalId: staged[0].approvalId } }));
assert(forced.status !== 'executed', 'the agent must not be able to self-approve');
assert((await prisma.order.findUnique({ where: { id: 'o4' } })) !== null, 'o4 must survive the bypass attempt');
console.log(`  agent → check_approval(${staged[0].approvalId.slice(0, 8)}…) → "${forced.status}". o4 still there.`);

rule('THE NEXT MORNING — what a person walks in to');
process.stdout.write(cli('status').stdout.replace(/^/gm, '  '));
console.log();
process.stdout.write(cli('approvals', 'list').stdout.replace(/^/gm, '  '));

console.log('\n  Each of those is an executable call, not a sentence in a report:');
for (const { tool, args, approvalId } of staged) {
  console.log(`    ${approvalId.slice(0, 8)}…  ${tool}(${JSON.stringify(args)})`);
}

rule('ONE DECISION — the operator approves the housekeeping delete and leaves the rest');
const decided = staged[0];
assert(cli('approvals', 'approve', decided.approvalId).status === 0, 'approval should succeed');
console.log(`  $ orangerail approvals approve ${decided.approvalId.slice(0, 8)}…`);

const done = sc(await client.callTool({ name: 'check_approval', arguments: { approvalId: decided.approvalId } }));
assert(done.status === 'executed', `after approval, check_approval should execute, got "${done.status}"`);
assert((await prisma.order.findUnique({ where: { id: 'o4' } })) === null, 'o4 should be gone only now');
console.log(`  agent → check_approval again → "${done.status}". Order o4 is gone — and not one second earlier.`);

const stillPending = cli('approvals', 'list').stdout;
assert(stillPending.includes('deleteCustomer') && stillPending.includes('deleteProduct'), 'the two undecided approvals must remain');
console.log('  The erasure request and the discontinued product are still waiting. Nothing decided them.');

const audit = cli('audit', 'verify');
assert(audit.status === 0, 'the audit chain must verify');
console.log(`  $ orangerail audit verify → ${audit.stdout.trim()}`);

console.log(`
✅ Twelve items finished with the operator away. Three deletions became approvals bound
   to the exact call, each still executable tomorrow by someone who was never in the room.`);

await client.close();
await prisma.$disconnect();
