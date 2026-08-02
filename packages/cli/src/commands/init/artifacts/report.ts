import { toRenderableValue } from '../../../render';
import type { EmployeeMetric, ExtractedOntology } from './types';

/**
 * The human-facing honesty report (plan Step 9). ANALYTICS.md opens with the
 * "onboarding map to verify in 1:1s, not a performance review" framing, prints
 * every metric with its formula and source, emits NO collapsed ranking number
 * (no score/rank/rating), and calls out tracker-view vs chat-view divergences
 * explicitly. Deterministic: rows are ordered by accountId, no timestamps.
 */

/**
 * ONT-013 D4: cap an over-long display string for the human-readable table
 * only. A pathological field (e.g. a 1 MB displayName) is truncated to 80
 * characters + a three-dot ASCII ellipsis so it cannot bloat or break the
 * ANALYTICS.md roster table. The raw value in `data/*.json` is untouched — the
 * emitter serializes ontology fields directly, so only this display is bounded.
 */
const truncateDisplay = ({ value }: { value: string }): string =>
  value.length > 80 ? `${value.slice(0, 80)}...` : value;

/**
 * The person-name display fields that can carry a free-form, attacker-controlled
 * value (a Jira `displayName`) into a finding's evidence pointer — e.g. the
 * bus-factor pointer's per-service `assignees[].displayName` or the workload
 * pointer's `names[]`. These are capped for the ANALYTICS.md render only; every
 * other pointer string (formula text, thread notes) is left verbatim.
 */
const DISPLAY_NAME_KEYS = new Set(['displayName', 'names', 'who']);

/**
 * ONT-013 D4: deep-copy a finding pointer, capping only the person-name display
 * fields so a pathological `displayName` cannot bloat or break ANALYTICS.md when
 * it surfaces inside a finding's evidence pointer (the roster cell is capped
 * separately). The original ontology object is never mutated, so `data/*.json`
 * (serialized directly by the emitter) keeps the raw value. A strict no-op on
 * well-formed input where every name is far below the 80-char cap.
 */
const capPointerDisplayNames = ({
  value,
  keyIsDisplay,
}: {
  value: unknown;
  keyIsDisplay: boolean;
}): unknown => {
  if (typeof value === 'string') {
    return keyIsDisplay ? truncateDisplay({ value }) : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => capPointerDisplayNames({ value: entry, keyIsDisplay }));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = capPointerDisplayNames({ value: v, keyIsDisplay: DISPLAY_NAME_KEYS.has(k) });
    }
    return out;
  }

  return value;
};

const METRIC_FORMULAS: [string, string][] = [
  ['ticketCount', 'count of Jira issues assigned to the person'],
  ['storyPointsTotal', 'sum of customfield_10016 over assigned issues'],
  ['complexityMix', 'story-point band per issue: lo <=2, med =3, hi >=5 (fallback: issue type)'],
  [
    'medianCycleDays',
    'median of (resolutiondate - created)/86400000 over resolved issues, split at the data midpoint',
  ],
  ['reopenRate', '100 * (assigned issues with a Reopened status transition) / ticketCount'],
  [
    'reassignments',
    'count of changelog assignee changes (given = from-person, received = to-person)',
  ],
  [
    'helpGiven / helpReceived',
    'help-edge degree: a thread reply carrying a mention or later thanks',
  ],
  [
    'weekendOffHoursShare',
    '100 * (off-hours timestamps) / (all timestamps), off-hours = weekend OR hour<7 OR hour>=22 UTC',
  ],
];

/**
 * The in-place stand-in for a value the roster could not print as it is.
 *
 * Byte-identical to `packages/cli/src/render.ts:102`, which is what
 * `approvals show` prints, what `/api/instances` serves (ONT-071) and what the
 * studio's person panel renders (ONT-072). A reader who has met the marker on
 * one of those surfaces must meet the same words here; a fourth spelling of one
 * fact would be a regression in honesty, not a gain.
 */
const unrenderable = ({ reason }: { reason: string }): string => `<UNRENDERABLE — ${reason}>`;

/**
 * ONT-071's sentence for a field JSON would drop, reused verbatim for a field
 * the row simply does not carry — for the reader the two are the same fact, and
 * `data/*.json` really would drop both.
 */
const ABSENT_REASON = 'undefined, which JSON drops key and all';

/** How much of a stray string reaches a marker, so one field cannot flood the row. */
const MAX_PREVIEW_CHARS = 40;

