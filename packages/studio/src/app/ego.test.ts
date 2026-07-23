import { describe, expect, it } from 'vitest';

import type { InstanceSnapshot } from '../snapshot/instances';
import { computeEgoSet } from './ego';

const person = ({ accountId }: { accountId: string }) => ({
  accountId,
  displayName: accountId,
  active: true,
  ticketCount: 1,
  storyPointsTotal: 10,
  complexityMix: { hi: 0, med: 0, lo: 1 },
  medianCycleDaysFirstHalf: 1 as const,
  medianCycleDaysSecondHalf: 1 as const,
  reopenRate: 1 as const,
  reassignmentsGiven: 0 as const,
  reassignmentsReceived: 0 as const,
  helpGiven: 0,
  helpReceived: 0,
  weekendOffHoursShare: 0 as const,
});

const snapshot: InstanceSnapshot = {
  employees: [person({ accountId: 'a' }), person({ accountId: 'b' }), person({ accountId: 'z' })],
  services: [{ id: 's1', name: 'S1', ticketCount: 1, distinctAssignees: 1, busFactor: 1 }],
  teams: [{ id: 't1', name: 'T1', project: 'T1' }],
  incidents: [],
  edges: {
    helps: [
      { from: 'a', to: 'b', weight: 2 },
      { from: 'z', to: 'a', weight: 1 },
    ],
    works_on: [{ from: 'a', to: 's1', weight: 1 }],
    member_of: [{ from: 'a', to: 't1', weight: 1 }],
  },
};

describe('computeEgoSet (plan section 3.2e)', () => {
  it('helps: ego + in/out helps neighbours + works_on services', () => {
    const ego = computeEgoSet({ snapshot, accountId: 'a', relationship: 'helps' });

    expect(ego.nodeIds).toEqual(new Set(['person:a', 'person:b', 'person:z', 'svc:s1']));
    expect(ego.edgeIds.has('helps:a->b')).toBe(true);
    expect(ego.edgeIds.has('helps:z->a')).toBe(true);
    expect(ego.edgeIds.has('works_on:a->s1')).toBe(true);
  });

  it('works_on: keeps only the ego and its services (no helps neighbours)', () => {
    const ego = computeEgoSet({ snapshot, accountId: 'a', relationship: 'works_on' });

    expect(ego.nodeIds).toEqual(new Set(['person:a', 'svc:s1']));
    expect(ego.nodeIds.has('person:b')).toBe(false);
  });

  it('member_of: keeps only the ego and its team(s)', () => {
    const ego = computeEgoSet({ snapshot, accountId: 'a', relationship: 'member_of' });

    expect(ego.nodeIds).toEqual(new Set(['person:a', 'team:t1']));
  });

  it('an isolated person resolves to just itself', () => {
    const ego = computeEgoSet({ snapshot, accountId: 'b', relationship: 'works_on' });

    expect(ego.nodeIds).toEqual(new Set(['person:b']));
    expect(ego.edgeIds.size).toBe(0);
  });

  it('an unknown accountId resolves to the empty set', () => {
    const ego = computeEgoSet({ snapshot, accountId: 'ghost', relationship: 'helps' });

    expect(ego.nodeIds.size).toBe(0);
    expect(ego.edgeIds.size).toBe(0);
  });
});
