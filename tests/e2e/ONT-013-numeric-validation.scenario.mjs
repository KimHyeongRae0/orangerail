/**
 * ONT-013 e2e driver — numeric-input validation + degraded-input honesty.
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) over an adversarial battery
 * built by MUTATING the committed ONT-010 Jira fixture
 * (tests/e2e/fixtures/ont-010/jira-export.json) at runtime into per-phase run
 * dirs under .docs/scratch. No fixture JSON is committed for ONT-013 — every
 * variant is derived deterministically from the ONT-010 fixture so the real
 * parse -> metrics -> graph -> findings -> emit pipeline is exercised. Pure Node
 * stdlib: no Playwright, no browser (these are data/report contract assertions).
 *
 * The scenario proves the ticket's acceptance criteria (AC-1..AC-7):
 *
 *   phase 1  (AC-1) negative-points export: NO derived percentage exceeds 100 —
 *            no finding pointer.sharePct > 100 and no "carry N% of the team
 *            total" with N > 100 in ANALYTICS.md.
 *   phase 2  (AC-2) negative-points + inverted-dates export: no physically-
 *            impossible negative metric — every storyPointsTotal >= 0, every
 *            medianCycleDaysFirstHalf/SecondHalf >= 0, and no negative number
 *            anywhere in data/employee.json.
 *   phase 3  (AC-3) the same invalid-input run's stderr carries the two
 *            aggregate data-quality warnings naming the excluded field/count
 *            (invalid story points from customfield_10016; issues excluded from
 *            cycle-time stats because created is after resolutiondate).
 *   phase 4  (AC-4) empty [] / {} / {issues:{}} exports each: stderr contains
 *            "no issues recognized in <path>", stdout does NOT print the cheerful
 *            "extracted N ... finding(s)" success line, data/finding.json is []
 *            (no placeholder "not evaluated" findings), exit 0; a valid
 *            all-unassigned export (which HAS issues) still reports success and
 *            does NOT warn.
 *   phase 5  (AC-5) 1 MB displayName export: the ANALYTICS.md roster cell is
 *            truncated (80-char prefix + "..."; the whole report far below
 *            200 KB) while data/employee.json keeps the full raw 1 MB value.
 *   phase 6  (AC-6 regression + injection) the whole battery (negative points,
 *            inverted dates, empty, wrong-shape, 1 MB field, hostile string)
 *            exits without crash, every emitted config dynamic-import
 *            smoke-loads, and the hostile string stays inert (no raw onerror=
 *            breakout in the config).
 *   phase 7  (AC-7) both-sources run over the UNMUTATED ONT-010 fixture is
 *            byte-identical to the reference captured at scenario start
 *            (config.mjs + every data/*.json + ANALYTICS.md); determinism holds.
 *
 * RED (pre-implementation): the shipped CLI (1) prints a sharePct above 100 on a
 * negative-points export, (2) writes a negative storyPointsTotal and a negative
 * medianCycleDays*, (3) emits no data-quality warning for the excluded inputs,
 * (4) prints "extracted 0 ... finding(s)" with four "not evaluated" placeholders
 * and no "no issues recognized" warning on an empty/wrong-shape export, and (5)
 * writes the 1 MB display field verbatim into ANALYTICS.md — so phases 1, 2, 3,
 * 4 and 5 FAIL on genuine assertions while phases 6 and 7 (the crash-free /
 * injection-safe / both-sources guarantees this ticket preserves) already pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE_010 = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-010');
const SCRATCH = join(ROOT, '.docs', 'scratch');

const RUN_REF = join(SCRATCH, 'ont-013-run-ref');
const RUN_SHARE = join(SCRATCH, 'ont-013-run-share');
const RUN_NEG = join(SCRATCH, 'ont-013-run-negative');
const RUN_EMPTY_ARR = join(SCRATCH, 'ont-013-run-empty-array');
const RUN_EMPTY_OBJ = join(SCRATCH, 'ont-013-run-empty-object');
const RUN_ISSUES_OBJ = join(SCRATCH, 'ont-013-run-issues-object');
const RUN_UNASSIGNED = join(SCRATCH, 'ont-013-run-unassigned');
const RUN_GIANT = join(SCRATCH, 'ont-013-run-giant-name');
const RUN_HOSTILE = join(SCRATCH, 'ont-013-run-hostile');
const RUN_BOTH = join(SCRATCH, 'ont-013-run-both');

const BASE_JIRA = JSON.parse(readFileSync(join(FIXTURE_010, 'jira-export.json'), 'utf8'));

const fail = ({ message }) => {
  console.error(`ONT-013 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const exact = ({ actual, expected, label }) => {
  assert({
    ok: actual === expected,
    message: `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  });
};

const readJson = ({ dir, rel }) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

/** Deep clone the ONT-010 Jira export so each mutation starts from a clean tree. */
const cloneBaseJira = () => JSON.parse(JSON.stringify(BASE_JIRA));

