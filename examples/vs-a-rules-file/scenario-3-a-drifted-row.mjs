/**
 * Scenario 3 — the precondition reads a field the row stopped carrying.
 *
 * The rule is "never discount a product that is sold out". In the baseline arm it is a
 * hand-written `product.status !== 'soldout'`; in orangerail it is
 * `where: { field: 'status', op: 'neq', value: 'soldout' }` on `applyDiscount`, which is
 * deliberately NOT approval-gated — the guard is the only thing letting that write run
 * with nobody present.
 *
 * Then a migration lands that the ontology did not follow: `status` leaves
 * `prisma/schema.prisma` and the client is regenerated, so the resolver stops selecting a
 * field the ontology still declares required. The column itself is never dropped, so the
 * verdict below can be read straight off the table with raw SQL.
 *
 * Both arms then compare against a field that is `undefined`, and `undefined !== 'soldout'`
 * is `true` — the clause written to STOP the write is the clause that permits it. That was
 * true of orangerail too until ONT-074 (#117), which is why the result table has three rows
 * and not two.
 *
 * The schema edit is made in place and restored in a `finally`; the original is copied to
 * `.scratch/` first, and a leftover copy is restored on the next run.
 *
 * Run: `node scenario-3-a-drifted-row.mjs`
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assert,
  banner,
  HERE,
  openDatabase,
  productRow,
  resetStore,
  rule,
  runBaselineArm,
  runOrangerailArm,
  seedProducts,
} from './lib.mjs';

const TARGET = 'p2';
const PERCENT_OFF = 20;
const SCRATCH = join(HERE, '.scratch');
const SCHEMA = join(HERE, 'prisma', 'schema.prisma');

/**
 * The middle row of the result table. It is NOT computed here, and it is not an estimate:
 * this file was copied unmodified into a real `git archive 062e527` checkout of this repo,
 * built with `pnpm install && pnpm -r run build`, and run. It answered `executed` and left
 * the sold-out row at 2399 — and then failed its own assertion, which is what a shipped
 * defect looks like from inside its own regression test. The README carries that transcript
 * and the commands to reproduce it. It is printed because omitting it would turn a record
 * into a claim.
 */
const RECORDED_062E527 = {
  status: 'executed',
  priceCents: 2399,
};

mkdirSync(SCRATCH, { recursive: true });

/** Restores the schema from `.scratch/`, so an interrupted run never leaves it drifted. */
const restoreSchema = () => {
  const backup = join(SCRATCH, 'schema.prisma');

  if (existsSync(backup)) {
    copyFileSync(backup, SCHEMA);
  }
};

/** Regenerates the Prisma client from whatever `prisma/schema.prisma` currently says. */
const generateClient = () => {
  const result = spawnSync('npx', ['prisma', 'generate', '--schema', 'prisma/schema.prisma'], {
    cwd: HERE,
    env: process.env,
    encoding: 'utf8',
  });

  assert({ ok: result.status === 0, message: `prisma generate exited ${result.status}\n${result.stderr}` });
};

/**
 * Drops one field from one model in the Prisma schema, as a migration the ontology did
 * not follow. Scoped to the model, because `Order` declares a `status` of its own and
 * scenarios 1 and 2 are entitled to keep it.
 */
const dropField = ({ model, field }) => {
  copyFileSync(SCHEMA, join(SCRATCH, 'schema.prisma'));

  const lines = readFileSync(SCHEMA, 'utf8').split('\n');

  let inModel = false;
  let dropped = 0;

  const kept = lines.filter((line) => {
    if (line.startsWith(`model ${model} {`)) {
      inModel = true;

      return true;
    }

    if (inModel && line.startsWith('}')) {
      inModel = false;

      return true;
    }

    if (inModel && new RegExp(`^\\s{2}${field}\\s`).test(line)) {
      dropped += 1;

      return false;
    }

    return true;
  });

  assert({ ok: dropped === 1, message: `expected exactly one \`${field}\` line in model ${model}, dropped ${dropped}` });
  writeFileSync(SCHEMA, kept.join('\n'));
};

restoreSchema();
resetStore();

const prisma = await openDatabase();

banner({ title: 'SCENARIO 3 — the precondition reads a field the row stopped carrying' });
console.log(`\n  the rule:   never discount a product that is sold out`);
console.log(`  arm A:      a plain script — \`if (product.status !== 'soldout')\``);
console.log(`  arm B:      orangerail — \`where: { field: 'status', op: 'neq', value: 'soldout' }\``);
console.log(`  the target: product ${TARGET}, which IS sold out — the row the rule exists to protect`);
console.log('\n  applyDiscount carries no approval. The guard is the whole boundary, which is what');
console.log('  lets that write run unattended. Nothing in this scenario touches the approvals store.');

const cell = {};

