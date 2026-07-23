import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

import { edgeWidth, type WorksOnEdge as WorksOnEdgeType } from '../instanceModel';

/**
 * A person → place edge (plan section 3.3). One component serves both variants:
 * `worksOn` (person → service, weight-scaled, toggleable in the toolbar) and
 * `memberOf` (person → team, a light always-on structural line). Both are
 * directed with the shared place arrowhead; the `memberOf` variant renders
 * thinner and dimmer so the structural membership stays visually subordinate to
 * the collaboration graph. Uses React Flow's own bezier path math.
 */
export const WorksOnEdge = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<WorksOnEdgeType>) => {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const isMember = data?.variant === 'memberOf';
  const width = isMember ? 1 : edgeWidth({ weight: data?.weight ?? 1 });

  return (
    <BaseEdge
      path={path}
      style={{
        stroke: 'var(--edge-resting)',
        strokeWidth: width,
        opacity: isMember ? 0.4 : 0.7,
        strokeDasharray: isMember ? '4 4' : undefined,
      }}
      markerEnd="url(#instance-arrow-place)"
      interactionWidth={0}
    />
  );
};