const freshDir = ({ dir }) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
};

/** Run an `orangerail` command to completion inside a run dir. */
const runCli = ({ args, cwd }) => {
  const res = spawnSync('node', [CLI, ...args], {
    cwd,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 120_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/**
 * Write a mutated Jira export into a fresh run dir and run `orangerail init` over
 * it. `slackFrom` (a rel path copied into the dir) opts into a both-sources run;
 * omit it for the realistic Jira-only path.
 */
const initJira = ({ dir, jira, slackFrom }) => {
  freshDir({ dir });
  writeFileSync(join(dir, 'jira-export.json'), `${JSON.stringify(jira, null, 2)}\n`);

  const args = ['init', '--yes', '--no-studio', '--no-docs', '--from-jira', 'jira-export.json'];
  if (slackFrom !== undefined) {
    writeFileSync(
      join(dir, 'slack-export.json'),
      readFileSync(join(FIXTURE_010, 'slack-export.json')),
    );
    args.push('--from-slack', 'slack-export.json');
  }

  return runCli({ args, cwd: dir });
};

/** Dynamic-import the generated config and confirm it exposes a registry+store. */
const smokeLoadConfig = async ({ dir }) => {
  const url = new URL(`file://${join(dir, 'orangerail.config.mjs')}`);
  const mod = await import(url.href);
  const def = mod.default;
  return def !== undefined && def !== null && def.registry !== undefined && def.store !== undefined;
};

/** Walk a JSON value and return the first negative finite number found, or null. */
const firstNegative = ({ value, path }) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value < 0 ? { path, value } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = firstNegative({ value: value[i], path: `${path}[${i}]` });
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = firstNegative({ value: v, path: `${path}.${k}` });
      if (hit !== null) {
        return hit;
      }
    }
  }
  return null;
};

// ─────────────── setup — both-sources reference (== ONT-010 output) ───────────

console.log('[setup] capture both-sources reference (== ONT-010 output)');

const initRef = initJira({ dir: RUN_REF, jira: cloneBaseJira(), slackFrom: 'slack-export.json' });
assert({
  ok: initRef.status === 0,
  message: `both-sources reference init exited ${initRef.status}: ${initRef.stderr.slice(0, 400)}`,
});
const refEmployees = readJson({ dir: RUN_REF, rel: 'data/employee.json' });

// ─────────────── phase 1 — AC-1: no derived percentage exceeds 100 ────────────

console.log('[phase 1] AC-1 negative story points must not push any share above 100%');

