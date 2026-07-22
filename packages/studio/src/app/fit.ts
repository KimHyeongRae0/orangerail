import { getNodesBounds, type ReactFlowInstance, type Rect } from '@xyflow/react';

import type { StudioEdge, StudioNode } from './model';

/** Fit padding (fraction of the viewport left as margin), shared by every fit. */
const FIT_PADDING = 0.2;

type Instance = ReactFlowInstance<StudioNode, StudioEdge>;

/**
 * Union a base rect with additional rects, returning the smallest rect that
 * encloses them all. Pure — no DOM, no React Flow — this is the testable core
 * of the fit-bounds fix. When `extra` is empty the base rect is returned
 * unchanged.
 */
export const unionBounds = ({ base, extra }: { base: Rect; extra: Rect[] }): Rect => {
  let minX = base.x;
  let minY = base.y;
  let maxX = base.x + base.width;
  let maxY = base.y + base.height;

  for (const rect of extra) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/**
 * Measure every action pill's bounding rect in flow coordinates. Self-loop
 * action pills are rendered through `EdgeLabelRenderer`, so React Flow's own
 * node-bounds computation — and therefore `fitView` — never sees them and
 * clips them at the viewport edge. We read each pill's live DOM rect and
 * convert its corners from screen space into flow space via the instance's
 * `screenToFlowPosition`, so the extent is measured rather than assumed. This
 * generalizes to any graph: nothing here is tuned to a particular fixture.
 */
const measurePillRects = ({ rf }: { rf: Instance }): Rect[] => {
  const rects: Rect[] = [];
  const pills = document.querySelectorAll<HTMLElement>('[data-testid="action-node"]');

  for (const pill of Array.from(pills)) {
    const box = pill.getBoundingClientRect();

    if (box.width === 0 && box.height === 0) {
      continue;
    }

    const topLeft = rf.screenToFlowPosition({ x: box.left, y: box.top });
    const bottomRight = rf.screenToFlowPosition({ x: box.right, y: box.bottom });

    rects.push({
      x: Math.min(topLeft.x, bottomRight.x),
      y: Math.min(topLeft.y, bottomRight.y),
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y),
    });
  }

  return rects;
};

/**
 * Fit the viewport so every rendered element is fully inside it: object cards,
 * free-standing action pill nodes, and the self-loop action pills that
 * `fitView` ignores (defect 1). Computes the node bounds, expands them by the
 * measured pill rects, and calls `fitBounds`. Falls back to a plain `fitView`
 * only when there are no nodes at all. Used by both the initial load fit and
 * the toolbar fit button so the two paths never diverge.
 */
export const fitAll = ({ rf, duration }: { rf: Instance; duration: number }): void => {
  const nodes = rf.getNodes();

  if (nodes.length === 0) {
    void rf.fitView({ padding: FIT_PADDING, duration });
    return;
  }

  const bounds = unionBounds({ base: getNodesBounds(nodes), extra: measurePillRects({ rf }) });

  void rf.fitBounds(bounds, { padding: FIT_PADDING, duration });
};
