/**
 * Proof for the #281 scenario: a destructive write stays available to the agent,
 * but is staged for human approval instead of executing — the read-only-vs-write
 * dilemma, resolved. Run with `node proof.mjs` after `prisma db push` + generate
 * (see README). Exits non-zero if any step fails.
 *
 * The flow, end to end, over the REAL MCP server (stdio JSON-RPC) plus the REAL
 * approval CLI — nothing mocked:
 *   1. tools/list  — the agent can SEE deleteArticle (a destructive tool).
 *   2. Article_list — reads work ungoverned (you do NOT go read-only to stay safe).
 *   3. deleteArticle{id} — returns an approvalId and does NOT delete the row.
 *   4. orangerail approvals approve <id> — a human authorizes it out of band.
 *   5. check_approval{approvalId} — now it executes; the row is gone.
 *   6. check_approval{approvalId} again — consumed (an approval is single-use).
 *   7. orangerail audit verify — the hash-chained audit log verifies.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'packages', 'cli', 'dist', 'main.js');
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db' };

const die = (message) => {
  console.error(`\n❌ ${message}`);
  process.exit(1);
};

const cli = (args) => spawnSync('node', [CLI, ...args, '--config', 'orangerail.config.mjs'], {
  cwd: here,
  env,
  encoding: 'utf8',
});

// --- seed a clean, deterministic dataset via Prisma directly ---
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
await prisma.comment.deleteMany();
await prisma.article.deleteMany();
const target = await prisma.article.create({
  data: { slug: 'ship-it', title: 'Ship it', body: 'A published post an agent might be asked to remove.', published: true },
});
await prisma.article.create({
  data: { slug: 'keep-me', title: 'Keep me', body: 'A second post that must survive.', published: true },
});
console.log(`Seeded 2 articles; the destructive target is Article #${target.id} ("${target.slug}").`);

// --- MCP stdio JSON-RPC harness ---
const child = spawn('node', [CLI, 'mcp', '--config', 'orangerail.config.mjs'], {
  cwd: here,
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
let nextId = 1;
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const call = async (name, args) => {
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) die(`${name} errored: ${JSON.stringify(res.error)}`);
  return res.result?.structuredContent ?? {};
};

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proof', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// 1. The agent can see the destructive tool.
const list = await rpc('tools/list', {});
const toolNames = (list.result?.tools ?? []).map((t) => t.name);
if (!toolNames.includes('deleteArticle')) die(`deleteArticle not exposed. Tools: ${toolNames.join(', ')}`);
console.log(`\n1. tools/list → the agent CAN see the destructive tool "deleteArticle" (${toolNames.length} tools total). ✓`);

// 2. Reads work ungoverned — no read-only lockdown needed.
const before = await call('Article_list', {});
if (!Array.isArray(before.items) || before.items.length !== 2) die(`Article_list should return 2 items, got ${JSON.stringify(before)}`);
console.log(`2. Article_list → read works ungoverned, ${before.items.length} rows (writes stay available; no read-only lockdown). ✓`);

// 3. The destructive call is STAGED, not executed.
const staged = await call('deleteArticle', { id: target.id });
if (staged.status !== 'approval_pending' || !staged.approvalId) die(`deleteArticle should stage for approval, got ${JSON.stringify(staged)}`);
const stillThere = await prisma.article.findUnique({ where: { id: target.id } });
if (!stillThere) die(`Article #${target.id} was deleted at call time — it must NOT execute before approval.`);
console.log(`3. deleteArticle{id:${target.id}} → status "approval_pending", approvalId "${staged.approvalId}"; the row is UNTOUCHED. ✓`);

// 4. A human approves out of band, through the CLI.
const approve = cli(['approvals', 'approve', staged.approvalId]);
if (approve.status !== 0) die(`CLI approve failed: ${approve.stdout}${approve.stderr}`);
console.log(`4. orangerail approvals approve ${staged.approvalId} → a human authorized it out of band. ✓`);

// 5. Now check_approval executes the staged action; the row is gone.
const executed = await call('check_approval', { approvalId: staged.approvalId });
if (executed.status !== 'executed') die(`check_approval should execute after approval, got ${JSON.stringify(executed)}`);
const afterDelete = await prisma.article.findUnique({ where: { id: target.id } });
if (afterDelete) die(`Article #${target.id} still present after execution.`);
const survivors = await prisma.article.count();
if (survivors !== 1) die(`Exactly one article should survive, found ${survivors}.`);
console.log(`5. check_approval → status "executed"; Article #${target.id} is now deleted, the other survives. ✓`);

// 6. The approval is single-use.
const reused = await call('check_approval', { approvalId: staged.approvalId });
if (reused.status !== 'consumed') die(`Re-checking a used approval should be "consumed", got ${JSON.stringify(reused)}`);
console.log(`6. check_approval again → status "consumed"; an approval cannot be replayed. ✓`);

// 7. The audit chain verifies.
const audit = cli(['audit', 'verify']);
const auditOut = `${audit.stdout}${audit.stderr}`;
if (audit.status !== 0) die(`audit verify failed:\n${auditOut}`);
console.log(`7. orangerail audit verify → ${auditOut.trim().split('\n').pop()} ✓`);

console.log('\n✅ The destructive write stayed available to the agent, executed only after a human approved, and every step is on a verifiable audit chain.');

child.stdin.end();
child.kill('SIGTERM');
await prisma.$disconnect();
