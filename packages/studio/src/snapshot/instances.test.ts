import { describe, expect, it } from 'vitest';

import { buildInstanceSnapshot, type InstanceEmployee } from './instances';

const employee = ({
  accountId,
  storyPointsTotal = 10,
}: {
  accountId: string;
  storyPointsTotal?: number;
}): InstanceEmployee => ({
  accountId,
  displayName: `Name ${accountId}`,
  active: true,
  ticketCount: 1,
  storyPointsTotal,
  complexityMix: { hi: 0, med: 0, lo: 1 },
  medianCycleDaysFirstHalf: 1,
  medianCycleDaysSecondHalf: 1,
  reopenRate: 'unavailable',
  reassignmentsGiven: 0,
  reassignmentsReceived: 0,
  helpGiven: 0,
  helpReceived: 0,
  weekendOffHoursShare: 0,
});

describe('buildInstanceSnapshot (plan section 3.1)', () => {
  it('sorts people by accountId and edges by (from, to), deterministically', () => {
    const snapshot = buildInstanceSnapshot({
      employees: [employee({ accountId: 'c' }), employee({ accountId: 'a' })],
      services: [
        { id: 'z', name: 'Z', ticketCount: 0, distinctAssignees: 0, busFactor: 0 },
        { id: 'a', name: 'A', ticketCount: 0, distinctAssignees: 0, busFactor: 0 },
      ],
      teams: [],
      incidents: [],
      helps: [
        { from: 'c', to: 'a', weight: 2 },
        { from: 'a', to: 'b', weight: 1 },
      ],
      worksOn: [],
      memberOf: [],
    });

    expect(snapshot.employees.map((e) => e.accountId)).toEqual(['a', 'c']);
    expect(snapshot.services.map((s) => s.id)).toEqual(['a', 'z']);
    expect(snapshot.edges.helps.map((e) => `${e.from}->${e.to}`)).toEqual(['a->b', 'c->a']);

    const again = buildInstanceSnapshot({
      employees: [employee({ accountId: 'a' }), employee({ accountId: 'c' })],
      services: [],
      teams: [],
      incidents: [],
      helps: [
        { from: 'a', to: 'b', weight: 1 },
        { from: 'c', to: 'a', weight: 2 },
      ],
      worksOn: [],
      memberOf: [],
    });

    expect(JSON.stringify(again.edges.helps)).toBe(JSON.stringify(snapshot.edges.helps));
  });

  it('passes the literal "unavailable" through verbatim', () => {
    const snapshot = buildInstanceSnapshot({
      employees: [employee({ accountId: 'a' })],
      services: [],
      teams: [],
      incidents: [],
      helps: [],
      worksOn: [],
      memberOf: [],
    });

    expect(snapshot.employees[0]?.reopenRate).toBe('unavailable');
  });

  it('defaults a missing edge weight to 1 and drops malformed rows', () => {
    const snapshot = buildInstanceSnapshot({
      employees: [],
      services: [],
      teams: [],
      incidents: [],
      helps: [{ from: 'a', to: 'b' }, { from: 'a' }, null, { to: 'b' }],
      worksOn: [],
      memberOf: [],
    });

    expect(snapshot.edges.helps).toEqual([{ from: 'a', to: 'b', weight: 1 }]);
  });

  it('produces an empty snapshot from empty inputs', () => {
    const snapshot = buildInstanceSnapshot({
      employees: [],
      services: [],
      teams: [],
      incidents: [],
      helps: [],
      worksOn: [],
      memberOf: [],
    });

    expect(snapshot).toEqual({
      employees: [],
      services: [],
      teams: [],
      incidents: [],
      edges: { helps: [], works_on: [], member_of: [] },
    });
  });
});
