/**
 * Which copy of `orangerail-core` made this object (ONT-058).
 *
 * The problem this exists for is a two-instance load, and it is not exotic: a
 * project's `orangerail.config.mjs` imports `createRegistry` / `createFileStore`
 * from the `orangerail-core` that resolves next to the CONFIG, while the
 * `orangerail` binary running that config resolves `orangerail-core` next to the
 * CLI. A globally-installed CLI against a locally-installed core, a pnpm store
 * that did not dedupe, a workspace checkout run against a published project —
 * all three produce one process holding two cores.
 *
 * That is invisible until the two disagree about a contract, and then it is
 * worse than invisible. The `0.1.0` core does not stamp
 * `ApprovalRecord.inputHash`; the current core refuses to execute an approval
 * that carries none (§3.4 / ONT-040, and correctly — an unbindable payload must
 * not run). Compose them and staging succeeds, `approvals approve` answers
 * `approve ok (approved)`, and execution consumes the approval and does nothing.
 * Every governed write in the project is dead, and every surface reports a
 * policy decision.
 *
 * ## Why identity and not a version string
 *
 * The obvious check is "compare the two versions". It does not work here:
 *
 * 1. **The version orangerail exports is not the version orangerail ships.**
 *    `index.ts` exports `version = '0.0.0'` while `package.json` says `0.1.0`.
 *    A marker keyed on a constant that has already gone stale once is a marker
 *    that will report a false alignment the next time it goes stale.
 * 2. **The old copy is exactly the copy that cannot answer.** `0.1.0` predates
 *    any check we add, so whatever field we read, the skewed case reads
 *    `undefined`. A version comparison degrades to a presence check anyway —
 *    with an extra field to keep honest.
 * 3. **Equal versions do not imply one instance.** Two copies of the same
 *    version agree today and are one partial upgrade away from not agreeing.
 *    The hazard is the duplication itself, and only identity sees it.
 *
 * So the marker is the identity of a module-scoped token. Two module instances
 * are two tokens and compare unequal; one instance compares equal to itself.
 * There is nothing to keep in sync, and the answer cannot go stale.
 *
 * The key is `Symbol.for` (the cross-realm registry) rather than a module-local
 * symbol, for the same reason `diagnostic.ts` uses one: a module-local symbol
 * from copy A is not the symbol copy B looks up, so the check would read
 * `unmarked` for every duplicate and could never tell a duplicate from an
 * ancient core — the exact distinction it exists to draw.
 */

/** The property key each copy of this package stamps its own token under. */
export const CORE_INSTANCE_KEY = Symbol.for('orangerail.coreInstance');

/**
 * THIS module instance's token. Frozen and never exported: a caller that could
 * hold it could forge alignment, and identity is the only thing it carries.
 */
const INSTANCE_TOKEN: object = Object.freeze({ package: 'orangerail-core' });

/**
 * Stamp an object as made by this copy of `orangerail-core`.
 *
 * Non-enumerable, so the mark never reaches `JSON.stringify`, an object spread,
 * or a `structuredClone` — a wrapper built around a marked object is a
 * different object and must not inherit the claim.
 */
export const markCoreInstance = <T extends object>({ value }: { value: T }): T => {
  Object.defineProperty(value, CORE_INSTANCE_KEY, {
    value: INSTANCE_TOKEN,
    enumerable: false,
    configurable: true,
    writable: true,
  });

  return value;
};

/**
 * The verdict for one object.
 *
 * - `same` — made by this copy. Nothing to report.
 * - `other` — made by ANOTHER copy of a core new enough to mark itself. The two
 *   agree on the approval contract today; they are a duplicate install and one
 *   partial upgrade from the failure above.
 * - `unmarked` — made by a core that predates this marker (`0.1.0` and older),
 *   or not made by `orangerail-core` at all. This is the state that breaks
 *   governed writes, and it is a definite answer: nothing about a current core
 *   can produce it.
 */
export type CoreInstanceVerdict = 'same' | 'other' | 'unmarked';

/**
 * Read the verdict off a value. Nothing about the mark is trusted beyond its
 * identity — a forged property holding anything other than THIS token reads as
 * `other`, which is the conservative answer.
 */
export const inspectCoreInstance = ({ value }: { value: unknown }): CoreInstanceVerdict => {
  if (typeof value !== 'object' || value === null) {
    return 'unmarked';
  }

  const token: unknown = (value as Record<symbol, unknown>)[CORE_INSTANCE_KEY];

  if (token === undefined) {
    return 'unmarked';
  }

  return token === INSTANCE_TOKEN ? 'same' : 'other';
};
