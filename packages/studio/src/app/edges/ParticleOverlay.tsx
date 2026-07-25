import { useStore } from '@xyflow/react';
import { useEffect, useState } from 'react';

import { FlowParticles } from './FlowParticles';

interface OverlayPath {
  id: string;
  d: string;
}

/**
 * Read the rendered `d` of each active edge straight from the DOM. React Flow
 * has already drawn every edge path (in viewport-local coordinates), so the
 * overlay reuses that exact geometry rather than recomputing it — particles
 * therefore always sit precisely on the visible edge. Ids such as
 * `actedge:publish_product` contain a colon, which an attribute selector
 * handles without escaping.
 */
const readActivePaths = ({ activeEdgeIds }: { activeEdgeIds: string[] }): OverlayPath[] => {
  const paths: OverlayPath[] = [];

  for (const id of activeEdgeIds) {
    const edge = document.querySelector(`.react-flow__edge[data-id="${id}"]`);
    const el = edge?.querySelector('.react-flow__edge-path') ?? edge?.querySelector('path');
    const d = el?.getAttribute('d');

    if (d) {
      paths.push({ id, d });
    }
  }

  return paths;
};

/**
 * Flow-particle overlay — the render-layer home for animated edge particles,
 * deliberately kept OUT of React Flow's edge components.
 *
 * Animated particles placed inside an edge component force React Flow to
 * re-render and remount that edge many times a second (verified: ~18 edge
 * re-renders/s while a cursor rests on a card), which freezes the particles and
 * storms hover events. Rendered here — as a single React Flow child that is
 * neither a node nor an edge — the particles live in their own svg that React
 * Flow never reconciles on hover, so no remount loop can form.
 *
 * The overlay mirrors the live viewport transform (`useStore`) and re-reads the
 * active edges' `d` strings only when the active set or node positions change
 * (never per animation frame). The CSS motion-path animation then runs entirely
 * on the compositor. `pointer-events: none` keeps it out of hit-testing so it
 * cannot perturb clicks or hover.
 */
export const ParticleOverlay = ({ activeEdgeIds }: { activeEdgeIds: string[] }) => {
  const transform = useStore((state) => state.transform);
  const positionSignal = useStore((state) => {
    let signal = '';
    state.nodeLookup.forEach((node) => {
      const p = node.internals.positionAbsolute;
      signal += `${node.id}:${Math.round(p.x)},${Math.round(p.y)};`;
    });

    return signal;
  });

  // The set of edge ids React Flow currently holds. A focus can INSERT edges
  // (the human views overlay a focused person's / service's `works_on` ties),
  // and React Flow renders those in a later commit than the one that changed
  // `activeEdgeIds`. Re-reading when this signal changes lets the overlay pick
  // up a newly-added focus edge once its path is actually in the DOM.
  const edgeSignal = useStore((state) => state.edges.map((edge) => edge.id).join('|'));

  const [paths, setPaths] = useState<OverlayPath[]>([]);

  const key = activeEdgeIds.join('|');

  // `key` re-reads when the active set changes; `positionSignal` re-reads when a
  // node drag / re-layout moves an edge; `edgeSignal` re-reads when the rendered
  // edge set changes (a focus overlay adds edges), so the overlay always uses
  // fresh geometry. `activeEdgeIds` is intentionally read through the stable `key`.
  //
  // A focus change hands React Flow a fresh edge array, so it re-renders every
  // edge and recomputes each path `d` from an async node measurement — for a
  // frame the paths are absent. We read immediately (fast path for edges already
  // measured, e.g. the DB map) and again once measurement has settled (the same
  // 70ms + two-frame wait `fitAll` uses), so a focus edge whose geometry lands a
  // frame later is still picked up.
  useEffect(() => {
    const read = () => setPaths(readActivePaths({ activeEdgeIds }));

    read();

    let frame = 0;
    const timer = setTimeout(() => {
      frame = requestAnimationFrame(() => requestAnimationFrame(read));
    }, 70);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [key, positionSignal, edgeSignal, activeEdgeIds]);

  const [tx, ty, zoom] = transform;

  return (
    <svg
      data-testid="particle-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
      }}
    >
      <g transform={`translate(${tx}, ${ty}) scale(${zoom})`}>
        {paths.map((path) => (
          <FlowParticles key={path.id} path={path.d} active />
        ))}
      </g>
    </svg>
  );
};
