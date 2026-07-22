import { describe, expect, it } from 'vitest';

import { unionBounds } from './fit';

/**
 * Unit coverage for the pure core of the fit-bounds fix (defect 1). The DOM /
 * React Flow glue (`measurePillRects`, `fitAll`) is exercised end to end by the
 * ONT-005 e2e; `unionBounds` is the piece worth isolating because it decides
 * whether a clipped self-loop pill gets pulled back into view.
 */
describe('unionBounds', () => {
  it('returns the base rect unchanged when there is nothing to add', () => {
    const base = { x: 0, y: 0, width: 100, height: 50 };

    expect(unionBounds({ base, extra: [] })).toEqual(base);
  });

  it('expands to enclose a pill extending past the base right edge', () => {
    const base = { x: 0, y: 0, width: 100, height: 50 };
    const pill = { x: 120, y: 10, width: 40, height: 20 };

    expect(unionBounds({ base, extra: [pill] })).toEqual({ x: 0, y: 0, width: 160, height: 50 });
  });

  it('encloses rects on every side, including negative offsets', () => {
    const base = { x: 0, y: 0, width: 100, height: 100 };
    const extra = [
      { x: -20, y: -10, width: 10, height: 10 },
      { x: 150, y: 90, width: 30, height: 40 },
    ];

    expect(unionBounds({ base, extra })).toEqual({ x: -20, y: -10, width: 200, height: 140 });
  });
});
