/**
 * ONT-113 e2e driver — an `@@ignore`d model produces no tool (ticket section 5).
 *
 * Prisma Client generates no delegate for a model carrying `@@ignore`, so
 * `prisma.<model>` is `undefined`. Before this ticket the scanner never looked at
 * block attributes at all, so such a model became an object AND an action, and
 * the emitted file called `prisma.<model>.create(...)` on `undefined` — a tool
 * advertised in `tools/list` that throws the moment an agent calls it.
 *
 * This matters through the on-ramp this project recommends: `prisma db pull`
 * attaches `@@ignore` on its own to every table without a unique identifier.
 *
 *   Phase 1 (AC-1): no `ontology/` file is generated for either ignored model,
 *     and the models that CAN be served still are.
 *   Phase 2 (AC-2/AC-3): one aggregated warning names `@@ignore` and both models,
 *     and the "no single @id" line — the CONSEQUENCE, which used to be printed in
 *     the cause's place — does not appear for them.
 *   Phase 3 (AC-4): the printed object/action counts equal what is on disk. A
 *     unit test cannot prove this: the summary and the files are produced on
 *     different paths, which is exactly how ONT-042 F shipped.
 *   Phase 4 (edge case): a schema whose every model is ignored refuses with a
 *     message that does NOT claim the schema is missing, and exits non-zero.
 *   Phase 5 (the defect, stated as a delegate probe): `@prisma/client` generated
 *     from the same schema exposes a delegate for the kept model and `undefined`
 *     for both ignored ones — the fact the whole ticket rests on, measured rather
 *     than cited.
 *
 * RED (pre-implementation): Phase 1 fails on the first ignored model — the
 * scanner emits `createevents.mjs` — and Phases 2, 3 and 4 fail with it. Phase 5
 * passes before and after: it measures Prisma, not us, and it is included so a
 * later reader can see the premise is still true rather than trusting this
 * comment.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const WORK = join(ROOT, '.tmp-ont113');

let failures = 0;

const check = ({ label, ok, detail }) => {
  if (ok) {
    console.log(`  ok    ${label}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) {
    console.log(`        ${detail}`);
  }
};

/**
 * The two ignored models are written exactly as `prisma db pull` emits them,
 * doc comment included, so the fixture is the real on-ramp's output and not a
 * hand-made approximation of it.
 */
const SCHEMA_MIXED = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model users {
  id    Int    @id @default(autoincrement())
  email String @unique
}

/// The underlying table does not contain a valid unique identifier and can therefore currently not be handled by Prisma Client.
model events {
  id          BigInt   @default(autoincrement())
  occurred_at DateTime @db.Date
  kind        String?

  @@ignore
}

/// The underlying table does not contain a valid unique identifier and can therefore currently not be handled by Prisma Client.
model no_pk_table {
  a Int?
  b Int?

  @@ignore
}
`;

const SCHEMA_ALL_IGNORED = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model events {
  id BigInt @default(autoincrement())

  @@ignore
}
`;

/** Write a throwaway project and run the SHIPPED cli's `init` in it. */
const runInit = ({ name, schema }) => {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'prisma'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `{ "name": "${name}", "version": "1.0.0", "private": true }\n`,
  );
  writeFileSync(join(dir, 'prisma', 'schema.prisma'), schema);

  const run = spawnSync(process.execPath, [CLI, 'init', '--yes', '--no-docs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgresql://unused@localhost:5432/unused' },
  });

  return { dir, status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
};

console.log("ONT-113 — an @@ignore'd model produces no tool");

// ── Phase 1 — nothing is generated for an ignored model ─────────────────────
console.log('\nPhase 1 — no file is generated for an ignored model (AC-1)');

const mixed = runInit({ name: 'mixed', schema: SCHEMA_MIXED });
const ontologyDir = join(mixed.dir, 'ontology');
const files = existsSync(ontologyDir) ? readdirSync(ontologyDir).sort() : [];

check({
  label: 'init succeeded on a schema that still has one servable model',
  ok: mixed.status === 0,
  detail: `exit ${mixed.status}\n${mixed.stderr}`,
});

for (const ignored of ['events', 'no_pk_table']) {
  const leaked = files.filter((f) => f.toLowerCase().includes(ignored.toLowerCase()));
  check({
    label: `no ontology file mentions the ignored model '${ignored}'`,
    ok: leaked.length === 0,
    detail: `found ${leaked.join(', ')}`,
  });
}

check({
  label: 'the servable model still generates its object and its writes',
  ok: ['users.mjs', 'createusers.mjs', 'updateusers.mjs', 'deleteusers.mjs'].every((f) =>
    files.includes(f),
  ),
  detail: `ontology/ holds ${files.join(', ')}`,
});

// ── Phase 2 — the cause is named, not the consequence ───────────────────────
console.log('\nPhase 2 — the warning names @@ignore, not the missing @id (AC-2, AC-3)');

