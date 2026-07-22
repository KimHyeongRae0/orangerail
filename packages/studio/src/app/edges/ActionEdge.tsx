import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

import type { ActionEdge as ActionEdgeType } from '../model';
import { Pill } from './Pill';

/**
 * A targeted action rendered as an orthogonal self-loop anchored to its target
 * object card, carrying the action pill at the loop's outer point (plan section
 * 3.3 / 3.4 — self-loops do not participate in ELK layering; their geometry is
 * computed here). Multiple self-loops on the same target are staggered
 * vertically via `loopIndex` / `loopCount` so their pills never overlap.
 */
export const ActionEdge = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<ActionEdgeType>) => {
  if (!data) {
    return null;
  }

  const highlighted = data.highlighted || data.active;
  const stroke = highlighted ? 'var(--edge-highlighted)' : 'var(--edge-resting)';

  const anchorX = Math.max(sourceX, targetX);
  const centreY = (sourceY + targetY) / 2;
  const offset = (data.loopIndex - (data.loopCount - 1) / 2) * 78;
  const loopY = centreY + offset;
  const bulgeX = anchorX + 96;

  const path = `M ${sourceX} ${sourceY} C ${bulgeX} ${loopY - 32}, ${bulgeX} ${loopY + 32}, ${targetX} ${targetY}`;

  const labelX = bulgeX + 10;
  const labelY = loopY;

  return (
    <>
      <BaseEdge
        path={path}
        style={{ stroke, strokeWidth: 1, opacity: data.dim ? 0.35 : 1 }}
        markerEnd={`url(#${highlighted ? 'card-one-hi' : 'card-one'})`}
        interactionWidth={0}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          <Pill
            action={data.action}
            active={data.active}
            highlighted={data.highlighted}
            dim={data.dim}
          />
        </div>
      </EdgeLabelRenderer>
    </>
  );
};
