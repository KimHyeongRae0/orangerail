import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

import type { LinkEdge as LinkEdgeType } from '../model';

/**
 * A link edge: a cubic Bézier path (React Flow's own `getBezierPath`, no custom
 * math), 1px, resting `#5f6366` and accent `#1ded83` when highlighted, with
 * cardinality shown by shared `<marker>` glyphs referenced by id — never text
 * labels (plan section 3.3). The `many` end carries the crow's-foot glyph; both
 * ends otherwise carry the single-bar glyph. `interactionWidth={0}` drops the
 * invisible hit-test path: the studio is view-only (edges are never clicked),
 * and a highlighted edge's raised z-index must never intercept a click meant
 * for an action pill drawn over it. Flow particles are NOT drawn here — they
 * live in a decoupled overlay (`ParticleOverlay`) so their animation never
 * forces React Flow to re-render/remount the edge (see FlowParticles docs).
 */
export const LinkEdge = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<LinkEdgeType>) => {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const highlighted = data?.highlighted ?? false;
  const stroke = highlighted ? 'var(--edge-highlighted)' : 'var(--edge-resting)';
  const startId = highlighted ? 'card-one-hi' : 'card-one';
  const many = data?.link.cardinality === 'many';
  const endId = many
    ? highlighted
      ? 'card-many-hi'
      : 'card-many'
    : highlighted
      ? 'card-one-hi'
      : 'card-one';

  return (
    <BaseEdge
      path={path}
      style={{ stroke, strokeWidth: 1 }}
      markerStart={`url(#${startId})`}
      markerEnd={`url(#${endId})`}
      interactionWidth={0}
    />
  );
};
