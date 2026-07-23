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
});