// Reproduce the inventory 500% case deterministically: a single negative story
// point shrinks the grand-total denominator below the (unchanged) top-2
// numerator, so the current unclamped share blows past 100. The negative lands
// on an assignee OUTSIDE the top-2, so the top-2 set and its point sum are
// unchanged; only the denominator collapses.
const rankedRef = [...refEmployees].sort(
  (a, b) => b.storyPointsTotal - a.storyPointsTotal || a.accountId.localeCompare(b.accountId),
);
const top2Ids = new Set(rankedRef.slice(0, 2).map((e) => e.accountId));
const top2Sum = rankedRef.slice(0, 2).reduce((s, e) => s + e.storyPointsTotal, 0);
const grandTotal = refEmployees.reduce((s, e) => s + e.storyPointsTotal, 0);
assert({
  ok: top2Sum > 5 && grandTotal > top2Sum,
  message: `AC-1: fixture precondition (top2Sum=${top2Sum}, grandTotal=${grandTotal}) unsuitable for the share reproduction`,
});

// Target denominator ~ top2Sum/5 -> share ~ 500%.
const targetTotal = Math.max(1, Math.floor(top2Sum / 5));
const delta = grandTotal - targetTotal;

const shareJira = cloneBaseJira();
let injected = false;
for (const issue of shareJira.issues) {
  const f = issue.fields;
  const assigneeId = f?.assignee?.accountId;
  if (
    assigneeId !== undefined &&
    !top2Ids.has(assigneeId) &&
    typeof f.customfield_10016 === 'number'
  ) {
    f.customfield_10016 = f.customfield_10016 - delta;
    injected = true;
    break;
  }
}
assert({
  ok: injected,
  message: 'AC-1: could not find a non-top-2 assigned issue to inject a negative story point into',
});

const initShare = initJira({ dir: RUN_SHARE, jira: shareJira, slackFrom: 'slack-export.json' });
assert({
  ok: initShare.status === 0,
  message: `AC-1: negative-points init exited ${initShare.status}: ${initShare.stderr.slice(0, 400)}`,
});

const shareFindings = readJson({ dir: RUN_SHARE, rel: 'data/finding.json' });
for (const f of shareFindings) {
  const pct = f?.pointer?.sharePct;
  if (typeof pct === 'number') {
    assert({
      ok: pct <= 100,
      message: `AC-1: finding id ${f.id} pointer.sharePct ${pct} > 100 (a share of team total cannot exceed 100%)`,
    });
  }
}

const shareAnalytics = readFileSync(join(RUN_SHARE, 'ANALYTICS.md'), 'utf8');
for (const m of shareAnalytics.matchAll(/carry\s+([\d.]+)%\s+of the team total/g)) {
  const pct = Number.parseFloat(m[1]);
  assert({
    ok: pct <= 100,
    message: `AC-1: ANALYTICS.md claims "carry ${pct}% of the team total" (a share cannot exceed 100%)`,
  });
}

// ─────────────── phase 2 — AC-2: no physically-impossible negative metric ─────

console.log('[phase 2] AC-2 negative points + inverted dates must never render a negative metric');

const negJira = cloneBaseJira();

// (a) a single large negative story point drives one assignee's total negative.
let negPointInjected = false;
for (const issue of negJira.issues) {
  const f = issue.fields;
  if (f?.assignee?.accountId !== undefined && typeof f.customfield_10016 === 'number') {
    f.customfield_10016 = -1_000_000;
    negPointInjected = true;
    break;
  }
}
assert({ ok: negPointInjected, message: 'AC-2: could not inject a negative story point' });

// (b) invert created/resolutiondate on every resolved issue so each cycle time
//     would be negative (the common Jira import/backfill artifact).
let invertedPairs = 0;
for (const issue of negJira.issues) {
  const f = issue.fields;
  if (typeof f?.created === 'string' && typeof f?.resolutiondate === 'string') {
    const created = Date.parse(f.created);
    const resolved = Date.parse(f.resolutiondate);
    if (Number.isFinite(created) && Number.isFinite(resolved) && resolved > created) {
      const tmp = f.created;
      f.created = f.resolutiondate;
      f.resolutiondate = tmp;
      invertedPairs += 1;
    }
  }
}
assert({ ok: invertedPairs > 0, message: 'AC-2: fixture had no resolved issues to invert' });

