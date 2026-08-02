import { describe, expect, it } from 'vitest';

import { toRenderableValue } from '../../../render';
import { renderReport } from './report';
import type { EmployeeMetric, ExtractedOntology } from './types';

const ontology: ExtractedOntology = {
  employees: [
    {
      accountId: 'acc_a',
      displayName: 'Ann A',
      active: true,
      ticketCount: 3,
      storyPointsTotal: 8,
      complexityMix: { hi: 1, med: 1, lo: 1 },
      medianCycleDaysFirstHalf: 1.2,
      medianCycleDaysSecondHalf: 1.4,
      reopenRate: 'unavailable',
      reassignmentsGiven: 'unavailable',
      reassignmentsReceived: 'unavailable',
      helpGiven: 2,
      helpReceived: 1,
      weekendOffHoursShare: 10,
    },
  ],
  team: { id: 'com', name: 'Commerce', project: 'COM' },
  services: [],
  incidents: [],
  memberOf: [],
  worksOn: [],
  helps: [],
  candidates: [],
  findings: [
    { id: 1, title: 'WORKLOAD CONCENTRATION', detail: 'x', pointer: { accountIds: ['acc_a'] } },
  ],
  deployGateEvidenced: false,
  slackProvided: false,
};

describe('renderReport', () => {
  const report = renderReport({ ontology });

  it('opens with the onboarding-map framing', () => {
    expect(/onboarding map|verify in 1:1|not a performance review/i.test(report)).toBe(true);
  });

  it('presents metric formulas', () => {
    expect(/formula/i.test(report)).toBe(true);
  });

  it('contains no ranking / score column', () => {
    const rankingColumn = /\|\s*(overall|composite)?\s*(score|rank|rating)\s*\|/i;
    expect(rankingColumn.test(report)).toBe(false);
  });

  it('names a Jira export only and carries the "not evaluated" note when Slack is absent', () => {
    expect(report.includes('Jira and Slack')).toBe(false);
    expect(/not evaluated without a slack export/i.test(report)).toBe(true);
  });

  it('renders an "unavailable" help metric as n/a (never a raw literal)', () => {
    // The roster row for acc_a: helpGiven/helpReceived are "unavailable".
    const withUnavailableHelp = renderReport({
      ontology: {
        ...ontology,
        employees: [
          { ...ontology.employees[0]!, helpGiven: 'unavailable', helpReceived: 'unavailable' },
        ],
      },
    });
    expect(withUnavailableHelp.includes('| n/a | n/a |')).toBe(true);
    expect(withUnavailableHelp.includes('unavailable')).toBe(false);
  });

  it('names both sources and omits the note when a Slack export is provided', () => {
    const both = renderReport({ ontology: { ...ontology, slackProvided: true } });
    expect(both.includes('Jira and Slack')).toBe(true);
    expect(/not evaluated without a slack export/i.test(both)).toBe(false);
  });

  it('truncates an over-long display name in the roster cell with "..." (ONT-013 D4)', () => {
    const giant = 'X'.repeat(1000);
    const withGiant = renderReport({
      ontology: {
        ...ontology,
        employees: [{ ...ontology.employees[0]!, displayName: giant }],
      },
    });

    expect(withGiant.includes(giant)).toBe(false);
    expect(withGiant.includes(`${giant.slice(0, 80)}...`)).toBe(true);
  });

  it('renders a short display name verbatim (no truncation on valid input)', () => {
    expect(report.includes('| Ann A |')).toBe(true);
  });

  it('caps a display name that surfaces inside a finding pointer, leaving data raw (ONT-013 D4)', () => {
    const giant = 'X'.repeat(1000);
    const withGiantPointer = renderReport({
      ontology: {
        ...ontology,
        findings: [
          {
            id: 5,
            title: 'BUS FACTOR (per-service ownership)',
            detail: 'x',
            pointer: {
              services: [
                {
                  id: 'svc',
                  assignees: [{ accountId: 'acc_giant', displayName: giant, count: 1 }],
                },
              ],
            },
          },
        ],
      },
    });

    expect(withGiantPointer.includes(giant)).toBe(false);
    expect(withGiantPointer.includes(`${giant.slice(0, 80)}...`)).toBe(true);
  });

  it('leaves a long non-name pointer string (e.g. a thread note) untouched (AC-7 safety)', () => {
    const note = 'N'.repeat(113);
    const withNote = renderReport({
      ontology: {
        ...ontology,
        findings: [
          {
            id: 3,
            title: 'PROCESS GAPS',
            detail: 'x',
            pointer: { hotfixNoTicket: [{ thread_ts: '1.1', note }] },
          },
        ],
      },
    });

    expect(withNote.includes(note)).toBe(true);
  });
});

