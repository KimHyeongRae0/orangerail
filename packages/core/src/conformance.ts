import type { z } from 'zod';

/**
 * Whether a value matches the shape the object that produced it declares.
 *
 * `defineObject` has stored `schema` and never parsed `resolve` output with it
 * since §3.1 (`define/object.ts:31-38`), so every consumer of a resolved row has
 * been reading a value nobody checked. ONT-070/071/072 each fixed one RENDERING
 * surface of that and each stopped at this file; the consequence measured in
 * ONT-074 is not a rendering one — a `where` clause written to stop an action
 * permitted it, because `undefined !== 'soldout'` is `true`.
 *
 * The verdict is computed HERE, once, and each consumer decides for itself what
 * to do with it: the gate refuses (fail-closed), the read path marks and still
 * answers (total). Deliberately NOT a wrapper around `resolve.get`/`resolve.list`
 * — changing what a resolver returns would change what MCP, the studio, docs-gen
 * and the approver view all receive, which is a breaking change wearing a
 * bugfix's clothes. Compute, do not rewrap.
 *
 * The parse RESULT is discarded on purpose. A schema carrying `.transform()`
 * produces an output value no consumer here holds — `evaluateWhere` reads the
 * raw row and the transport serves the raw row — so substituting it would answer
 * a question about a value nobody has. Every caller therefore asks about the
 * value IT holds, and gets an answer about that value.
 */

/** One place a value diverged from the shape its object declares. */
export interface ConformanceIssue {
  /**
   * Where the divergence sits, as zod reported it: `['status']`,
   * `['items', 0, 'id']`, and `[]` for the root — a row that is not the shape
   * the object declares at all.
   *
   * Kept as SEGMENTS rather than as a rendered string because both consumers
   * need it structurally: the gate compares the head against the field its
   * clause names, and the transport walks it to put a marker exactly where the
   * value was. {@link renderConformancePath} is the one spelling of it for a
   * reader.
   *
   * Matching on the reported path rather than on the schema's `.shape` is what
   * makes a `ZodObject`, a union, a `.refine()` and a `.transform()` travel
   * through one code path instead of three spellings of "reach inside a zod
   * node".
   */
  path: (string | number)[];
  /** zod's own sentence for this issue, verbatim. */
  message: string;
}

/** Render an issue path as a reader would name it (`items[0].id`, `$` at the root). */
export const renderConformancePath = ({ path }: { path: (string | number)[] }): string =>
  path.length === 0
    ? '$'
    : path.reduce<string>(
        (acc, segment) =>
          typeof segment === 'number'
            ? `${acc}[${segment}]`
            : acc === ''
              ? segment
              : `${acc}.${segment}`,
        '',
      );

/**
 * The answer to "does this value match what the object declares".
 *
 * `unreadable` is its own state rather than a nonconforming verdict: a parse
 * over arbitrary user data can THROW (a getter on the row is user code), and a
 * caller must be able to tell "the row is wrong" from "the row could not be
 * read at all" — the second one is the existing `resolve_error` path.
 */
export type Conformance =
  | { state: 'conforming' }
  | { state: 'nonconforming'; issues: ConformanceIssue[] }
  | { state: 'unreadable'; error: string };

/** Describe a thrown value without trusting it to describe itself. */
const errorText = ({ error }: { error: unknown }): string => {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return String(error);
  } catch {
    return 'a value that cannot describe itself';
  }
};

/**
 * Normalize a zod issue path into the segments this module carries.
 *
 * zod v4 types a segment as `PropertyKey`, so a `symbol` is expressible. One is
 * rendered as its description rather than dropped: a segment that vanishes would
 * shorten the path and point the marker at the wrong value.
 */
const pathSegments = ({ path }: { path: readonly PropertyKey[] }): (string | number)[] =>
  path.map((segment) => (typeof segment === 'number' ? segment : String(segment)));

/**
 * Check a value against the schema its object declares.
 *
 * Extra keys the schema does not mention are NOT an issue — `z.object` strips
 * them and `safeParse` succeeds — which is deliberate: a resolver returning one
 * more column than the ontology names is the ordinary state of a project mid
 * migration, and turning that into a refusal would be this layer inventing a
 * rule nobody declared.
 */
export const checkConformance = ({
  schema,
  value,
}: {
  schema: z.ZodType;
  value: unknown;
}): Conformance => {
  // The result type is read off `safeParse` itself rather than named: zod v3
  // spells it `SafeParseReturnType` and zod v4 does not, and this package
  // supports both (`peerDependencies: ^3.23 || ^4`).
  let parsed: ReturnType<z.ZodType['safeParse']>;

  try {
    parsed = schema.safeParse(value);
  } catch (error) {
    return { state: 'unreadable', error: errorText({ error }) };
  }

  if (parsed.success) {
    return { state: 'conforming' };
  }

  const issues = parsed.error.issues.map((issue) => ({
    path: pathSegments({ path: issue.path }),
    message: issue.message,
  }));

  // A schema that refuses a value without reporting a single issue would leave
  // the gate with a refusal it cannot explain. There is no such zod schema
  // today; if one appears, it says so rather than reading as conforming.
  return issues.length === 0
    ? { state: 'nonconforming', issues: [{ path: [], message: 'the value did not parse' }] }
    : { state: 'nonconforming', issues };
};

/** What a conformance verdict says about ONE declared field. */
export type FieldConformance =
  | { state: 'conforming' }
  | { state: 'nonconforming'; issues: ConformanceIssue[] }
  | { state: 'unreadable'; error: string };