const ignoreLines = mixed.stderr.split('\n').filter((l) => l.includes('@@ignore'));

check({
  label: 'exactly one aggregated @@ignore warning is printed',
  ok: ignoreLines.length === 1,
  detail: `${ignoreLines.length} line(s):\n${ignoreLines.join('\n')}`,
});

check({
  label: 'that warning names both ignored models',
  ok:
    ignoreLines.length === 1 && ['events', 'no_pk_table'].every((m) => ignoreLines[0].includes(m)),
  detail: ignoreLines[0],
});

check({
  label: 'that warning states why: Prisma Client generates no delegate',
  ok: ignoreLines.length === 1 && /no delegate/i.test(ignoreLines[0]),
  detail: ignoreLines[0],
});

check({
  label: 'the misleading "no single @id" line is NOT printed for an ignored model',
  ok:
    !/no single @id/.test(mixed.stderr) ||
    !/events|no_pk_table/.test(
      mixed.stderr
        .split('\n')
        .filter((l) => /no single @id/.test(l))
        .join('\n'),
    ),
  detail: mixed.stderr
    .split('\n')
    .filter((l) => /no single @id/.test(l))
    .join('\n'),
});

// ── Phase 3 — the printed count equals what is on disk ──────────────────────
console.log('\nPhase 3 — the summary count matches the files (AC-4)');

const summary = /(\d+) object\(s\), (\d+) action\(s\)/.exec(mixed.stdout + mixed.stderr);
const objectFiles = files.filter((f) => f === 'users.mjs');
const actionFiles = files.filter((f) => /^(create|update|delete)/.test(f));

check({
  label: 'init printed an object/action count',
  ok: summary !== null,
  detail: mixed.stdout,
});

if (summary !== null) {
  check({
    label: `object count ${summary[1]} equals the ${objectFiles.length} object file(s) written`,
    ok: Number(summary[1]) === objectFiles.length,
    detail: `files: ${files.join(', ')}`,
  });

  check({
    label: `action count ${summary[2]} equals the ${actionFiles.length} action file(s) written`,
    ok: Number(summary[2]) === actionFiles.length,
    detail: `files: ${files.join(', ')}`,
  });
}

// ── Phase 4 — every model ignored ───────────────────────────────────────────
console.log('\nPhase 4 — a schema whose every model is ignored (edge case)');

const all = runInit({ name: 'all-ignored', schema: SCHEMA_ALL_IGNORED });

check({
  label: 'init refuses with a non-zero exit',
  ok: all.status !== 0,
  detail: `exit ${all.status}`,
});

check({
  label: 'the refusal does NOT claim the schema is missing',
  ok: !/no Prisma schema or OpenAPI JSON found/.test(all.stderr),
  detail: all.stderr,
});

check({
  label: 'the refusal still states the @@ignore cause',
  ok: /@@ignore/.test(all.stderr),
  detail: all.stderr,
});

check({
  label: 'no ontology/ directory is left behind',
  ok: !existsSync(join(all.dir, 'ontology')),
});

// ── Phase 5 — the premise, measured against Prisma itself ───────────────────
console.log('\nPhase 5 — Prisma Client really does expose no delegate (the premise)');

const prismaBin = join(ROOT, 'node_modules', '.bin', 'prisma');

if (!existsSync(prismaBin)) {
  console.log('  skip  no local prisma CLI — the premise is unverified in this run');
} else {
  const probeDir = join(WORK, 'delegate-probe');
  rmSync(probeDir, { recursive: true, force: true });
  mkdirSync(join(probeDir, 'prisma'), { recursive: true });
  writeFileSync(join(probeDir, 'prisma', 'schema.prisma'), SCHEMA_MIXED);

  const generated = spawnSync(prismaBin, ['generate'], {
    cwd: probeDir,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgresql://unused@localhost:5432/unused' },
  });

  if (generated.status !== 0) {
    console.log('  skip  prisma generate did not run here — the premise is unverified in this run');
  } else {
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        'const { PrismaClient } = require("@prisma/client");' +
          'const p = new PrismaClient();' +
          'console.log(["users","events","no_pk_table"].map((m) => `${m}=${typeof p[m]}`).join(" "));',
      ],
      {
        cwd: probeDir,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: 'postgresql://unused@localhost:5432/unused' },
      },
    );

    const out = (probe.stdout ?? '').trim();

    check({
      label: 'the kept model has a delegate',
      ok: /users=object/.test(out),
      detail: out || (probe.stderr ?? ''),
    });

    check({
      label: 'both ignored models have NO delegate — calling one would throw',
      ok: /events=undefined/.test(out) && /no_pk_table=undefined/.test(out),
      detail: out || (probe.stderr ?? ''),
    });
  }
}

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