/**
 * The marker `packages/cli/src/render.ts:102` writes, `/api/instances` serves and
 * `packages/studio/src/app/DetailPanel.tsx:127` prints. Spelled out here rather
 * than imported, so a change to any of those wordings fails on this line instead
 * of leaving a reader with four vocabularies for one fact (ONT-072 AC-4).
 */
const MARKER_PREFIX = '<UNRENDERABLE — ';

const unrenderable = ({ reason }: { reason: string }): string => `${MARKER_PREFIX}${reason}>`;

/** ONT-071's sentence for a key JSON would drop, verbatim. */
const ABSENT = 'undefined, which JSON drops key and all';

/** Where each roster column sits, so a test names a column rather than an index. */
const COLUMN = {
  accountId: 0,
  name: 1,
  active: 2,
  tickets: 3,
  storyPoints: 4,
  mix: 5,
  reopen: 6,
  reassign: 7,
  helpGiven: 8,
  helpReceived: 9,
  offHours: 10,
  cycle: 11,
} as const;

const conforming = ontology.employees[0]!;

/**
 * A row the emitter really can be handed, cast into the type it was declared to
 * have. That cast is the whole defect: `EmployeeMetric` (`types.ts:87`) says
 * every field is present and nothing on the way into `renderReport` checks it,
 * which is what already went wrong twice on the two surfaces reading these same
 * rows (#107, #109).
 */
const rowWith = ({ over }: { over: Record<string, unknown> }): EmployeeMetric =>
  ({ ...conforming, ...over }) as EmployeeMetric;

/** The same, with a key removed outright rather than set to `undefined`. */
const rowWithout = ({ key }: { key: string }): EmployeeMetric => {
  const row: Record<string, unknown> = { ...conforming };
  delete row[key];

  return row as unknown as EmployeeMetric;
};

/**
 * The roster line for a one-person report, split the way a markdown renderer
 * splits it: on pipes that are NOT escaped, delimiters dropped, each cell
 * unescaped back to the text the reader is shown.
 */
const cells = ({ employee }: { employee: unknown }): string[] => {
  const lines = renderReport({
    ontology: { ...ontology, employees: [employee] as EmployeeMetric[] },
  }).split('\n');
  const header = lines.findIndex((line) => line.startsWith('| accountId'));

  return lines[header + 2]!.split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
};

