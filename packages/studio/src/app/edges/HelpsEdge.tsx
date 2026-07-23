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

  return (
    <BaseEdge
      path={path}
      style={{ stroke: 'var(--primary-accent)', strokeWidth: width, opacity: 0.75 }}
      markerEnd="url(#instance-arrow-helps)"
      interactionWidth={0}
    />
  );
};
