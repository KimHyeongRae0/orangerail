/**
 * The whole story in one run — from both sides of the moment governance kicks in.
 * Unlike proof.mjs (terse assertions), this narrates the CUSTOMER experience end
 * to end, and still asserts each step (exits non-zero on any failure), so it is a
 * real e2e and not just theatre.
 *
 *   AGENT side   — a REAL MCP client (@modelcontextprotocol/sdk, what an agent host
 *                  uses) connects, tries a destructive delete, and orangerail SHOWS
 *                  UP and blocks it. The agent then tries to force it through and
 *                  still cannot: it can't approve its own action.
 *   OPERATOR side — the human sees exactly that pending action via `status` +
 *                  `approvals list`, decides, and only then does it run. `audit
 *                  verify` closes the loop.
 *
 * Run: `npm install && npx prisma generate && npx prisma db push && node walkthrough.mjs`
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'packages', 'cli', 'dist', 'main.js');
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db' };

const say = (who, msg) => console.log(`${who.padEnd(13)} ${msg}`);
const rule = (t) => console.log(`\n${'─'.repeat(66)}\n${t}\n${'─'.repeat(66)}`);
const sc = (r) => r?.structuredContent ?? {};
const cli = (...a) =>
  spawnSync('node', [CLI, ...a, '--config', 'orangerail.config.mjs'], { cwd: here, env, encoding: 'utf8' });
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`\n❌ ${msg}`);
    process.exit(1);
  }
};

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
await prisma.comment.deleteMany();
await prisma.article.deleteMany();
const target = await prisma.article.create({
  data: { slug: 'ship-it', title: 'Ship it', body: 'x', published: true },
});
await prisma.article.create({ data: { slug: 'keep-me', title: 'Keep', body: 'y', published: true } });
const rowThere = async () => Boolean(await prisma.article.findUnique({ where: { id: target.id } }));
const mark = async () => ((await rowThere()) ? 'STILL THERE ✋' : 'gone');

rule('THE AGENT SIDE — a real MCP client tries to delete, and gets blocked');
const transport = new StdioClientTransport({
  command: 'node',
  args: [CLI, 'mcp', '--config', 'orangerail.config.mjs'],
  cwd: here,
  env,
  stderr: 'pipe',
});
const client = new Client({ name: 'demo-agent', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);
transport.stderr?.on('data', (c) => say('[host log]', c.toString().trim())); // the startup confidence line

const tools = (await client.listTools()).tools.map((t) => t.name);
assert(tools.includes('deleteArticle'), 'deleteArticle should be exposed to the agent');
say('[agent]', `connected — ${tools.length} tools available, incl. deleteArticle`);
say('[agent]', `task: "clean up the old 'ship-it' post" → deleteArticle({ id: ${target.id} })`);

const first = sc(await client.callTool({ name: 'deleteArticle', arguments: { id: target.id } }));
assert(first.status === 'approval_pending' && first.approvalId, 'the delete must stage, not execute');
assert(await rowThere(), 'the row must NOT be deleted at call time');
say('[orangerail]', `🛑 BLOCKED — "${first.status}", NOT executed. approvalId=${first.approvalId.slice(0, 8)}…`);
say('[db check]', `article ${target.id}: ${await mark()}`);

say('[agent]', 'blocked. trying to push it through myself → check_approval (no human yet)');
const forced = sc(await client.callTool({ name: 'check_approval', arguments: { approvalId: first.approvalId } }));
assert(forced.status !== 'executed', 'the agent must NOT be able to self-approve');
assert(await rowThere(), 'the row must still be intact after a bypass attempt');
say('[orangerail]', `⛔ "${forced.status}" — the agent cannot self-approve.`);
say('[db check]', `article ${target.id}: ${await mark()}`);

rule('THE OPERATOR SIDE — the human sees exactly that, in another terminal');
process.stdout.write(cli('status').stdout.replace(/^/gm, '   '));
say('[human]', '$ orangerail approvals list');
process.stdout.write(cli('approvals', 'list').stdout.replace(/^/gm, '   '));
say('[human]', `I recognize this, it's fine → approvals approve ${first.approvalId.slice(0, 8)}…`);
assert(cli('approvals', 'approve', first.approvalId).status === 0, 'approval should succeed');

rule('BACK TO THE AGENT — only now does it run');
const done = sc(await client.callTool({ name: 'check_approval', arguments: { approvalId: first.approvalId } }));
assert(done.status === 'executed', 'after approval, check_approval should execute');
assert(!(await rowThere()), `article ${target.id} should be deleted only now`);
say('[agent]', `check_approval again → "${done.status}"`);
say('[db check]', `article ${target.id}: ${await mark()}`);
const audit = cli('audit', 'verify');
assert(audit.status === 0, 'the audit chain must verify');
say('[human]', `$ orangerail audit verify → ${audit.stdout.trim()}`);

console.log('\n✅ The destructive write was blocked, could not be self-approved, and ran only after a human decided — every step on a verifiable audit chain.');

await client.close();
await prisma.$disconnect();