const initNeg = initJira({ dir: RUN_NEG, jira: negJira });
assert({
  ok: initNeg.status === 0,
  message: `AC-2: negative/inverted init exited ${initNeg.status}: ${initNeg.stderr.slice(0, 400)}`,
});

const negEmployees = readJson({ dir: RUN_NEG, rel: 'data/employee.json' });
assert({
  ok: Array.isArray(negEmployees) && negEmployees.length > 0,
  message: 'AC-2: negative/inverted run produced no employees',
});

for (const e of negEmployees) {
  assert({
    ok: e.storyPointsTotal >= 0,
    message: `AC-2: ${e.accountId}.storyPointsTotal ${e.storyPointsTotal} < 0 (negative points must be excluded, never summed)`,
  });
  assert({
    ok: e.medianCycleDaysFirstHalf >= 0,
    message: `AC-2: ${e.accountId}.medianCycleDaysFirstHalf ${e.medianCycleDaysFirstHalf} < 0 (inverted created/resolutiondate must not yield a negative cycle)`,
  });
  assert({
    ok: e.medianCycleDaysSecondHalf >= 0,
    message: `AC-2: ${e.accountId}.medianCycleDaysSecondHalf ${e.medianCycleDaysSecondHalf} < 0 (inverted created/resolutiondate must not yield a negative cycle)`,
  });
}

const negHit = firstNegative({ value: negEmployees, path: 'employee.json' });
assert({
  ok: negHit === null,
  message: `AC-2: a negative number rendered in data/employee.json at ${negHit?.path} (= ${negHit?.value}); no count or duration metric may be negative`,
});

// ─────────────── phase 3 — AC-3: excluded inputs surface a warning ────────────

console.log('[phase 3] AC-3 excluded invalid inputs must surface aggregate data-quality warnings');

const negStderr = initNeg.stderr;
assert({
  ok:
    /excluded\s+\d+\s+invalid story-point value\(s\)/i.test(negStderr) &&
    negStderr.includes('customfield_10016'),
  message: `AC-3: missing the invalid-story-point data-quality warning naming the count + customfield_10016 on stderr (stderr: ${JSON.stringify(negStderr.slice(0, 400))})`,
});
assert({
  ok:
    /excluded\s+\d+\s+issue\(s\)\s+from cycle-time stats/i.test(negStderr) &&
    /created after resolutiondate/i.test(negStderr),
  message: `AC-3: missing the inverted-date (created after resolutiondate) cycle-time data-quality warning on stderr (stderr: ${JSON.stringify(negStderr.slice(0, 400))})`,
});

// ─────────────── phase 4 — AC-4: an empty/wrong-shape export is not "success" ─

console.log('[phase 4] AC-4 empty/wrong-shape exports must warn, not report cheerful success');

const emptyShapes = [
  { dir: RUN_EMPTY_ARR, jira: [], label: 'empty array []' },
  { dir: RUN_EMPTY_OBJ, jira: {}, label: 'empty object {}' },
  { dir: RUN_ISSUES_OBJ, jira: { issues: {} }, label: 'wrong-shaped { issues: {} }' },
];

for (const { dir, jira, label } of emptyShapes) {
  const res = initJira({ dir, jira });
  exact({ actual: res.status, expected: 0, label: `AC-4: ${label} exit code` });

  assert({
    ok: res.stderr.includes('no issues recognized in jira-export.json'),
    message: `AC-4: ${label}: stderr is missing the "no issues recognized in jira-export.json" warning (stderr: ${JSON.stringify(res.stderr.slice(0, 300))})`,
  });
  assert({
    ok: !res.stdout.includes('extracted') && !res.stdout.includes('finding(s) from'),
    message: `AC-4: ${label}: stdout still prints a cheerful "extracted ... finding(s) from" success line (stdout: ${JSON.stringify(res.stdout.slice(0, 300))})`,
  });

  const findings = readJson({ dir, rel: 'data/finding.json' });
  exact({
    actual: findings.length,
    expected: 0,
    label: `AC-4: ${label}: data/finding.json must be [] (no placeholder "not evaluated" findings when the org is empty)`,
  });
}

