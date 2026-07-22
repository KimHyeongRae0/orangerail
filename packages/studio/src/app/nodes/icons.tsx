/**
 * Small inline SVG glyphs, drawn from scratch (own geometry — no path data is
 * copied from any reference). They follow Liam's shape-not-color field-marker
 * grammar: a filled diamond for required fields, an outline diamond for
 * optional ones, both in 70%-white; a link glyph in accent for link fields.
 */

/** A compact table/grid glyph for the object-card header. */
export const TableGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M1.5 5.5H12.5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5.5 5.5V12.5" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

/** Filled diamond — a required (non-optional) field. */
export const DiamondFilled = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 1L11 6L6 11L1 6Z" fill="currentColor" />
  </svg>
);

/** Outline diamond — an optional field. */
export const DiamondOutline = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M6 1.2L10.8 6L6 10.8L1.2 6Z" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

/** Link glyph — a field that participates in a link (accent-coloured). */
export const LinkGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
    <path
      d="M5 8L8 5M4.2 6.2L2.8 7.6a2.1 2.1 0 103 3l1.4-1.4M8.8 6.8l1.4-1.4a2.1 2.1 0 10-3-3L5.8 2.8"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

/** A padlock glyph for governed action pills. */
export const LockGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" />
    <path d="M4 5.5V4a2 2 0 114 0v1.5" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

/** A lightning glyph for auto (ungoverned) action pills. */
export const BoltGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M7 1L2.5 7H5.5L5 11L9.5 5H6.5L7 1Z" fill="currentColor" />
  </svg>
);