/**
 * Name what a value IS, in ONT-071's spellings, so the roster and the two
 * surfaces that already report on these same rows describe them the same way.
 *
 * The cases `render.ts` turns into markers before the roster ever sees them — a
 * bigint, a symbol, a function, a non-finite number — are still spelled here:
 * this vocabulary is copied to be identical, not trimmed to what is reachable
 * today.
 */
const describeValue = ({ value }: { value: unknown }): string => {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string': {
      const clipped =
        value.length > MAX_PREVIEW_CHARS ? `${value.slice(0, MAX_PREVIEW_CHARS)}...` : value;

      return `a string (${JSON.stringify(clipped)})`;
    }
    case 'number':
      return `the number ${String(value)}`;
    case 'boolean':
      return `the boolean ${String(value)}`;
    case 'bigint':
      return `a bigint (${value.toString()})`;
    case 'symbol':
      return `a symbol (${value.toString()})`;
    case 'function':
      return `a function (${value.name === '' ? 'anonymous' : value.name})`;
    case 'undefined':
      return 'undefined';
    default:
      return Array.isArray(value) ? `an array of ${value.length} item(s)` : 'an object';
  }
};

/**
 * Fit one rendered value into a markdown table cell.
 *
 * A cell ends at a `|` and a row ends at a newline, so a value carrying either
 * does not just look wrong — it silently becomes other columns. A display name
 * of `Ann | 9 | 999 | yes` used to shift every metric one cell left per pipe,
 * and a name carrying CRLF used to end the table where it sat. Both are real
 * values a Jira export can hold, so both are ESCAPED and kept rather than
 * marked: the person really is called that, and throwing the name away to
 * protect the table would be the same lie in the other direction.
 *
 * The ONT-013 D4 cap still applies, and applies to markers too, so a long
 * failure message cannot bloat the row either. Capping before escaping keeps
 * the cap meaning "80 characters of the value", as it always did.
 */
const cellText = ({ value }: { value: string }): string =>
  truncateDisplay({ value: value.replace(/[\r\n]+/g, ' ') }).replaceAll('|', '\\|');

/** A cell that names, in place, the value the column could not print. */
const markerCell = ({ reason }: { reason: string }): string =>
  cellText({ value: unrenderable({ reason }) });

/** A cell naming a value that is not the thing its column declares. */
const mismatchCell = ({ value, declared }: { value: unknown; declared: string }): string =>
  markerCell({ reason: `${describeValue({ value })} where the row declares ${declared}` });

/** One field of a row: what was there, or the reason the roster cannot print it. */
type Reading = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * One row's JSON-safe mirror, plus the reasons the walk that produced it left
 * behind.
 *
 * `toRenderableValue` (`render.ts:296`) walks the row once and returns two
 * things: a mirror in which every part JSON cannot carry has already become
 * ONT-071's marker, and a list — derived from the walk, never from the rendered
 * text — of where and why. Reading through the mirror is what makes a throwing
 * getter, a cycle and a non-finite number the roster's problem instead of the
 * caller's; consulting the list is what keeps a value that literally spells the
 * marker from being mistaken for a refusal.
 */
interface RowMirror {
  root: string;
  mirror: unknown;
  refused: Map<string, string>;
}

const mirrorRow = ({ employee, index }: { employee: EmployeeMetric; index: number }): RowMirror => {
  const root = `employee[${index}]`;
  const { value: mirror, fields } = toRenderableValue({ value: employee, path: root });

  return { root, mirror, refused: new Map(fields.map((field) => [field.path, field.reason])) };
};

/**
 * Read one declared field off a row's mirror.
 *
 * `EmployeeMetric` (`types.ts:87`) says every field is present. That declaration
 * is a contract nothing on the way in enforces, so the row is read as the
 * unknown it actually is. A key the row does not carry is a reason, never an
 * `undefined` interpolated into the table as the word "undefined".
 */
const readField = ({
  row,
  from,
  at,
  key,
}: {
  row: RowMirror;
  from: unknown;
  /** The path of `from` itself, as the walk named it. */
  at: string;
  key: string;
}): Reading => {
  const refusedHere = row.refused.get(`${at}.${key}`);

  if (refusedHere !== undefined) {
    return { ok: false, reason: refusedHere };
  }

  const refusedParent = row.refused.get(at);

  if (refusedParent !== undefined) {
    return { ok: false, reason: refusedParent };
  }

  if (from === null || typeof from !== 'object') {
    return {
      ok: false,
      reason: `${describeValue({ value: from })} where the row declares an object`,
    };
  }

  const value = (from as Record<string, unknown>)[key];

  return value === undefined ? { ok: false, reason: ABSENT_REASON } : { ok: true, value };
};

