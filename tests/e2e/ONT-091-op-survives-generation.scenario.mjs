/**
 * ONT-091 e2e driver — the declared CRUD op survives generation (ticket section 5).
 *
 * `init --gate delete` knows which actions delete a row: it reads `op` off the
 * scanner IR to decide what to gate. Before this ticket it threw that away — the
 * emitted file carried the fact only as a `DESTRUCTIVE:` line in a JSDoc header,
 * which nothing downstream can read. So the fact survived exactly as long as the
 * `policy` block it happened to produce, and removing that block left the studio
 * unable to tell an un-gated delete from a create.
 *
 *   Phase 1 (AC-3, --gate delete): every generated Prisma action file carries
 *     `op: "<create|update|delete>"` matching the operation its execute performs.
 *   Phase 2 (AC-3 / scope): the GATED SET is unchanged — exactly the deletes are
 *     gated under `--gate delete`. This ticket records a fact; it does not move
 *     the governance posture, and this phase is what proves that.
 *   Phase 3 (AC-3, --gate none): the op is emitted even when no policy block is,
 *     which is the case the ticket exists for.
 *   Phase 4 (AC-4, the defect itself): strip `policy: { approval: 'required' },`
 *     from a generated delete, build the studio snapshot over the real
 *     generated ontology, and assert the action arrives as `approval: 'auto'`
 *     AND `op: 'delete'`.
 *   Phase 5 (AC-4, honesty): an action generated from an OpenAPI `DELETE`
 *     operation carries NO op. An HTTP method does not classify — `POST
 *     /orders/{id}/cancel` is destructive and `DELETE /sessions/{id}` is not —
 *     and absence must stay absence rather than becoming a guess.
 *   Phase 6 (AC-4, absence is not a claim): every action in the snapshot either
 *     declares an op or is openapi-sourced, and the count of declared ops is
 *     reported — the number the studio's `op n/m` readout renders.
 *
 * RED (pre-implementation): Phase 1 fails on the first file — no `op:` key is
 * emitted at all — and Phases 3/4/6 fail for the same reason. Phases 2 and 5
 * pass before and after, which is the point of including them: they pin what
 * this change must NOT move.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const STUDIO = join(ROOT, 'packages', 'studio', 'dist', 'node', 'index.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-006');
const SCRATCH = join(ROOT, '.docs', 'scratch');
const RUN_GATED = join(SCRATCH, 'ont-091-run-gate-delete');
const RUN_UNGATED = join(SCRATCH, 'ont-091-run-gate-none');

const fail = ({ message }) => {
  console.error(`ONT-091 e2e FAIL: ${message}`);
  process.exit(1);
};

const ok = ({ message }) => {
  console.log(`  ok  ${message}`);
};

/** The three write ops the Prisma scanner synthesises, and the models it sees. */
const OPS = ['create', 'update', 'delete'];
const MODELS = ['Product', 'Customer', 'Order', 'OrderItem', 'AuditNote'];

const runInit = ({ dir, gate }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [CLI, 'init', '--no-studio', '--yes', '--gate', gate],
    // DATABASE_URL is stripped for the same reason ONT-087 strips it: an
    // inherited one would let a scaffold that forgot it pass here and fail for
    // everyone else.
    { cwd: dir, encoding: 'utf8', env: { ...process.env, DATABASE_URL: undefined } },
  );

  if (result.status !== 0) {
    fail({ message: `init --gate ${gate} exited ${result.status}\n${result.stderr}` });
  }

  return result.stdout;
};

const actionFile = ({ dir, name }) => {
  const path = join(dir, 'ontology', `${name}.mjs`);

  if (!existsSync(path)) {
    fail({ message: `expected generated action file ${path}` });
  }

  return readFileSync(path, 'utf8');
};

/** The emitted `op:` value, or null when the file declares none. */
const declaredOp = ({ content }) => {
  const match = content.match(/^ {2}op: "([a-z]+)",$/m);
  return match === null ? null : match[1];
};

/** Whether the file carries the emitted policy LINE — not the header's advice. */
const isGated = ({ content }) => content.includes("\n  policy: { approval: 'required' },");

// ── Phase 1 ────────────────────────────────────────────────────────────────
console.log('Phase 1 — every generated Prisma action declares its op');
runInit({ dir: RUN_GATED, gate: 'delete' });

for (const model of MODELS) {
  for (const op of OPS) {
    const name = `${op}${model}`;
    const found = declaredOp({ content: actionFile({ dir: RUN_GATED, name }) });

    if (found !== op) {
      fail({ message: `${name}.mjs declares op ${JSON.stringify(found)}, expected "${op}"` });
    }
  }
}

ok({ message: `${MODELS.length * OPS.length} action files declare the op their execute performs` });

