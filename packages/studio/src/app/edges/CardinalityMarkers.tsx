/**
 * A shared pool of SVG `<marker>` defs, mounted once (Liam's pattern: cardinality
 * glyphs are a fixed defs pool referenced by id, never drawn per edge and never
 * rendered as text labels). Each cardinality has a resting and a highlighted
 * (accent) colour variant. Glyph geometry is drawn from scratch — no path data
 * is copied from any reference. The wrapper svg is zero-size and absolutely
 * positioned so it contributes nothing to layout; marker ids are resolved
 * document-globally by `url(#id)`. The same defs pool also carries the radial
 * gradient (`#edge-flow-particle`) used by the highlighted-edge flow particles,
 * so it is defined once and referenced by every animated ellipse.
 */
const OneMarker = ({ id, color }: { id: string; color: string }) => (
  <marker
    id={id}
    markerWidth="10"
    markerHeight="12"
    refX="5"
    refY="6"
    orient="auto-start-reverse"
    markerUnits="userSpaceOnUse"
  >
    <circle cx="2.5" cy="6" r="1.9" stroke={color} strokeWidth="1.2" fill="none" />
    <path d="M7 1V11" stroke={color} strokeWidth="1.2" />
  </marker>
);

const ManyMarker = ({ id, color }: { id: string; color: string }) => (
  <marker
    id={id}
    markerWidth="14"
    markerHeight="16"
    refX="11"
    refY="8"
    orient="auto-start-reverse"
    markerUnits="userSpaceOnUse"
  >
    <path d="M11 8L1 1M11 8L1 8M11 8L1 15" stroke={color} strokeWidth="1.2" fill="none" />
  </marker>
);

export const CardinalityMarkers = () => (
  <svg
    aria-hidden="true"
    data-testid="cardinality-markers"
    style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
  >
    <defs>
      <OneMarker id="card-one" color="var(--edge-resting)" />
      <OneMarker id="card-one-hi" color="var(--edge-highlighted)" />
      <ManyMarker id="card-many" color="var(--edge-resting)" />
      <ManyMarker id="card-many-hi" color="var(--edge-highlighted)" />

      <radialGradient id="edge-flow-particle" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="var(--primary-accent)" stopOpacity="0.95" />
        <stop offset="100%" stopColor="var(--primary-accent)" stopOpacity="0.15" />
      </radialGradient>
    </defs>
  </svg>
);
