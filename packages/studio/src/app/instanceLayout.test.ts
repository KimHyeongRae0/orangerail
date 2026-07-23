import { describe, expect, it } from 'vitest';

import type { InstanceSnapshot } from '../snapshot/instances';
import { computeInstanceLayout, separateNodes } from './instanceLayout';
import { personRadius } from './instanceModel';

/** Count overlapping box pairs (>1px on both axes), mirroring the e2e check. */
const overlapCount = ({
  positions,
  sizes,
}: {
  positions: Map<string, { x: number; y: number }>;
  sizes: Map<string, { width: number; height: number }>;
}): number => {
  const ids = [...positions.keys()];
  let overlaps = 0;

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = positions.get(ids[i] as string) as { x: number; y: number };
      const b = positions.get(ids[j] as string) as { x: number; y: number };
      const sa = sizes.get(ids[i] as string) as { width: number; height: number };
      const sb = sizes.get(ids[j] as string) as { width: number; height: number };
      const ox = Math.min(a.x + sa.width, b.x + sb.width) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + sa.height, b.y + sb.height) - Math.max(a.y, b.y);

      if (ox > 1 && oy > 1) {
        overlaps += 1;
      }
    }
  }

  return overlaps;
};

const person = ({ accountId }: { accountId: string }) => ({
  accountId,
  displayName: accountId,
  active: true,
  ticketCount: 1,
  storyPointsTotal: 20,
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

describe('computeInstanceLayout (plan Decision 4 — stress layout)', () => {
  it('places every node at a distinct position, including an isolated node', async () => {
    const snapshot: InstanceSnapshot = {
      employees: [
        person({ accountId: 'a' }),
        person({ accountId: 'b' }),
        person({ accountId: 'c' }),
        // 'c' participates in no edge — it must still be placed, never dropped.
      ],
      services: [],
      teams: [],
      incidents: [],
      edges: {
        helps: [{ from: 'a', to: 'b', weight: 1 }],
        works_on: [],
        member_of: [],
      },
    };

    const positions = await computeInstanceLayout({ snapshot });

    expect(positions.size).toBe(3);
    expect(positions.has('person:c')).toBe(true);

    const distinct = new Set([...positions.values()].map((p) => `${p.x},${p.y}`));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('leaves no overlapping node boxes after the de-overlap pass (AC-2)', async () => {
    const snapshot: InstanceSnapshot = {
      employees: [
        person({ accountId: 'a' }),
        person({ accountId: 'b' }),
        person({ accountId: 'c' }),
        person({ accountId: 'd' }),
      ],
      services: [
        { id: 's1', name: 'S1', ticketCount: 1, distinctAssignees: 1, busFactor: 1 },
        { id: 's2', name: 'S2', ticketCount: 1, distinctAssignees: 1, busFactor: 1 },
      ],
      teams: [{ id: 't1', name: 'T1', project: 'T1' }],
      incidents: [],
      edges: {
        helps: [
          { from: 'a', to: 'b', weight: 1 },
          { from: 'b', to: 'c', weight: 1 },
          { from: 'c', to: 'd', weight: 1 },
        ],
        works_on: [{ from: 'a', to: 's1', weight: 1 }],
        member_of: [{ from: 'a', to: 't1', weight: 1 }],
      },
    };

    const positions = await computeInstanceLayout({ snapshot });
    // The sizes the layout separates against (person diameter, place 200x80).
    const diameter = personRadius({ storyPointsTotal: 20 }) * 2;
    const sizes = new Map<string, { width: number; height: number }>();
    for (const e of snapshot.employees) {
      sizes.set(`person:${e.accountId}`, { width: diameter, height: diameter });
    }
    sizes.set('svc:s1', { width: 200, height: 80 });
    sizes.set('svc:s2', { width: 200, height: 80 });
    sizes.set('team:t1', { width: 200, height: 80 });

    expect(overlapCount({ positions, sizes })).toBe(0);
  });

  it('separateNodes is deterministic and removes overlap (pure)', () => {
    const positions = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 5, y: 5 }],
      ['c', { x: 2, y: 3 }],
    ]);
    const sizes = new Map([
      ['a', { width: 100, height: 100 }],
      ['b', { width: 100, height: 100 }],
      ['c', { width: 100, height: 100 }],
    ]);

    const first = separateNodes({ positions, sizes });
    const second = separateNodes({ positions, sizes });

    expect(overlapCount({ positions: first, sizes })).toBe(0);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('returns an empty map for an empty snapshot', async () => {
    const positions = await computeInstanceLayout({
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
