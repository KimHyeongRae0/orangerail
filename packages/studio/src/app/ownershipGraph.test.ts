import { describe, expect, it } from 'vitest';

import type { InstanceSnapshot } from '../snapshot/instances';
import { buildOwnershipGraph } from './ownershipGraph';
import { computeOwnershipLayout } from './ownershipLayout';

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

// 'lonely' works on nothing; 'idle' is a service nobody works on (edge cases).
const snapshot: InstanceSnapshot = {
  employees: [
    person({ accountId: 'a' }),
    person({ accountId: 'b' }),
    person({ accountId: 'lonely' }),
  ],
  services: [
    { id: 's1', name: 'S1', ticketCount: 1, distinctAssignees: 1, busFactor: 1 },
    { id: 'idle', name: 'Idle', ticketCount: 0, distinctAssignees: 0, busFactor: 0 },
  ],
  teams: [{ id: 't1', name: 'T1', project: 'T1' }],
  incidents: [],
  edges: {
    helps: [{ from: 'a', to: 'b', weight: 1 }],
    works_on: [
      { from: 'a', to: 's1', weight: 2 },
      { from: 'b', to: 's1', weight: 1 },
    ],
    member_of: [{ from: 'a', to: 't1', weight: 1 }],
  },
};

describe('buildOwnershipGraph (plan Decision 4, AC-4)', () => {
  it('emits works_on edges only — no helps, no member_of, no team node', () => {
    const { nodes, edges } = buildOwnershipGraph({ snapshot, positions: new Map() });

    expect(new Set(edges.map((e) => e.type))).toEqual(new Set(['worksOn']));
    expect(edges.length).toBe(snapshot.edges.works_on.length);
    // Only person + service nodes (no team place node in this view).
    expect(nodes.filter((n) => n.type === 'person').length).toBe(3);
    expect(nodes.filter((n) => n.type === 'service').length).toBe(2);
  });

  it('keeps isolated people and idle services present (edge case)', () => {
    const { nodes } = buildOwnershipGraph({ snapshot, positions: new Map() });

    expect(nodes.some((n) => n.id === 'person:lonely')).toBe(true);
    expect(nodes.some((n) => n.id === 'svc:idle')).toBe(true);
  });
});

describe('computeOwnershipLayout (plan Decision 4 — bipartite partitions)', () => {
  it('places people and services in two disjoint x-ranges', async () => {
    const positions = await computeOwnershipLayout({ snapshot });

    const widthOf = ({ id }: { id: string }) => (id.startsWith('person:') ? 36 : 160);
    const centreX = ({ id }: { id: string }) => (positions.get(id)?.x ?? 0) + widthOf({ id }) / 2;

    const personCentres = ['person:a', 'person:b', 'person:lonely'].map((id) => centreX({ id }));
    const serviceCentres = ['svc:s1', 'svc:idle'].map((id) => centreX({ id }));

    const personMaxX = Math.max(...personCentres);
    const serviceMinX = Math.min(...serviceCentres);
    const personMinX = Math.min(...personCentres);
    const serviceMaxX = Math.max(...serviceCentres);

    expect(personMaxX < serviceMinX || serviceMaxX < personMinX).toBe(true);
  });

  it('returns an empty map for an empty snapshot', async () => {
    const positions = await computeOwnershipLayout({
      snapshot: {
        employees: [],
        services: [],
        teams: [],
        incidents: [],
        edges: { helps: [], works_on: [], member_of: [] },
      },
    });

    expect(positions.size).toBe(0);
  });
});