/** A field read straight off the row, which is where every column but the mix starts. */
const readRow = ({ row, key }: { row: RowMirror; key: string }): Reading =>
  readField({ row, from: row.mirror, at: row.root, key });

/** What every metric column of this table is allowed to be. */
const METRIC_DECLARED = 'a number or "unavailable"';

/**
 * A metric as the roster prints it, or `null` when the value is not one.
 *
 * A number renders as its digits and the literal `'unavailable'` as `n/a` —
 * both exactly what this table printed before.
 *
 * `'unavailable'` is accepted on ALL ten metric columns, including the five
 * `EmployeeMetric` declares as plain numbers. It is the scanner's own spelling
 * for "no value" (`types.ts:84`), already written into the other five, and the
 * two declarations of one emitted row disagree about which is which: the studio
 * reads the same `data/employee.json` through `InstanceEmployee`
 * (`packages/studio/src/snapshot/instances.ts:21-34`), which calls
 * `medianCycleDays*` and `weekendOffHoursShare` a `MetricValue` and
 * `helpGiven`/`helpReceived` a plain `number` — the opposite split. Taking the
 * wider reading marks nothing that a surface already prints as a word, which is
 * the judgement #109 made first: marking `'unavailable'` would be a regression
 * in honesty rather than a gain.
 */
const metricText = ({ value }: { value: unknown }): string | null => {
  if (typeof value === 'number') {
    return String(value);
  }

  return value === 'unavailable' ? 'n/a' : null;
};

/** One metric column, as its value or as the marker that names it. */
const metricCell = ({ row, key }: { row: RowMirror; key: string }): string => {
  const read = readRow({ row, key });

  if (!read.ok) {
    return markerCell({ reason: read.reason });
  }

  const text = metricText({ value: read.value });

  return text === null
    ? mismatchCell({ value: read.value, declared: METRIC_DECLARED })
    : cellText({ value: text });
};

/** One column the row declares as a plain string (the identity columns). */
const stringCell = ({ row, key }: { row: RowMirror; key: string }): string => {
  const read = readRow({ row, key });

  if (!read.ok) {
    return markerCell({ reason: read.reason });
  }

  return typeof read.value === 'string'
    ? cellText({ value: read.value })
    : mismatchCell({ value: read.value, declared: 'a string' });
};

/**
 * The active column.
 *
 * A row with no `active` used to print `no`, which a reader has no way to tell
 * apart from "this person left the team" — a missing field asserting a fact
 * about a person is the quiet omission ONT-070 exists to stop.
 */
const activeCell = ({ row }: { row: RowMirror }): string => {
  const read = readRow({ row, key: 'active' });

  if (!read.ok) {
    return markerCell({ reason: read.reason });
  }

  if (typeof read.value !== 'boolean') {
    return mismatchCell({ value: read.value, declared: 'a boolean' });
  }

  return read.value ? 'yes' : 'no';
};

/** The complexity mix parts, in the order the roster prints them. */
const MIX_KEYS = ['hi', 'med', 'lo'] as const;

/** What the complexity mix column is allowed to be. */
const MIX_DECLARED = 'an object with hi/med/lo';

/**
 * The complexity mix as `hi/med/lo`, or ONE marker for the whole column.
 *
 * Named once rather than as three interleaved markers (#109's rule): the reason
 * says which part is missing, which is the fact a reader needs, and the row
 * stays readable. Each part must be a number — the `/` separator would make
 * `1/n/a/0` unreadable, so `'unavailable'` is not accepted here even though
 * every other metric column takes it.
 */
const mixCell = ({ row }: { row: RowMirror }): string => {
  const read = readRow({ row, key: 'complexityMix' });

  if (!read.ok) {
    return markerCell({ reason: read.reason });
  }

  if (read.value === null || typeof read.value !== 'object') {
    return mismatchCell({ value: read.value, declared: MIX_DECLARED });
  }

  const at = `${row.root}.complexityMix`;
  const parts: string[] = [];

  for (const key of MIX_KEYS) {
    const part = readField({ row, from: read.value, at, key });

    if (!part.ok) {
      return markerCell({ reason: `its ${key} is ${part.reason}` });
    }

    if (typeof part.value !== 'number') {
      const was = describeValue({ value: part.value });

      return markerCell({ reason: `its ${key} is ${was} where the row declares a number` });
    }

    parts.push(String(part.value));
  }

  return parts.join('/');
};

