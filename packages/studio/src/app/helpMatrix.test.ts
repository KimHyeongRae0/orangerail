import { describe, expect, it } from 'vitest';

import type { InstanceSnapshot } from '../snapshot/instances';
import { buildHelpMatrix, cellKey } from './helpMatrix';

const person = ({ accountId, displayName }: { accountId: string; displayName: string }) => ({
  accountId,
  displayName,
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

// 'hub' helps three people; 'iso' helps no one and is helped by no one.
const snapshot: InstanceSnapshot = {
  employees: [
    person({ accountId: 'hub', displayName: 'Hub' }),
    person({ accountId: 'p1', displayName: 'P1' }),
    person({ accountId: 'p2', displayName: 'P2' }),
    person({ accountId: 'p3', displayName: 'P3' }),
    person({ accountId: 'iso', displayName: 'Iso' }),
  ],
  services: [],
  teams: [],
  incidents: [],
  edges: {
    helps: [
      { from: 'hub', to: 'p1', weight: 3 },
      { from: 'hub', to: 'p2', weight: 1 },
      { from: 'hub', to: 'p3', weight: 2 },
      { from: 'p1', to: 'p2', weight: 1 },
    ],
    works_on: [],
    member_of: [],
  },
};

describe('buildHelpMatrix (plan Decision 3, AC-3)', () => {
  it('orders by total help degree desc, accountId asc tiebreak, hub first', () => {
    const model = buildHelpMatrix({ snapshot });

    expect(model.order[0]).toBe('hub');
    // 'iso' has zero degree, so it sorts last.
    expect(model.order[model.order.length - 1]).toBe('iso');
  });

  it('records the raw cell weight for a (from, to) help pair', () => {
    const model = buildHelpMatrix({ snapshot });

    expect(model.weights.get(cellKey({ from: 'hub', to: 'p1' }))).toBe(3);
    expect(model.weights.get(cellKey({ from: 'hub', to: 'p2' }))).toBe(1);
    expect(model.weights.get(cellKey({ from: 'iso', to: 'p1' }))).toBeUndefined();
    expect(model.maxWeight).toBe(3);
  });

  it('keeps an isolated person as an empty row/column (present, no weights)', () => {
    const model = buildHelpMatrix({ snapshot });

    expect(model.order).toContain('iso');
    expect(model.rowTotals.get('iso')).toBe(0);
    expect(model.colTotals.get('iso')).toBe(0);
  });

  it('is deterministic (same snapshot -> byte-identical order)', () => {
    const a = buildHelpMatrix({ snapshot });
    const b = buildHelpMatrix({ snapshot });

    expect(a.order).toEqual(b.order);
  });

  it('exposes no composite score / ranking field (honesty)', () => {
    const model = buildHelpMatrix({ snapshot });

    expect(Object.keys(model)).toEqual(
      expect.arrayContaining(['order', 'labels', 'weights', 'rowTotals', 'colTotals', 'maxWeight']),
    );
    expect('score' in model).toBe(false);
    expect('rank' in model).toBe(false);
  });
});