// Control: a valid all-unassigned export HAS issues -> must NOT warn, still succeeds.
const unassignedJira = cloneBaseJira();
for (const issue of unassignedJira.issues) {
  if (issue.fields) {
    issue.fields.assignee = null;
  }
}
const initUnassigned = initJira({ dir: RUN_UNASSIGNED, jira: unassignedJira });
exact({
  actual: initUnassigned.status,
  expected: 0,
  label: 'AC-4: all-unassigned control exit code',
});
assert({
  ok: !initUnassigned.stderr.includes('no issues recognized'),
  message:
    'AC-4: a valid all-unassigned export (which HAS issues) wrongly emitted the "no issues recognized" warning',
});
assert({
  ok: initUnassigned.stdout.includes('extracted'),
  message:
    'AC-4: a valid all-unassigned export did not report the normal "extracted ..." success summary',
});

// ─────────────── phase 5 — AC-5: over-long display fields truncated in report ─

console.log(
  '[phase 5] AC-5 a 1 MB displayName must be truncated in ANALYTICS.md, raw kept in data',
);

const GIANT = 'X'.repeat(1024 * 1024);
const giantJira = cloneBaseJira();
const giantIssue = JSON.parse(JSON.stringify(giantJira.issues[0]));
giantIssue.fields.assignee = { accountId: 'acc_giant', displayName: GIANT };
giantJira.issues = [giantIssue, ...giantJira.issues.slice(1)];
const initGiant = initJira({ dir: RUN_GIANT, jira: giantJira });
assert({
  ok: initGiant.status === 0,
  message: `AC-5: 1 MB displayName init exited ${initGiant.status}: ${initGiant.stderr.slice(0, 300)}`,
});

const giantAnalytics = readFileSync(join(RUN_GIANT, 'ANALYTICS.md'), 'utf8');
assert({
  ok: !giantAnalytics.includes(GIANT),
  message:
    'AC-5: ANALYTICS.md contains the full 1 MB displayName verbatim (over-long display fields must be truncated)',
});
assert({
  ok: giantAnalytics.includes(`${GIANT.slice(0, 80)}...`),
  message: 'AC-5: ANALYTICS.md roster cell is not the expected 80-char prefix + "..." truncation',
});
assert({
  ok: Buffer.byteLength(giantAnalytics, 'utf8') < 200_000,
  message: `AC-5: ANALYTICS.md is ${Buffer.byteLength(giantAnalytics, 'utf8')} bytes — a pathological field bloated the human-readable report`,
});

const giantEmployees = readJson({ dir: RUN_GIANT, rel: 'data/employee.json' });
const giantEmployee = giantEmployees.find((e) => e.accountId === 'acc_giant');
assert({
  ok: giantEmployee !== undefined && giantEmployee.displayName === GIANT,
  message:
    'AC-5: data/employee.json must keep the full raw 1 MB displayName (only ANALYTICS.md is truncated)',
});

// ─────────────── phase 6 — AC-6: crash-free + injection-safe across battery ───

console.log(
  '[phase 6] AC-6 the whole edge battery exits without crash, configs load, hostile string inert',
);

// Every prior mutated run must have completed without crashing (empty exports
// exit 0 as a data-quality warning, not a read error).
const priorRuns = [
  { label: 'negative-points share', res: initShare },
  { label: 'negative/inverted', res: initNeg },
  { label: 'all-unassigned', res: initUnassigned },
  { label: '1 MB displayName', res: initGiant },
];
for (const { label, res } of priorRuns) {
  exact({ actual: res.status, expected: 0, label: `AC-6: ${label} run exit code` });
}