/** Render the per-person metrics table (no ranking / score column). */
const renderRoster = ({ employees }: { employees: EmployeeMetric[] }): string => {
  const header =
    '| accountId | name | active | tickets | storyPoints | hi/med/lo | reopen% | reassign g/r | helpGiven | helpReceived | offHours% | cycle 1st/2nd |';
  const divider = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';

  const rows = employees.map((employee, index) => {
    const row = mirrorRow({ employee, index });

    const reassign = `${metricCell({ row, key: 'reassignmentsGiven' })}/${metricCell({ row, key: 'reassignmentsReceived' })}`;
    const cycle = `${metricCell({ row, key: 'medianCycleDaysFirstHalf' })}/${metricCell({ row, key: 'medianCycleDaysSecondHalf' })}`;

    return `| ${stringCell({ row, key: 'accountId' })} | ${stringCell({ row, key: 'displayName' })} | ${activeCell({ row })} | ${metricCell({ row, key: 'ticketCount' })} | ${metricCell({ row, key: 'storyPointsTotal' })} | ${mixCell({ row })} | ${metricCell({ row, key: 'reopenRate' })} | ${reassign} | ${metricCell({ row, key: 'helpGiven' })} | ${metricCell({ row, key: 'helpReceived' })} | ${metricCell({ row, key: 'weekendOffHoursShare' })} | ${cycle} |`;
  });

  return [header, divider, ...rows].join('\n');
};

/** Render the full ANALYTICS.md report body. */
export const renderReport = ({ ontology }: { ontology: ExtractedOntology }): string => {
  // H3: name only the sources actually provided. The both-sources header is
  // byte-frozen; a Jira-only run drops the "and Slack" claim.
  const sourceLine = ontology.slackProvided
    ? 'number below is a structural proxy computed mechanically from a Jira and Slack'
    : 'number below is a structural proxy computed mechanically from a Jira';

  // AC-3: on a Jira-only run, declare exactly which signals went unmeasured.
  // Absent on the both-sources path, so those bytes stay unchanged.
  const notEvaluatedSection: string[] = ontology.slackProvided
    ? []
    : [
        '## Not evaluated without a Slack export',
        '',
        'No Slack export was provided, so the following chat-derived signals could not',
        'be evaluated and are omitted rather than guessed:',
        '',
        '- help given / received per person (shown as `n/a`)',
        '- KNOWLEDGE FLOW help hubs',
        '- INVISIBLE VALUE (chat help versus tracker weight)',
        '- Slack-only incidents and the approval-vacuum pattern',
        '',
      ];

  const lines: string[] = [
    '# Org onboarding map',
    '',
    'This is an **onboarding map to verify in 1:1s, not a performance review**. Every',
    sourceLine,
    'export — no model read any message. Treat each figure as a question to ask, not a',
    'verdict. People are never ranked or scored; there is no composite number here.',
    '',
    '## Metric formulas',
    '',
    'Every metric carries its formula and source (a number never appears without its',
    'derivation):',
    '',
    ...METRIC_FORMULAS.map(([name, formula]) => `- **${name}** — formula: ${formula}.`),
    '',
    '## Per-person metrics',
    '',
    renderRoster({ employees: ontology.employees }),
    '',
    '## Tracker-view vs chat-view',
    '',
    'The Jira tracker view (tickets, story points) and the Slack chat view (help',
    'given/received) can diverge sharply: a mid-pack story-point total can hide a top',
    'help hub, and a high ticket count can hide low-weight work with no help given.',
    'Read the two columns together, never one alone.',
    '',
    ...notEvaluatedSection,
    '## Findings',
    '',
  ];

  for (const finding of ontology.findings) {
    lines.push(`### ${finding.id}. ${finding.title}`);
    lines.push('');
    lines.push(finding.detail);
    lines.push('');
    lines.push('Evidence pointer:');
    lines.push('');
    lines.push('```json');
    lines.push(
      JSON.stringify(
        capPointerDisplayNames({ value: finding.pointer, keyIsDisplay: false }),
        null,
        2,
      ),
    );
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
};
