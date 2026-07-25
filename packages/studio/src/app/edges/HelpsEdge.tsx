import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

import { edgeWidth, type HelpsEdge as HelpsEdgeType } from '../instanceModel';

/**
 * A `helps` edge: a directed, weight-scaled collaboration link (plan section
 * 3.3). It carries the shared triangular arrowhead at its end (direction =
 * helper → helped) and a stroke width computed by the monotonic, max-clamped
 * `edgeWidth` so a heavy help relationship reads as a thicker edge while a
 * weight-1 edge stays visible and a very high weight stays readable. Uses React
 * Flow's own bezier path math; `interactionWidth={0}` keeps the view-only
 * surface un-clickable at the edge (matching `LinkEdge`).
 */
export const HelpsEdge = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<HelpsEdgeType>) => {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const width = edgeWidth({ weight: data?.weight ?? 1 });
  const focused = data?.focused === true;
  const dim = data?.dim === true;

  // Calm at rest (grey, low opacity) so the resting graph reads as a quiet
  // field; strong on focus (accent green, near-opaque, thicker) so the hovered
  // or selected person's ties pop — mirroring the DB view's figure/ground.
  const stroke = focused ? 'var(--edge-highlighted)' : 'var(--edge-resting)';
  const opacity = dim ? 0.06 : focused ? 0.95 : 0.4;
  const strokeWidth = focused ? width + 0.75 : width;

  return (
    <BaseEdge
      path={path}
      style={{ stroke, strokeWidth, opacity }}
      markerEnd="url(#instance-arrow-helps)"
      interactionWidth={0}
    />
  );
};
