import { inspectCoreInstance } from 'orangerail-core';

import type { OrangerailConfig } from './config';

/**
 * Whether the `orangerail-core` a project's config imports is the same one this
 * CLI runs on (ONT-058).
 *
 * `loadConfig` is a plain dynamic `import()` of the user's
 * `orangerail.config.mjs`, and that file resolves `orangerail-core` from ITS
 * own `node_modules`. This binary resolved one too. Nothing anywhere makes the
 * two the same copy, and when they are not, every governed write in the project
 * runs across a seam neither half can see.
 *
 * The seam is not hypothetical and it is not loud. `0.1.0`'s `createFileStore`
 * does not stamp `ApprovalRecord.inputHash`; the current engine refuses to
 * execute an approval that carries none. Compose them — a published project, a
 * newer CLI — and the whole governed loop reports success right up to the point
 * where it does nothing: staging returns an approval id, `approvals approve`
 * prints `approve ok (approved)`, and execution consumes the approval and
 * performs no write. Every surface answers correctly about its own half. Only a
 * check that can see BOTH halves can name it, and this is that check.
 */
export type CoreSkewState =
  /** One `orangerail-core`. The ordinary state; nothing is reported. */
  | 'aligned'
  /**
   * Two copies, both new enough to identify themselves. They agree on the
   * approval contract today, so writes work — this is a warning about a
   * duplicate install, not a broken project.
   */
  | 'duplicated'
  /**
   * The config's core does not identify itself: it predates this marker
   * (`0.1.0` and older). Approvals it creates carry no `inputHash` and this
   * CLI's engine refuses every one of them.
   */
  | 'stale';

export interface CoreSkewReview {
  state: CoreSkewState;
}

/**
 * Review the config's core against this one.
 *
 * Keyed on the REGISTRY, and deliberately on nothing else. Two candidates were
 * available and only one is sound:
 *
 * - **A version comparison** cannot work. `orangerail-core` exports
 *   `version = '0.0.0'` while its `package.json` says `0.1.0`, so the one
 *   string a skew check could read has already drifted from the truth once; and
 *   the copy whose version we most need is `0.1.0`, which predates any field we
 *   could add, so the skewed case reads `undefined` no matter what we key on.
 *   A check that answers "unknown" precisely when it matters is not a check.
 * - **Object identity** is exact, cannot go stale, and needs no agreement
 *   between versions: `createRegistry` stamps a token private to its own module
 *   instance, and two module instances are two tokens.
 *
 * The registry is the carrier because it is the unambiguous one. A `Registry`
 * comes from `createRegistry` or it does not exist — there is no supported way
 * to hand-build one. A `Store`, by contrast, is a documented extension point
 * (`store/contract.ts` specifies what a conforming adapter must do), so an
 * unmarked store would be honestly ambiguous between "an old core" and "a
 * custom adapter working exactly as designed", and a check that shouts at the
 * second is a check operators learn to ignore.
 */
export const reviewCoreSkew = ({ config }: { config: OrangerailConfig }): CoreSkewReview => {
  const verdict = inspectCoreInstance({ value: config.registry });

  if (verdict === 'same') {
    return { state: 'aligned' };
  }

  return { state: verdict === 'other' ? 'duplicated' : 'stale' };
};

/**
 * The stderr block `orangerail mcp` writes before it says anything reassuring.
 *
 * A block and not a clause, for the same reason the governance notice is one:
 * under this condition every other line of the startup readout — the gate
 * count, the audit verdict, the pending queue — is true and beside the point,
 * because none of them can complete a write. It names the cause and the fix,
 * and it names the case where the cause is NOT an upgrade, because an operator
 * who never upgraded anything and is told "you upgraded" stops reading.
 */
export const coreSkewNotice = ({ review }: { review: CoreSkewReview }): string => {
  if (review.state === 'stale') {
    return (
      'orangerail mcp: CORE VERSION SKEW — your config imports an orangerail-core older than this CLI runs on.\n' +
      'orangerail mcp: That older core creates approvals without an inputHash, and this one refuses to execute an\n' +
      'orangerail mcp: approval it cannot bind to its payload. Staging and approving will keep reporting success and\n' +
      'orangerail mcp: NO GOVERNED WRITE WILL EVER COMPLETE — each attempt is spent as `invalidated (stale_approval)`.\n' +
      'orangerail mcp: Fix: install orangerail-core at the same version as this CLI in the project, then re-stage any\n' +
      'orangerail mcp: pending approval — approvals created by the old core cannot be recovered.\n' +
      'orangerail mcp: If you did NOT just upgrade, the two are resolving from different node_modules; run\n' +
      'orangerail mcp: `npm ls orangerail-core` (or `pnpm why orangerail-core`) from the project and dedupe.\n'
    );
  }

  if (review.state === 'duplicated') {
    return (
      'orangerail mcp: TWO COPIES of orangerail-core are loaded — your config imports one, this CLI runs another.\n' +
      'orangerail mcp: They agree on the approval contract, so writes work right now. They are one partial upgrade\n' +
      'orangerail mcp: away from not agreeing, at which point every governed write stops silently. Dedupe with\n' +
      'orangerail mcp: `npm ls orangerail-core` (or `pnpm why orangerail-core`) from the project.\n'
    );
  }

  return '';
};
