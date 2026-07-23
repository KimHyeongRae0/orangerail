import { describe, expect, it } from 'vitest';

import type { InstanceSnapshot } from '../snapshot/instances';
import { buildInstanceGraph } from './instanceGraph';
import { edgeWidth, personRadius } from './instanceModel';

const snapshot: InstanceSnapshot = {
  employees: [
    {
      accountId: 'acc_a',
      displayName: 'Ann',
      active: true,
      ticketCount: 1,
      storyPointsTotal: 100,
      complexityMix: { hi: 1, med: 0, lo: 0 },
      medianCycleDaysFirstHalf: 1,
      medianCycleDaysSecondHalf: 1,
      reopenRate: 1,
      reassignmentsGiven: 0,
      reassignmentsReceived: 0,
      helpGiven: 2,
      helpReceived: 0,
      weekendOffHoursShare: 0,
    },
    {
      accountId: 'acc_b',
      displayName: 'Bob',
      active: true,
      ticketCount: 1,
      storyPointsTotal: 4,
      complexityMix: { hi: 0, med: 0, lo: 1 },
      medianCycleDaysFirstHalf: 1,
      medianCycleDaysSecondHalf: 1,
      reopenRate: 1,
      reassignmentsGiven: 0,
      reassignmentsReceived: 0,
      helpGiven: 0,
      helpReceived: 2,
      weekendOffHoursShare: 0,
    },
  ],
  services: [
    { id: 'svc1', name: 'Service One', ticketCount: 5, distinctAssignees: 2, busFactor: 2 },
  ],
  teams: [{ id: 't1', name: 'Team One', project: 'T1' }],
  incidents: [],
  edges: {
    helps: [{ from: 'acc_a', to: 'acc_b', weight: 3 }],
    works_on: [{ from: 'acc_a', to: 'svc1', weight: 2 }],
    member_of: [{ from: 'acc_a', to: 't1', weight: 1 }],
  },
};

const build = ({ showWorksOn }: { showWorksOn: boolean }) =>
  buildInstanceGraph({
    snapshot,
    positions: new Map(),
    showWorksOn,
    activeAccountId: null,
  });

describe('buildInstanceGraph (plan section 3.3)', () => {
  it('emits only instance node/edge types (no db type leakage)', () => {
    const { nodes, edges } = build({ showWorksOn: true });

    expect(new Set(nodes.map((n) => n.type))).toEqual(new Set(['person', 'service']));
    expect(new Set(edges.map((e) => e.type))).toEqual(new Set(['helps', 'worksOn', 'memberOf']));
  });

  it('renders every person + service + team node', () => {
    const { nodes } = build({ showWorksOn: true });

    expect(nodes.filter((n) => n.type === 'person').length).toBe(2);
    // Services and the team are both place nodes (type 'service').
    expect(nodes.filter((n) => n.type === 'service').length).toBe(2);
  });

  it('adds/removes exactly the works_on edge set on toggle; helps + member_of stay', () => {
    const on = build({ showWorksOn: true }).edges;
    const off = build({ showWorksOn: false }).edges;

    expect(on.length - off.length).toBe(snapshot.edges.works_on.length);
    expect(off.filter((e) => e.type === 'worksOn').length).toBe(0);
    expect(off.filter((e) => e.type === 'helps').length).toBe(snapshot.edges.helps.length);
    expect(off.filter((e) => e.type === 'memberOf').length).toBe(snapshot.edges.member_of.length);
  });

  it('sizes person nodes monotonically by story points, marks the active person', () => {
    const active = buildInstanceGraph({
      snapshot,
      positions: new Map(),
      showWorksOn: true,
      activeAccountId: 'acc_a',
    }).nodes;

    const ann = active.find((n) => n.id === 'person:acc_a');
    const bob = active.find((n) => n.id === 'person:acc_b');

    expect((ann?.data as { radius: number }).radius).toBeGreaterThan(
      (bob?.data as { radius: number }).radius,
    );
    expect((ann?.data as { active: boolean }).active).toBe(true);
    expect((bob?.data as { active: boolean }).active).toBe(false);
  });
});

describe('personRadius / edgeWidth (plan section 3.3 — clamps)', () => {
  it('is monotonic and clamped for radius', () => {
    expect(personRadius({ storyPointsTotal: 0 })).toBeLessThan(
      personRadius({ storyPointsTotal: 50 }),
    );
    expect(personRadius({ storyPointsTotal: 10_000 })).toBeLessThanOrEqual(64);
    expect(personRadius({ storyPointsTotal: 0 })).toBeGreaterThanOrEqual(26);
  });

  it('is monotonic and clamped for edge width', () => {
    expect(edgeWidth({ weight: 1 })).toBeLessThan(edgeWidth({ weight: 3 }));
    expect(edgeWidth({ weight: 1 })).toBeGreaterThanOrEqual(1);
    expect(edgeWidth({ weight: 1000 })).toBeLessThanOrEqual(6);
  });
});