/**
 * Narrow a whole-value verdict to the one field a caller is about to read.
 *
 * This is the entire difference between a bugfix and a breaking change. The
 * `where` gate consults exactly ONE field; a row that fails its schema somewhere
 * that field never reaches has nothing to do with the decision being made, and
 * refusing it would reject setups that work today for a reason unrelated to
 * governance (ONT-074 AC-3).
 *
 * An issue that names no field — one at the root, because the row is not an
 * object at all — counts for EVERY field: if the row is not the shape it was
 * declared to be, no field read off it can be trusted.
 */
export const conformanceOfField = ({
  conformance,
  field,
}: {
  conformance: Conformance;
  field: string;
}): FieldConformance => {
  if (conformance.state !== 'nonconforming') {
    return conformance;
  }

  const issues = conformance.issues.filter(
    (issue) => issue.path[0] === field || typeof issue.path[0] !== 'string',
  );

  return issues.length === 0 ? { state: 'conforming' } : { state: 'nonconforming', issues };
};

/**
 * The one sentence every surface uses for "this is not what the object
 * declares", built from the object's own name and zod's own message.
 *
 * Kept in core so the gate's audit record and the transport's marker cannot
 * drift into two spellings of one fact.
 */
export const conformanceReason = ({
  issues,
  objectName,
}: {
  issues: ConformanceIssue[];
  objectName: string;
}): string => {
  const parts = issues.map(
    (issue) => `${renderConformancePath({ path: issue.path })}: ${issue.message}`,
  );

  return `not what ${objectName} declares — ${parts.join('; ')}`;
};

/**
 * The in-place stand-in for a value a surface will not show as it is.
 *
 * The same spelling `packages/cli/src/render.ts:102` and
 * `packages/studio/src/app/DetailPanel.tsx:127` already produce. It lives here
 * so the MCP transport can reuse it by IMPORT rather than by a third copy: `cli`
 * depends on `mcp`, not the reverse, so `render.ts` was never reachable from the
 * transport. The two existing copies are on surfaces this ticket does not own
 * and are left where they are; their e2e assertions are what hold all three
 * byte-equal.
 */
export const UNRENDERABLE_PREFIX = '<UNRENDERABLE — ';

/** Wrap a reason in the shared marker form. */
export const unrenderable = ({ reason }: { reason: string }): string =>
  `${UNRENDERABLE_PREFIX}${reason}>`;

/**
 * Return `value` with a marker where each issue sits, structurally sharing
 * everything else.
 *
 * Copy-on-path rather than in-place assignment: the value handed in is a
 * resolver's own row, and a read surface that edits it would change what the
 * caller's next line sees.
 */
const markAt = ({
  value,
  path,
  depth,
  marker,
}: {
  value: unknown;
  path: (string | number)[];
  depth: number;
  marker: string;
}): unknown => {
  if (depth >= path.length) {
    return marker;
  }

  const key = path[depth];

  if (Array.isArray(value) && typeof key === 'number') {
    const copy = [...(value as unknown[])];
    copy[key] = markAt({ value: copy[key], path, depth: depth + 1, marker });

    return copy;
  }

  if (value !== null && typeof value === 'object' && typeof key === 'string') {
    const row = value as Record<string, unknown>;

    // The key is written whether or not it was there. A field the row simply
    // omitted is the case this whole ticket started from, and leaving it absent
    // would hand the reader the same silence it already had.
    return { ...row, [key]: markAt({ value: row[key], path, depth: depth + 1, marker }) };
  }

  // The path does not lead anywhere in this value — nothing to mark, and
  // inventing a container to mark inside would be describing a shape nobody
  // returned.
  return value;
};

/**
 * Mark every part of a value its object's schema refuses, and report what was
 * marked (ONT-074 AC-5).
 *
 * The pair is the contract `packages/cli/src/render.ts:303` established and the
 * studio server serves: the VALUE is what a surface shows, and `issues` is what
 * that surface must say it is not showing. `issues` comes from the parse and
 * never from the rendered text, so a stored value carrying the literal marker
 * string appears in the value and NOT in the list, and the two disagree.
 *
 * Marking, never dropping or coercing. A read that silently substitutes a value
 * the caller can use is the failure ONT-071 was filed for; this one substitutes
 * a sentence that cannot be mistaken for data.
 */
export const markNonconforming = ({
  value,
  conformance,
  objectName,
}: {
  value: unknown;
  conformance: Conformance;
  objectName: string;
}): { value: unknown; issues: ConformanceIssue[] } => {
  if (conformance.state === 'conforming') {
    return { value, issues: [] };
  }

  if (conformance.state === 'unreadable') {
    const reason = `not readable as ${objectName} — ${conformance.error}`;

    return {
      value: unrenderable({ reason }),
      issues: [{ path: [], message: conformance.error }],
    };
  }

  // One marker per PATH, not per issue: a union reports several messages about
  // the same field, and a value can only be replaced once.
  const byPath = new Map<string, ConformanceIssue[]>();

  for (const issue of conformance.issues) {
    const key = renderConformancePath({ path: issue.path });

    byPath.set(key, [...(byPath.get(key) ?? []), issue]);
  }

  let marked = value;

  for (const issues of byPath.values()) {
    const reason = `not what ${objectName} declares here: ${issues.map((issue) => issue.message).join('; ')}`;

    marked = markAt({
      value: marked,
      path: issues[0]?.path ?? [],
      depth: 0,
      marker: unrenderable({ reason }),
    });
  }

  return { value: marked, issues: conformance.issues };
};
