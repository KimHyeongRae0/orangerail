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

    return `| ${e.accountId} | ${e.displayName} | ${e.active ? 'yes' : 'no'} | ${e.ticketCount} | ${e.storyPointsTotal} | ${mix} | ${show({ value: e.reopenRate })} | ${reassign} | ${e.helpGiven} | ${e.helpReceived} | ${e.weekendOffHoursShare} | ${cycle} |`;
  });

  return [header, divider, ...rows].join('\n');
};

/** Render the full ANALYTICS.md report body. */
export const renderReport = ({ ontology }: { ontology: ExtractedOntology }): string => {
  const lines: string[] = [
    '# Org onboarding map',
    '',
    'This is an **onboarding map to verify in 1:1s, not a performance review**. Every',
    'number below is a structural proxy computed mechanically from a Jira and Slack',
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
    lines.push(JSON.stringify(finding.pointer, null, 2));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
};
