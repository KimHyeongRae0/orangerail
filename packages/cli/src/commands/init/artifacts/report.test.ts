import { describe, expect, it } from 'vitest';

import { renderReport } from './report';
import type { ExtractedOntology } from './types';

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