// ── Phase 2 ────────────────────────────────────────────────────────────────
console.log('Phase 2 — the gated set is unchanged under --gate delete');

for (const model of MODELS) {
  for (const op of OPS) {
    const name = `${op}${model}`;
    const gated = isGated({ content: actionFile({ dir: RUN_GATED, name }) });

    if (gated !== (op === 'delete')) {
      fail({
        message: `${name}.mjs is ${gated ? 'gated' : 'un-gated'} under --gate delete; recording the op must not move the posture`,
      });
    }
  }
}

ok({ message: `exactly the ${MODELS.length} deletes are gated; nothing else moved` });

// ── Phase 3 ────────────────────────────────────────────────────────────────
console.log('Phase 3 — the op is emitted even when no policy block is');
runInit({ dir: RUN_UNGATED, gate: 'none' });

for (const model of MODELS) {
  const content = actionFile({ dir: RUN_UNGATED, name: `delete${model}` });

  if (isGated({ content })) {
    fail({ message: `delete${model}.mjs is gated under --gate none` });
  }

  if (declaredOp({ content }) !== 'delete') {
    fail({ message: `delete${model}.mjs lost its op under --gate none` });
  }
}

ok({ message: 'un-gated deletes still say what they do' });

// ── Phase 4 ────────────────────────────────────────────────────────────────
console.log('Phase 4 — an un-gated delete reaches the snapshot as a delete');

const targetPath = join(RUN_GATED, 'ontology', 'deleteProduct.mjs');
const stripped = readFileSync(targetPath, 'utf8').replace(
  "  policy: { approval: 'required' },\n",
  '',
);

if (stripped === readFileSync(targetPath, 'utf8')) {
  fail({ message: 'could not strip the policy line from deleteProduct.mjs — the shape changed' });
}

writeFileSync(targetPath, stripped, 'utf8');

const { buildSnapshot } = await import(STUDIO);
const config = (await import(join(RUN_GATED, 'orangerail.config.mjs'))).default;
const snapshot = buildSnapshot({ registry: config.registry });

const deleteProduct = snapshot.actions.find((action) => action.name === 'deleteProduct');

if (deleteProduct === undefined) {
  fail({ message: 'deleteProduct is missing from the snapshot' });
}

if (deleteProduct.approval !== 'auto') {
  fail({ message: `deleteProduct should be auto after the strip, got ${deleteProduct.approval}` });
}

if (deleteProduct.op !== 'delete') {
  fail({
    message: `deleteProduct.op is ${JSON.stringify(deleteProduct.op)} — the map cannot tell it from a create`,
  });
}

ok({ message: 'deleteProduct: approval=auto, op=delete — policy gone, the fact survives' });

// ── Phase 5 ────────────────────────────────────────────────────────────────
console.log('Phase 5 — an OpenAPI DELETE declares nothing, and stays that way');

const openapiActions = snapshot.actions.filter((action) => {
  const path = join(RUN_GATED, 'ontology', `${action.name}.mjs`);
  return existsSync(path) && readFileSync(path, 'utf8').includes('from OpenAPI');
});

if (openapiActions.length === 0) {
  fail({
    message: 'no OpenAPI-sourced action was generated — the fixture no longer covers Phase 5',
  });
}

const guessed = openapiActions.filter((action) => action.op !== undefined);

if (guessed.length > 0) {
  fail({
    message: `openapi actions carry an op they cannot know: ${guessed.map((a) => a.name).join(', ')}`,
  });
}

const httpDelete = openapiActions.find((action) =>
  readFileSync(join(RUN_GATED, 'ontology', `${action.name}.mjs`), 'utf8').includes(
    'OpenAPI DELETE',
  ),
);

if (httpDelete === undefined) {
  fail({ message: 'the fixture no longer has an OpenAPI DELETE operation to guess from' });
}

ok({
  message: `${openapiActions.length} openapi actions declare no op, including the HTTP DELETE (${httpDelete.name})`,
});

// ── Phase 6 ────────────────────────────────────────────────────────────────
console.log('Phase 6 — the declared count the studio renders');

const declared = snapshot.actions.filter((action) => action.op !== undefined);
const undeclared = snapshot.actions.filter((action) => action.op === undefined);
const unexplained = undeclared.filter((action) => !openapiActions.includes(action));

if (unexplained.length > 0) {
  fail({
    message: `prisma-sourced actions with no op: ${unexplained.map((a) => a.name).join(', ')}`,
  });
}

ok({ message: `op declared on ${declared.length} of ${snapshot.actions.length} actions` });

rmSync(RUN_GATED, { recursive: true, force: true });
rmSync(RUN_UNGATED, { recursive: true, force: true });

console.log('ONT-091 e2e: all phases passed');
