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
  const focused = data?.focused === true;
  const dim = data?.dim === true;

  // Same calm-at-rest / strong-on-focus treatment as the `helps` edge: a resting
  // person→place tie is a quiet grey line; a focused one lights accent green and
  // carries the flow-particle animation.
  const restingOpacity = isMember ? 0.3 : 0.4;
  const stroke = focused ? 'var(--edge-highlighted)' : 'var(--edge-resting)';
  const opacity = dim ? 0.06 : focused ? 0.95 : restingOpacity;
  const strokeWidth = focused ? width + 0.75 : width;

  return (
    <BaseEdge
      path={path}
      style={{
        stroke,
        strokeWidth,
        opacity,
        strokeDasharray: isMember ? '4 4' : undefined,
      }}
      markerEnd="url(#instance-arrow-place)"
      interactionWidth={0}
    />
  );
};