describe('renderRoster over a row that is not what it was declared to be', () => {
  it('gives every row the same cell count as the header, whatever it carries', () => {
    const header = 12;

    for (const employee of [
      conforming,
      rowWithout({ key: 'complexityMix' }),
      rowWith({ over: { displayName: 'Ann | 9 | 999 | yes' } }),
      rowWith({ over: { displayName: 'Ann\r\nA' } }),
      rowWith({ over: { displayName: null } }),
      rowWith({ over: { storyPointsTotal: Number.POSITIVE_INFINITY } }),
      null,
    ]) {
      expect(cells({ employee })).toHaveLength(header);
    }
  });

  it('names a missing complexityMix once and prints every other metric verbatim', () => {
    const row = cells({ employee: rowWithout({ key: 'complexityMix' }) });

    expect(row[COLUMN.mix]).toBe(unrenderable({ reason: ABSENT }));
    expect(row[COLUMN.name]).toBe('Ann A');
    expect(row[COLUMN.tickets]).toBe('3');
    expect(row[COLUMN.storyPoints]).toBe('8');
    expect(row[COLUMN.helpGiven]).toBe('2');
    expect(row[COLUMN.cycle]).toBe('1.2/1.4');
  });

  it('reads a key that is absent and a key that is present-and-undefined the same way', () => {
    expect(cells({ employee: rowWith({ over: { complexityMix: undefined } }) })[COLUMN.mix]).toBe(
      cells({ employee: rowWithout({ key: 'complexityMix' }) })[COLUMN.mix],
    );
  });

  it('names which part of the mix is missing, in one marker rather than three', () => {
    const row = cells({ employee: rowWith({ over: { complexityMix: { hi: 1, med: 1 } } }) });

    expect(row[COLUMN.mix]).toBe(unrenderable({ reason: `its lo is ${ABSENT}` }));
  });

  it('names a mix that is not an object at all', () => {
    expect(cells({ employee: rowWith({ over: { complexityMix: 'hi' } }) })[COLUMN.mix]).toBe(
      unrenderable({ reason: 'a string ("hi") where the row declares an object with hi/med/lo' }),
    );
    expect(cells({ employee: rowWith({ over: { complexityMix: null } }) })[COLUMN.mix]).toBe(
      unrenderable({ reason: 'null where the row declares an object with hi/med/lo' }),
    );
  });

  it('names a mix part that is present but not a number', () => {
    const row = cells({
      employee: rowWith({ over: { complexityMix: { hi: 1, med: 'two', lo: 3 } } }),
    });

    expect(row[COLUMN.mix]).toBe(
      unrenderable({ reason: 'its med is a string ("two") where the row declares a number' }),
    );
  });

  it('keeps a name that carries a pipe, escaped rather than spread across the columns', () => {
    const row = cells({ employee: rowWith({ over: { displayName: 'Ann | 9 | 999 | yes' } }) });

    expect(row[COLUMN.name]).toBe('Ann | 9 | 999 | yes');
    expect(row[COLUMN.tickets]).toBe('3');
    expect(row[COLUMN.storyPoints]).toBe('8');
  });

  it('keeps a name that carries a line break on one row', () => {
    const row = cells({ employee: rowWith({ over: { displayName: 'Ann\r\nA' } }) });

    expect(row[COLUMN.name]).toBe('Ann A');
    expect(row[COLUMN.active]).toBe('yes');
  });

  it('names a display name that is not a string', () => {
    expect(cells({ employee: rowWith({ over: { displayName: null } }) })[COLUMN.name]).toBe(
      unrenderable({ reason: 'null where the row declares a string' }),
    );
    expect(cells({ employee: rowWith({ over: { displayName: 7 } }) })[COLUMN.name]).toBe(
      unrenderable({ reason: 'the number 7 where the row declares a string' }),
    );
  });

  it('names an absent `active` instead of printing it as `no`', () => {
    expect(cells({ employee: rowWithout({ key: 'active' }) })[COLUMN.active]).toBe(
      unrenderable({ reason: ABSENT }),
    );
    expect(cells({ employee: rowWith({ over: { active: 1 } }) })[COLUMN.active]).toBe(
      unrenderable({ reason: 'the number 1 where the row declares a boolean' }),
    );
  });

  it('names a number JSON cannot carry, in the same words render.ts uses for it', () => {
    const row = cells({
      employee: rowWith({ over: { storyPointsTotal: Number.POSITIVE_INFINITY } }),
    });
    const { fields } = toRenderableValue({ value: { n: Number.POSITIVE_INFINITY }, path: '$' });

    expect(row[COLUMN.storyPoints]).toBe(unrenderable({ reason: 'the number Infinity' }));
    expect(row[COLUMN.storyPoints]).toBe(unrenderable({ reason: fields[0]!.reason }));
    expect(cells({ employee: rowWith({ over: { reopenRate: Number.NaN } }) })[COLUMN.reopen]).toBe(
      unrenderable({ reason: 'the number NaN' }),
    );
  });

  it('names a metric that is absent instead of printing the word `undefined`', () => {
    expect(cells({ employee: rowWithout({ key: 'medianCycleDaysFirstHalf' }) })[COLUMN.cycle]).toBe(
      `${unrenderable({ reason: ABSENT })}/1.4`,
    );
    expect(cells({ employee: rowWithout({ key: 'reassignmentsGiven' }) })[COLUMN.reassign]).toBe(
      `${unrenderable({ reason: ABSENT })}/n/a`,
    );
  });

  it('shows the literal "unavailable" as n/a on every metric column, not as a mismatch', () => {
    const row = cells({
      employee: rowWith({
        over: { medianCycleDaysFirstHalf: 'unavailable', ticketCount: 'unavailable' },
      }),
    });

    expect(row[COLUMN.cycle]).toBe('n/a/1.4');
    expect(row[COLUMN.tickets]).toBe('n/a');
  });

  it('survives a field that throws when it is read, and says so', () => {
    const hostile: Record<string, unknown> = { ...conforming };

    Object.defineProperty(hostile, 'displayName', {
      enumerable: true,
      get: () => {
        throw new Error('the datasource hung up');
      },
    });

    const row = cells({ employee: hostile });

    expect(row[COLUMN.name]).toBe(
      unrenderable({ reason: 'reading it threw: the datasource hung up' }),
    );
    expect(row[COLUMN.tickets]).toBe('3');
  });

  it('survives a row that refers back to itself', () => {
    const row: Record<string, unknown> = { ...conforming };
    row['self'] = row;

    expect(cells({ employee: row })[COLUMN.name]).toBe('Ann A');
  });

  it('prints a name that is literally the marker text as the string it is', () => {
    const forged = unrenderable({ reason: 'the number Infinity' });

    expect(cells({ employee: rowWith({ over: { displayName: forged } }) })[COLUMN.name]).toBe(
      forged,
    );
  });

  it('names every cell when the row is not a row at all', () => {
    const row = cells({ employee: null });

    expect(row[COLUMN.accountId]).toBe(
      unrenderable({ reason: 'null where the row declares an object' }),
    );
    expect(row[COLUMN.mix]).toBe(unrenderable({ reason: 'null where the row declares an object' }));
  });

  it('renders a conforming row byte-for-byte as it did before (ONT-075 AC-4)', () => {
    expect(cells({ employee: conforming }).join('|')).toBe(
      'acc_a|Ann A|yes|3|8|1/1/1|n/a|n/a/n/a|2|1|10|1.2/1.4',
    );
  });
});