// Every emitted config across the battery must dynamic-import smoke-load.
for (const dir of [
  RUN_SHARE,
  RUN_NEG,
  RUN_EMPTY_ARR,
  RUN_EMPTY_OBJ,
  RUN_ISSUES_OBJ,
  RUN_UNASSIGNED,
  RUN_GIANT,
]) {
  assert({
    ok: existsSync(join(dir, 'orangerail.config.mjs')),
    message: `AC-6: ${dir} did not emit an orangerail.config.mjs`,
  });
  assert({
    ok: await smokeLoadConfig({ dir }),
    message: `AC-6: config in ${dir} failed to dynamic-import smoke-load`,
  });
}

// Hostile-string run: the injected string must round-trip as inert JSON data.
const HOSTILE = '"><img src=x onerror=alert(1)>; ${process.exit(1)}; */ close';
const hostileJira = cloneBaseJira();
const hostileIssue = JSON.parse(JSON.stringify(hostileJira.issues[0]));
hostileIssue.fields.assignee = { accountId: 'acc_hostile', displayName: HOSTILE };
hostileIssue.fields.summary = HOSTILE;
hostileJira.issues = [hostileIssue, ...hostileJira.issues.slice(1)];
const initHostile = initJira({ dir: RUN_HOSTILE, jira: hostileJira });
exact({ actual: initHostile.status, expected: 0, label: 'AC-6: hostile-string run exit code' });

const hostileConfig = readFileSync(join(RUN_HOSTILE, 'orangerail.config.mjs'), 'utf8');
assert({
  ok: !hostileConfig.includes('onerror='),
  message: 'AC-6: raw "onerror=" breakout reached the generated config (injection escape failed)',
});
assert({
  ok: await smokeLoadConfig({ dir: RUN_HOSTILE }),
  message: 'AC-6: hostile-string config failed to dynamic-import smoke-load',
});

// ─────────────── phase 7 — AC-7: well-formed output is byte-unchanged ─────────

console.log('[phase 7] AC-7 both-sources run over the unmutated ONT-010 fixture is byte-identical');

const initBoth = initJira({ dir: RUN_BOTH, jira: cloneBaseJira(), slackFrom: 'slack-export.json' });
assert({
  ok: initBoth.status === 0,
  message: `AC-7: both-sources init exited ${initBoth.status}: ${initBoth.stderr.slice(0, 300)}`,
});

const compareFiles = ({ rel }) => {
  const a = readFileSync(join(RUN_REF, rel), 'utf8');
  const b = readFileSync(join(RUN_BOTH, rel), 'utf8');
  assert({
    ok: a === b,
    message: `AC-7: both-sources output not byte-identical to the ONT-010 reference: ${rel} differs`,
  });
};

for (const rel of ['orangerail.config.mjs', 'ANALYTICS.md']) {
  assert({ ok: existsSync(join(RUN_BOTH, rel)), message: `AC-7: both-sources run missing ${rel}` });
  compareFiles({ rel });
}
const refDataFiles = readdirSync(join(RUN_REF, 'data')).sort();
const bothDataFiles = readdirSync(join(RUN_BOTH, 'data')).sort();
exact({
  actual: bothDataFiles.join(','),
  expected: refDataFiles.join(','),
  label: 'AC-7: both-sources data/ file set',
});
for (const name of refDataFiles) {
  compareFiles({ rel: join('data', name) });
}

// ─────────────── cleanup ──────────────────────────────────────────────────────

for (const dir of [
  RUN_REF,
  RUN_SHARE,
  RUN_NEG,
  RUN_EMPTY_ARR,
  RUN_EMPTY_OBJ,
  RUN_ISSUES_OBJ,
  RUN_UNASSIGNED,
  RUN_GIANT,
  RUN_HOSTILE,
  RUN_BOTH,
]) {
  rmSync(dir, { recursive: true, force: true });
}

console.log('ONT-013 e2e: all phases passed');
process.exit(0);
