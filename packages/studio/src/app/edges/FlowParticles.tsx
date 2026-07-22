import type { CSSProperties } from 'react';

/**
 * Number of "flow" particles travelling along an edge (clone spec "Edge
 * animated 'flow' particles"). One loop lasts `ANIMATE_DURATION` seconds; the
 * particles are staggered exactly one second apart so at any instant they are
 * spread evenly along the path.
 */
const PARTICLE_COUNT = 6;
const ANIMATE_DURATION = 6;

/**
 * Animated flow particles for an edge: small gradient-filled ellipses (`rx=5`,
 * `ry=1.2`) travelling along the edge's own bezier path. Visible ONLY when
 * `active` is true — resting edges show nothing. The gradient is a shared def
 * (`#edge-flow-particle`) mounted once alongside the cardinality markers.
 *
 * Motion is a pure-CSS motion-path animation (`offset-path` set to the edge's
 * `d` string, `offset-distance` animated 0→100% via the `edge-flow-travel`
 * keyframes, staggered one second apart with the clone spec's cubic easing).
 * SVG `<animateMotion>` was tried first but, when reconciled by React inside
 * React Flow's edge svg, it drives a continuous edge-remount loop that freezes
 * the particles and storms hover events while a cursor rests on a card
 * (reviewer finding); a CSS compositor animation has no such interaction.
 *
 * The `<g>` is always mounted; visibility toggles with CSS `display` so a
 * highlight flip inserts/removes zero DOM inside the edge svg. It is a pure
 * render-layer concern keyed off the same highlighted state the single
 * highlight pass computes.
 */
export const FlowParticles = ({ path, active }: { path: string; active: boolean }) => (
  <g
    data-testid="flow-particles"
    data-active={active}
    style={{ pointerEvents: 'none', display: active ? undefined : 'none' }}
  >
    {Array.from({ length: PARTICLE_COUNT }, (_unused, index) => {
      const style: CSSProperties = {
        offsetPath: `path("${path}")`,
        offsetRotate: '0deg',
        animation: `edge-flow-travel ${ANIMATE_DURATION}s cubic-bezier(0.42, 0, 0.58, 1) ${-index}s infinite`,
      };

      return (
        <ellipse
          key={index}
          cx={0}
          cy={0}
          rx={5}
          ry={1.2}
          fill="url(#edge-flow-particle)"
          style={style}
        />
      );
    })}
  </g>
);
