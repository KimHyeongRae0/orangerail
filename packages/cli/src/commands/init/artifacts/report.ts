import type { EmployeeMetric, ExtractedOntology, MetricOrUnavailable } from './types';

/**
 * The human-facing honesty report (plan Step 9). ANALYTICS.md opens with the
 * "onboarding map to verify in 1:1s, not a performance review" framing, prints
 * every metric with its formula and source, emits NO collapsed ranking number
 * (no score/rank/rating), and calls out tracker-view vs chat-view divergences
 * explicitly. Deterministic: rows are ordered by accountId, no timestamps.
 */

const show = ({ value }: { value: MetricOrUnavailable }): string =>
  value === 'unavailable' ? 'n/a' : String(value);

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

/** Render the per-person metrics table (no ranking / score column). */
const renderRoster = ({ employees }: { employees: EmployeeMetric[] }): string => {
  const header =
    '| accountId | name | active | tickets | storyPoints | hi/med/lo | reopen% | reassign g/r | helpGiven | helpReceived | offHours% | cycle 1st/2nd |';
  const divider = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';

  const rows = employees.map((e) => {
    const mix = `${e.complexityMix.hi}/${e.complexityMix.med}/${e.complexityMix.lo}`;
    const reassign = `${show({ value: e.reassignmentsGiven })}/${show({ value: e.reassignmentsReceived })}`;
    const cycle = `${e.medianCycleDaysFirstHalf}/${e.medianCycleDaysSecondHalf}`;

    return `| ${e.accountId} | ${truncateDisplay({ value: e.displayName })} | ${e.active ? 'yes' : 'no'} | ${e.ticketCount} | ${e.storyPointsTotal} | ${mix} | ${show({ value: e.reopenRate })} | ${reassign} | ${show({ value: e.helpGiven })} | ${show({ value: e.helpReceived })} | ${e.weekendOffHoursShare} | ${cycle} |`;
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
