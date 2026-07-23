import { describe, expect, it } from 'vitest';

import type { InstanceSnapshot } from '../snapshot/instances';
import { computeInstanceLayout } from './instanceLayout';

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
