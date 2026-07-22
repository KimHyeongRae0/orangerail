/**
 * Local JSON Pointer resolver for OpenAPI component references (ONT-007, plan
 * step I1). Resolves only in-document `#/…` pointers — the v0 boundary — with
 * RFC 6901 segment unescaping, a cycle guard, and a depth bound so a hostile or
 * self-referential document never hangs or overflows the stack. Anything
 * outside this boundary (external/URL pointers, missing targets, cycles, or an
 * over-deep chain) returns a typed reason the scanner aggregates into its
 * honest skip-with-warning line rather than throwing.
 */

/** Upper bound on chained `$ref` hops before a reference is treated as too deep. */
const MAX_DEPTH = 16;

/** Why a local reference could not be resolved (aggregated by the scanner). */
export type ResolveReason = 'external' | 'missing' | 'cycle' | 'depth';

/** The outcome of resolving one `$ref`: the target value, or a typed reason. */
export type ResolveResult = { ok: true; value: unknown } | { ok: false; reason: ResolveReason };

/**
 * Unescape one RFC 6901 pointer segment: `~1` decodes to `/` and `~0` decodes
 * to `~`. The `~1`-then-`~0` order is mandatory so an encoded `~1` (`~01`) does
 * not collapse into a spurious `/`.
 */
const unescapeSegment = ({ segment }: { segment: string }): string =>
  segment.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * The `$ref` pointer of a JSON Reference object (`{ "$ref": "…" }`), or
 * `undefined` if the value is not a reference. Siblings are ignored per JSON
 * Reference semantics. Returning the string (rather than a type predicate) lets
 * callers keep the house-style destructured-object parameter shape.
 */
export const refOf = ({ value }: { value: unknown }): string | undefined => {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $ref?: unknown }).$ref === 'string'
  ) {
    return (value as { $ref: string }).$ref;
  }

  return undefined;
};

/**
 * Resolve a local `#/…` JSON Pointer against the parsed document, following
 * chained references (a target that is itself a `{ $ref }`) until a concrete
 * value is reached. `seen` accumulates the pointers visited on the current
 * chain so an A→B→A or self-referential cycle terminates with `'cycle'`; the
 * chain length is capped at `MAX_DEPTH` (`'depth'`). Non-local pointers return
 * `'external'`; a segment that does not exist returns `'missing'`.
 */
export const resolveLocalRef = ({
  doc,
  ref,
  seen = new Set<string>(),
  depth = 0,
}: {
  doc: unknown;
  ref: string;
  seen?: Set<string>;
  depth?: number;
}): ResolveResult => {
  if (depth > MAX_DEPTH) {
    return { ok: false, reason: 'depth' };
  }

  if (!ref.startsWith('#/')) {
    return { ok: false, reason: 'external' };
  }

  if (seen.has(ref)) {
    return { ok: false, reason: 'cycle' };
  }

  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => unescapeSegment({ segment }));

  let current: unknown = doc;

  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      return { ok: false, reason: 'missing' };
    }

    current = (current as Record<string, unknown>)[segment];
  }

  const chained = refOf({ value: current });
  if (chained !== undefined) {
    const nextSeen = new Set(seen);
    nextSeen.add(ref);

    return resolveLocalRef({ doc, ref: chained, seen: nextSeen, depth: depth + 1 });
  }

  return { ok: true, value: current };
};
