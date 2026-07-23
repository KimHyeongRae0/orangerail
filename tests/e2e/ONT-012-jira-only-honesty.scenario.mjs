/**
 * ONT-012 e2e driver — Jira-only honesty + low-evidence robustness hardening.
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) over a Jira-only run and an
 * adversarial edge battery built by MUTATING the committed ONT-010 Jira fixture
 * (tests/e2e/fixtures/ont-010/jira-export.json) at runtime into per-phase run
 * dirs under .docs/scratch. No fixture JSON is committed for ONT-012 — every
 * variant is derived deterministically from the ONT-010 fixture so the real
 * parse -> metrics -> graph -> findings -> emit pipeline is exercised. Pure Node
 * stdlib: no Playwright, no browser (these are data/report contract assertions).
 *
 * The scenario proves the ticket's acceptance criteria (AC-1..AC-7):
 *
 *   phase 1  (AC-1) Jira-only run: every employee helpGiven/helpReceived is the
 *            literal "unavailable" (never 0); Jira-computable metrics
 *            (ticketCount, storyPointsTotal, complexityMix, reopenRate,
 *            reassignments, cycle) are unchanged vs the both-sources reference.
 *   phase 2  (AC-2) Jira-only finding.json + ANALYTICS.md carry no
 *            self-contradicting text (no "top help-giver", "helpGiven=0",
 *            "help interactions total", "concentrate on a few hubs"); the four
 *            Slack-dependent findings (ids 2/3/4/6) are absent or marked
 *            "not evaluated — no Slack export".
 *   phase 3  (AC-3) Jira-only ANALYTICS.md names a Jira export only (no
 *            "Jira and Slack export" header claim) and carries a
 *            "not evaluated without a Slack export" note; the CLI stdout summary
 *            names only Jira (no "Slack" token).
 *   phase 4  (AC-4) empty-issues + single-issue runs emit no evidence-free
 *            confident org findings (workload/bus-factor dropped); the report
 *            degrades to a clear low-data state.
 *   phase 5  (AC-6 regression) all-unassigned + no-changelog Jira-only runs exit
 *            0 and emit a config that dynamic-import smoke-loads; no-changelog
 *            keeps reopen/reassignment metrics "unavailable" (ONT-010 behavior).
 *   phase 6  (AC-5) story-points-all-null run: complexityMix degrades honestly to
 *            { hi: 0, med: 0, lo: ticketCount } for every employee, consistent
 *            with storyPointsTotal 0 — no fabricated hi/med spread.
 *   phase 7  (AC-6 injection) hostile-string run: the injected string is inert
 *            (JSON-encoded round-trip, no raw onerror= breakout in the config),
 *            the run exits 0, and the config dynamic-import smoke-loads.
 *   phase 8  (AC-7) both-sources run: orangerail.config.mjs + every data/*.json +
 *            ANALYTICS.md are BYTE-IDENTICAL to the both-sources reference
 *            (the ONT-010 output), across two fresh runs (determinism).
 *
 * RED (pre-implementation): the shipped CLI writes helpGiven=0 (not
 * "unavailable"), ships "Dave Holt is the top help-giver (helpGiven=0)" and
 * "0 help interactions total", writes the "Jira and Slack export" header on a
 * Jira-only run, emits six confident findings on an empty corpus, and produces a
 * hi/med/lo complexity spread with storyPointsTotal=0 — so phases 1, 2, 3, 4 and
 * 6 FAIL on genuine honesty/robustness assertions while phases 5, 7, 8 (the
 * ONT-010 guarantees this ticket preserves) already pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE_010 = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-010');
const SCRATCH = join(ROOT, '.docs', 'scratch');

const RUN_REF = join(SCRATCH, 'ont-012-run-ref');
const RUN_BOTH = join(SCRATCH, 'ont-012-run-both');
const RUN_JIRA = join(SCRATCH, 'ont-012-run-jira');
const RUN_EMPTY = join(SCRATCH, 'ont-012-run-empty');
const RUN_SINGLE = join(SCRATCH, 'ont-012-run-single');
const RUN_UNASSIGNED = join(SCRATCH, 'ont-012-run-unassigned');
const RUN_NOCL = join(SCRATCH, 'ont-012-run-nochangelog');
const RUN_POINTS = join(SCRATCH, 'ont-012-run-points-null');
const RUN_HOSTILE = join(SCRATCH, 'ont-012-run-hostile');

const BASE_JIRA = JSON.parse(readFileSync(join(FIXTURE_010, 'jira-export.json'), 'utf8'));

const fail = ({ message }) => {
  console.error(`ONT-012 e2e FAIL: ${message}`);
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
 * it. `slackFrom` (a rel path already copied into the dir) opts into a
 * both-sources run; omit it for the realistic Jira-only path.
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

// ─────────────── reference — both-sources output (the ONT-010 output) ─────────

console.log('[setup] capture both-sources reference (== ONT-010 output)');

const initRef = initJira({ dir: RUN_REF, jira: cloneBaseJira(), slackFrom: 'slack-export.json' });
assert({
  ok: initRef.status === 0,
  message: `both-sources reference init exited ${initRef.status}: ${initRef.stderr.slice(0, 400)}`,
});
const refEmployees = readJson({ dir: RUN_REF, rel: 'data/employee.json' });
const refById = new Map(refEmployees.map((e) => [e.accountId, e]));

// ─────────────── phase 1 — AC-1: Slack-derived metrics are "unavailable" ──────

console.log('[phase 1] AC-1 Jira-only run: help metrics "unavailable", Jira metrics unchanged');

const initJiraOnly = initJira({ dir: RUN_JIRA, jira: cloneBaseJira() });
assert({
  ok: initJiraOnly.status === 0,
  message: `AC-1: Jira-only init exited ${initJiraOnly.status}: ${initJiraOnly.stderr.slice(0, 400)}`,
});

const jiraEmployees = readJson({ dir: RUN_JIRA, rel: 'data/employee.json' });
assert({
  ok: Array.isArray(jiraEmployees) && jiraEmployees.length > 0,
  message: 'AC-1: Jira-only run produced no employees',
});

for (const e of jiraEmployees) {
  exact({
    actual: e.helpGiven,
    expected: 'unavailable',
    label: `AC-1: ${e.accountId}.helpGiven with no Slack export`,
  });
  exact({
    actual: e.helpReceived,
    expected: 'unavailable',
    label: `AC-1: ${e.accountId}.helpReceived with no Slack export`,
  });
}

// Jira-computable metrics must be byte-for-byte the both-sources values.
const JIRA_ONLY_METRICS = [
  'ticketCount',
  'storyPointsTotal',
  'reopenRate',
  'reassignmentsGiven',
  'reassignmentsReceived',
  'medianCycleDaysFirstHalf',
  'medianCycleDaysSecondHalf',
];
for (const e of jiraEmployees) {
  const ref = refById.get(e.accountId);
  assert({
    ok: ref !== undefined,
    message: `AC-1: ${e.accountId} missing from both-sources reference`,
  });

  for (const metric of JIRA_ONLY_METRICS) {
    exact({
      actual: e[metric],
      expected: ref[metric],
      label: `AC-1: ${e.accountId}.${metric} (Jira-computable, must be unchanged)`,
    });
  }
  for (const band of ['hi', 'med', 'lo']) {
    exact({
      actual: e.complexityMix?.[band],
      expected: ref.complexityMix?.[band],
      label: `AC-1: ${e.accountId}.complexityMix.${band} (Jira-computable, must be unchanged)`,
    });
  }
}

// ─────────────── phase 2 — AC-2: no self-contradicting finding text ───────────

console.log('[phase 2] AC-2 no superlative over an unavailable/0 value; Slack findings marked');

const jiraFindings = readJson({ dir: RUN_JIRA, rel: 'data/finding.json' });
const jiraFindingsText = JSON.stringify(jiraFindings);
const jiraAnalytics = readFileSync(join(RUN_JIRA, 'ANALYTICS.md'), 'utf8');

const FORBIDDEN = [
  'top help-giver',
  'concentrate on a few hubs',
  'help interactions total',
  'helpGiven=0',
];
for (const phrase of FORBIDDEN) {
  assert({
    ok: !jiraFindingsText.includes(phrase),
    message: `AC-2: finding.json contains self-contradicting phrase "${phrase}" on a Jira-only run`,
  });
  assert({
    ok: !jiraAnalytics.includes(phrase),
    message: `AC-2: ANALYTICS.md contains self-contradicting phrase "${phrase}" on a Jira-only run`,
  });
}

// The four Slack-dependent findings must be absent or an explicit not-evaluated note.
for (const id of [2, 3, 4, 6]) {
  const f = jiraFindings.find((x) => x.id === id);
  const marked =
    f === undefined || (/not evaluated/i.test(f.detail ?? '') && /slack/i.test(f.detail ?? ''));
  assert({
    ok: marked,
    message: `AC-2: Slack-dependent finding id ${id} is neither suppressed nor marked "not evaluated - no Slack export" (detail: ${JSON.stringify(f?.detail ?? null).slice(0, 160)})`,
  });
}

// No pointer may carry a helpGiven number alongside a superlative claim.
assert({
  ok: !/helpGiven"\s*:\s*0/.test(jiraFindingsText),
  message: 'AC-2: a finding pointer still asserts helpGiven=0 over an unavailable value',
});

// ─────────────── phase 3 — AC-3: report names only the Jira source ────────────

console.log('[phase 3] AC-3 report + CLI summary name the Jira export only');

// The report line-wraps "...from a Jira and Slack\nexport", so match the
// contiguous "Jira and Slack" claim (present only in the both-sources header).
assert({
  ok: !jiraAnalytics.includes('Jira and Slack'),
  message:
    'AC-3: Jira-only ANALYTICS.md still claims it was computed from a "Jira and Slack" export',
});
assert({
  ok: /not evaluated without a slack export/i.test(jiraAnalytics),
  message:
    'AC-3: Jira-only ANALYTICS.md is missing the "not evaluated without a Slack export" note',
});
assert({
  ok: !initJiraOnly.stdout.includes('Slack'),
  message: `AC-3: Jira-only CLI summary still names Slack: ${JSON.stringify(initJiraOnly.stdout.split('\n')[0] ?? '')}`,
});

// ─────────────── phase 4 — AC-4: evidence-free findings are suppressed ─────────

console.log('[phase 4] AC-4 empty + single-issue runs emit no evidence-free confident findings');

const emptyJira = cloneBaseJira();
emptyJira.issues = [];
const initEmpty = initJira({ dir: RUN_EMPTY, jira: emptyJira });
assert({
  ok: initEmpty.status === 0,
  message: `AC-4: empty-issues init exited ${initEmpty.status}: ${initEmpty.stderr.slice(0, 300)}`,
});

const emptyEmployees = readJson({ dir: RUN_EMPTY, rel: 'data/employee.json' });
exact({ actual: emptyEmployees.length, expected: 0, label: 'AC-4: empty-issues employee count' });

const emptyFindings = readJson({ dir: RUN_EMPTY, rel: 'data/finding.json' });
const emptyAnalytics = readFileSync(join(RUN_EMPTY, 'ANALYTICS.md'), 'utf8');
assert({
  ok: emptyFindings.find((f) => f.id === 1) === undefined,
  message:
    'AC-4: WORKLOAD CONCENTRATION (id 1) emitted on an empty corpus (0 story points, no evidence)',
});
assert({
  ok: emptyFindings.find((f) => f.id === 5) === undefined,
  message: 'AC-4: BUS FACTOR (id 5) emitted on an empty corpus (0 services, no evidence)',
});
assert({
  ok: !emptyAnalytics.includes('Top 2 by story points carry'),
  message: 'AC-4: empty-corpus ANALYTICS.md still ships the confident workload finding',
});

// single issue: assigned, but no story points and no components -> no confident finding.
const singleJira = cloneBaseJira();
const firstIssue = JSON.parse(JSON.stringify(singleJira.issues[0]));
delete firstIssue.fields.customfield_10016;
firstIssue.fields.components = [];
firstIssue.fields.labels = [];
singleJira.issues = [firstIssue];
const initSingle = initJira({ dir: RUN_SINGLE, jira: singleJira });
assert({
  ok: initSingle.status === 0,
  message: `AC-4: single-issue init exited ${initSingle.status}: ${initSingle.stderr.slice(0, 300)}`,
});

const singleFindings = readJson({ dir: RUN_SINGLE, rel: 'data/finding.json' });
assert({
  ok: singleFindings.find((f) => f.id === 1) === undefined,
  message: 'AC-4: WORKLOAD CONCENTRATION (id 1) emitted on a single issue with no story points',
});
assert({
  ok: singleFindings.find((f) => f.id === 5) === undefined,
  message: 'AC-4: BUS FACTOR (id 5) emitted on a single issue with no service component',
});

// ─────────────── phase 5 — AC-6 regression: degraded inputs never crash ───────

console.log('[phase 5] AC-6 all-unassigned + no-changelog runs exit 0 and load');

const unassignedJira = cloneBaseJira();
for (const issue of unassignedJira.issues) {
  if (issue.fields) {
    issue.fields.assignee = null;
  }
}
const initUnassigned = initJira({ dir: RUN_UNASSIGNED, jira: unassignedJira });
assert({
  ok: initUnassigned.status === 0,
  message: `AC-6: all-unassigned init exited ${initUnassigned.status}: ${initUnassigned.stderr.slice(0, 300)}`,
});
assert({
  ok: await smokeLoadConfig({ dir: RUN_UNASSIGNED }),
  message: 'AC-6: all-unassigned config failed to dynamic-import smoke-load',
});

const noChangelogJira = cloneBaseJira();
for (const issue of noChangelogJira.issues) {
  delete issue.changelog;
}
const initNoCl = initJira({ dir: RUN_NOCL, jira: noChangelogJira });
assert({
  ok: initNoCl.status === 0,
  message: `AC-6: no-changelog init exited ${initNoCl.status}: ${initNoCl.stderr.slice(0, 300)}`,
});
assert({
  ok: await smokeLoadConfig({ dir: RUN_NOCL }),
  message: 'AC-6: no-changelog config failed to dynamic-import smoke-load',
});
const noClEmployees = readJson({ dir: RUN_NOCL, rel: 'data/employee.json' });
assert({
  ok: noClEmployees.every(
    (e) =>
      e.reopenRate === 'unavailable' &&
      e.reassignmentsGiven === 'unavailable' &&
      e.reassignmentsReceived === 'unavailable',
  ),
  message:
    'AC-6: no-changelog run must mark reopen/reassignment metrics "unavailable" (ONT-010 behavior)',
});

// ─────────────── phase 6 — AC-5: honest complexity band without points ────────

console.log(
  '[phase 6] AC-5 points-null run: complexityMix degrades to { hi:0, med:0, lo:tickets }',
);

const pointsNullJira = cloneBaseJira();
for (const issue of pointsNullJira.issues) {
  if (issue.fields) {
    delete issue.fields.customfield_10016;
  }
}
const initPoints = initJira({ dir: RUN_POINTS, jira: pointsNullJira });
assert({
  ok: initPoints.status === 0,
  message: `AC-5: points-null init exited ${initPoints.status}: ${initPoints.stderr.slice(0, 300)}`,
});

const pointsEmployees = readJson({ dir: RUN_POINTS, rel: 'data/employee.json' });
for (const e of pointsEmployees) {
  exact({
    actual: e.storyPointsTotal,
    expected: 0,
    label: `AC-5: ${e.accountId}.storyPointsTotal (points absent)`,
  });
  exact({
    actual: e.complexityMix.hi,
    expected: 0,
    label: `AC-5: ${e.accountId}.complexityMix.hi (fabricated spread)`,
  });
  exact({
    actual: e.complexityMix.med,
    expected: 0,
    label: `AC-5: ${e.accountId}.complexityMix.med (fabricated spread)`,
  });
  exact({
    actual: e.complexityMix.lo,
    expected: e.ticketCount,
    label: `AC-5: ${e.accountId}.complexityMix.lo should equal ticketCount when points are absent`,
  });
}

// ─────────────── phase 7 — AC-6 injection: hostile strings stay inert ─────────

console.log('[phase 7] AC-6 hostile-string run: injected string inert, config loads');

const HOSTILE = '"><img src=x onerror=alert(1)>; ${process.exit(1)}; */ close';
const hostileJira = cloneBaseJira();
const hostileIssue = JSON.parse(JSON.stringify(hostileJira.issues[0]));
hostileIssue.fields.assignee = { accountId: 'acc_hostile', displayName: HOSTILE };
hostileIssue.fields.summary = HOSTILE;
hostileJira.issues = [hostileIssue, ...hostileJira.issues.slice(1)];
const initHostile = initJira({ dir: RUN_HOSTILE, jira: hostileJira });
assert({
  ok: initHostile.status === 0,
  message: `AC-6: hostile-string init exited ${initHostile.status}: ${initHostile.stderr.slice(0, 300)}`,
});

const hostileConfig = readFileSync(join(RUN_HOSTILE, 'orangerail.config.mjs'), 'utf8');
assert({
  ok: !hostileConfig.includes('onerror='),
  message: 'AC-6: raw "onerror=" breakout reached the generated config (injection escape failed)',
});

// The hostile displayName must survive as JSON-encoded data (inert), round-trippable.
const hostileEmployees = readJson({ dir: RUN_HOSTILE, rel: 'data/employee.json' });
const injected = hostileEmployees.find((e) => e.accountId === 'acc_hostile');
assert({
  ok: injected !== undefined && injected.displayName === HOSTILE,
  message: 'AC-6: hostile displayName was not preserved verbatim as JSON-encoded data',
});
assert({
  ok: await smokeLoadConfig({ dir: RUN_HOSTILE }),
  message: 'AC-6: hostile-string config failed to dynamic-import smoke-load',
});

// ─────────────── phase 8 — AC-7: both-sources output is byte-unchanged ────────

console.log('[phase 8] AC-7 both-sources run is byte-identical to the ONT-010 output');

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

console.log('ONT-012 e2e: all phases passed');
process.exit(0);