try {
  rule({ title: 'CONTROL — the guard works, on a row that still carries the field' });
  await seedProducts({ prisma });

  const okCall = await runOrangerailArm({ cwd: HERE, tool: 'applyDiscount', args: { productId: 'p1', percentOff: PERCENT_OFF } });
  const p1 = await productRow({ prisma, id: 'p1' });

  console.log(`  [agent]  applyDiscount({ productId: "p1" })  p1 is "active"   → "${okCall.result.status}"`);
  console.log(`  → p1 priceCents: ${p1.priceCents} (was 1999)`);

  const blockedCall = await runOrangerailArm({ cwd: HERE, tool: 'applyDiscount', args: { productId: TARGET, percentOff: PERCENT_OFF } });
  const before = await productRow({ prisma, id: TARGET });

  console.log(`  [agent]  applyDiscount({ productId: "${TARGET}" })  ${TARGET} is "soldout"  → "${blockedCall.result.status}"`);
  console.log(`  → ${TARGET} priceCents: ${before.priceCents} (unchanged)`);

  assert({ ok: okCall.result.status === 'executed', message: 'the guard should let an active product through' });
  assert({ ok: Number(p1.priceCents) === 1599, message: 'the discount should have landed on p1' });
  assert({ ok: blockedCall.result.status === 'rejected_where', message: 'the guard should refuse a sold-out product' });
  assert({ ok: Number(before.priceCents) === 2999, message: `${TARGET} should be untouched by the refused call` });

  rule({ title: 'THE MIGRATION — `status` leaves the schema, and the ontology does not follow' });
  dropField({ model: 'Product', field: 'status' });
  generateClient();

  console.log('  prisma/schema.prisma  − status     String');
  console.log('  $ npx prisma generate');
  console.log('  ontology/Product.mjs  unchanged — `init` wrote it once and re-scans never touch it,');
  console.log('                        so it still declares `"status": z.string()` as required.');
  console.log('  The column is still in the table. Only the client stopped selecting it.');

  rule({ title: 'ARM A · a plain script · the hand-written precondition' });
  await seedProducts({ prisma });

  const armA = runBaselineArm({ cwd: HERE, script: 'discount.mjs', args: [TARGET, String(PERCENT_OFF)] });
  const afterA = await productRow({ prisma, id: TARGET });

  cell.a = { verdict: armA.verdict, priceCents: Number(afterA.priceCents) };
  console.log(`  → ${TARGET} priceCents: ${cell.a.priceCents} (was 2999), and status in the table is still "${afterA.status}"`);

  rule({ title: 'ARM B · orangerail · the same precondition, declared' });
  await seedProducts({ prisma });

  const armB = await runOrangerailArm({ cwd: HERE, tool: 'applyDiscount', args: { productId: TARGET, percentOff: PERCENT_OFF } });
  const afterB = await productRow({ prisma, id: TARGET });

  cell.b = { verdict: armB.result.status, priceCents: Number(afterB.priceCents) };
  console.log(`  [agent]  applyDiscount({ productId: "${TARGET}" }) → "${armB.result.status}"`);
  console.log(`  [agent]  field named in the refusal: ${JSON.stringify(armB.result.field)}`);
  console.log(`  [agent]  text shown to the agent: ${JSON.stringify(armB.text)}`);
  console.log(`  → ${TARGET} priceCents: ${cell.b.priceCents} (was 2999)`);

  const chain = readFileSync(join(HERE, '.orangerail', 'store', 'audit.jsonl'), 'utf8');
  const record = chain
    .split('\n')
    .filter((line) => line.includes('target_nonconforming'))
    .map((line) => JSON.parse(line))[0];

  console.log(
    `  [audit]  ${record === undefined ? 'nothing on the chain refused this call' : `phase "${record.phase}" — ${JSON.stringify(record.error)}`}`,
  );

  const cellText = ({ verdict, priceCents }) =>
    `${verdict === 'executed' ? 'EXECUTED' : 'REFUSED '} — priceCents ${String(priceCents).padEnd(4)}`.padEnd(34);

  banner({ title: 'RESULT — the gated call on a drifted row, read off the table' });
  console.log(`
                          the gated call on a sold-out row whose \`status\` went missing
  plain script            ${cellText({ ...cell.a })}  (this run)
  orangerail 062e527      ${cellText({ verdict: RECORDED_062E527.status, priceCents: RECORDED_062E527.priceCents })}  (run on a real 062e527 build — README)
  orangerail 2f5d1e3      ${cellText({ ...cell.b })}  (this run)
`);

  assert({ ok: cell.a.verdict === 'executed' && cell.a.priceCents === 2399, message: 'the hand-written precondition should be satisfied by the missing field' });
  assert({ ok: cell.b.verdict === 'target_nonconforming', message: 'orangerail should refuse a row that does not match what Product declares' });
  assert({ ok: armB.result.field === 'status', message: 'the refusal should name the field' });
  assert({ ok: armB.result.reason === undefined, message: 'the operator-facing reason should not be forwarded to the agent' });
  assert({ ok: cell.b.priceCents === 2999, message: `${TARGET} must be untouched by the refused call` });
  assert({ ok: record?.phase === 'target_nonconforming', message: 'the refusal should be on the audit chain' });

  console.log('  The middle row is this project shipping the same defect. It is kept because an');
  console.log('  example that showed only the bottom two rows would read as a claim about what');
  console.log('  a declared schema buys you, rather than a record of what it cost to get there.');
  console.log('');
  console.log('  Read the top row precisely. That script is not careless — it is the same');
  console.log('  comparison, and it fails the same way. What separates the arms is that one of');
  console.log('  them checks the row against a declaration you already made, so the precondition');
  console.log('  cannot be satisfied by a field that is not there. Parse the row against that');
  console.log('  same schema in your own script and you have this property without orangerail.');
} finally {
  restoreSchema();
  generateClient();

  console.log('\n  restored prisma/schema.prisma and regenerated the client.');

  await prisma.$disconnect();
}
