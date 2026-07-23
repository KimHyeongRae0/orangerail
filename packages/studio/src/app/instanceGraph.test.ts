import { describe, expect, it } from 'vitest';

import type { InstanceSnapshot } from '../snapshot/instances';
import { buildInstanceGraph, filterByWeight } from './instanceGraph';
import { edgeWidth, personRadius, type Relationship } from './instanceModel';

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

const build = ({
  relationship = 'helps',
  weightThreshold = 1,
  activeAccountId = null,
}: {
  relationship?: Relationship;
  weightThreshold?: number;
  activeAccountId?: string | null;
}) =>
  buildInstanceGraph({
    snapshot,
    positions: new Map(),
    relationship,
    weightThreshold,
    activeAccountId,
  });

describe('buildInstanceGraph (plan section 3.2)', () => {
  it('emits only instance node/edge types (no db type leakage)', () => {
    const { nodes, edges } = build({ relationship: 'helps' });

    expect(new Set(nodes.map((n) => n.type))).toEqual(new Set(['person', 'service']));
    expect(new Set(edges.map((e) => e.type))).toEqual(new Set(['helps']));
  });

  it('renders every person + service + team node regardless of relationship', () => {
    const { nodes } = build({ relationship: 'works_on' });

    expect(nodes.filter((n) => n.type === 'person').length).toBe(2);
    // Services and the team are both place nodes (type 'service').
    expect(nodes.filter((n) => n.type === 'service').length).toBe(2);
  });

  it('emits ONLY the active relationship family (single-select, plan 3.2c)', () => {
    const helps = build({ relationship: 'helps' }).edges;
    const worksOn = build({ relationship: 'works_on' }).edges;
    const memberOf = build({ relationship: 'member_of' }).edges;

    expect(helps.map((e) => e.type)).toEqual(['helps']);
    expect(helps.length).toBe(snapshot.edges.helps.length);

    expect(worksOn.map((e) => e.type)).toEqual(['worksOn']);
    expect(worksOn.length).toBe(snapshot.edges.works_on.length);

    expect(memberOf.map((e) => e.type)).toEqual(['memberOf']);
    expect(memberOf.length).toBe(snapshot.edges.member_of.length);
  });

  it('drops edges below the weight threshold (plan 3.2d — boundary)', () => {
    // The single helps edge has weight 3: kept at threshold 3, dropped at 4.
    expect(build({ relationship: 'helps', weightThreshold: 3 }).edges.length).toBe(1);
    expect(build({ relationship: 'helps', weightThreshold: 4 }).edges.length).toBe(0);
  });

  it('sizes person nodes monotonically by story points, marks the active person', () => {
    const active = build({ relationship: 'helps', activeAccountId: 'acc_a' }).nodes;

    const ann = active.find((n) => n.id === 'person:acc_a');
    const bob = active.find((n) => n.id === 'person:acc_b');

    expect((ann?.data as { radius: number }).radius).toBeGreaterThan(
      (bob?.data as { radius: number }).radius,
    );
    expect((ann?.data as { active: boolean }).active).toBe(true);
    expect((bob?.data as { active: boolean }).active).toBe(false);
  });

  it('focus marks non-ego nodes dim and overlays the ego works_on (plan 3.2e)', () => {
    const { nodes, edges } = build({ relationship: 'helps', activeAccountId: 'acc_a' });

    const dimOf = ({ id }: { id: string }) =>
      (nodes.find((n) => n.id === id)?.data as { dim?: boolean }).dim === true;

    // Ego (acc_a), its helps neighbour (acc_b), and its works_on service (svc1)
    // stay undimmed; the unrelated team hub is dimmed.
    expect(dimOf({ id: 'person:acc_a' })).toBe(false);
    expect(dimOf({ id: 'person:acc_b' })).toBe(false);
    expect(dimOf({ id: 'svc:svc1' })).toBe(false);
    expect(dimOf({ id: 'team:t1' })).toBe(true);

    // The ego works_on edge is overlaid (undimmed) even under the helps family;
    // focus never leaks a db type — only helps + worksOn appear.
    expect(edges.some((e) => e.type === 'worksOn' && e.data?.dim === false)).toBe(true);
    expect(new Set(edges.map((e) => e.type))).toEqual(new Set(['helps', 'worksOn']));
  });

  it('applies no dim in overview mode (no selection)', () => {
    const { nodes, edges } = build({ relationship: 'helps' });

    expect(nodes.every((n) => (n.data as { dim?: boolean }).dim !== true)).toBe(true);
    expect(edges.every((e) => e.data?.dim !== true)).toBe(true);
  });
});

describe('filterByWeight (plan section 3.2d — boundary)', () => {
  const edges = [
    { from: 'a', to: 'b', weight: 1 },
    { from: 'a', to: 'c', weight: 2 },
    { from: 'a', to: 'd', weight: 3 },
  ];

  it('keeps weight == threshold and drops weight < threshold', () => {
    expect(filterByWeight({ edges, threshold: 2 }).map((e) => e.weight)).toEqual([2, 3]);
  });

  it('passes everything through at threshold 1 and empties at a high threshold', () => {
    expect(filterByWeight({ edges, threshold: 1 }).length).toBe(3);
    expect(filterByWeight({ edges, threshold: 99 }).length).toBe(0);
  });

  it('is a passthrough for an empty edge set', () => {
    expect(filterByWeight({ edges: [], threshold: 1 })).toEqual([]);
  });
});

describe('personRadius / edgeWidth (plan section 3.2a — clamps)', () => {
  it('is monotonic and clamped for radius to the lowered 18/40 bounds', () => {
    expect(personRadius({ storyPointsTotal: 0 })).toBeLessThan(
      personRadius({ storyPointsTotal: 50 }),
    );
    expect(personRadius({ storyPointsTotal: 10_000 })).toBeLessThanOrEqual(40);
    expect(personRadius({ storyPointsTotal: 0 })).toBeGreaterThanOrEqual(18);
  });

  it('falls back to the min radius for a non-finite metric (never a crash)', () => {
    expect(personRadius({ storyPointsTotal: Number.NaN })).toBeGreaterThanOrEqual(18);
    expect(personRadius({ storyPointsTotal: Number.NaN })).toBeLessThanOrEqual(40);
  });

  it('is monotonic and clamped for edge width', () => {
    expect(edgeWidth({ weight: 1 })).toBeLessThan(edgeWidth({ weight: 3 }));
    expect(edgeWidth({ weight: 1 })).toBeGreaterThanOrEqual(1);
    expect(edgeWidth({ weight: 1000 })).toBeLessThanOrEqual(6);
  });
});
