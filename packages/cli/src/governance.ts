import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  canonicalJson,
  type Registry,
  type RuntimeAction,
  type WhereClause,
} from 'orangerail-core';

/**
 * The governance baseline (ONT-043) and everything that reads it (ONT-050).
 * `commands/sync/diff.ts` answers "does the ontology still match the scanned
 * source?"; this module answers the question the scan structurally cannot: "is
 * the ontology still governed the way it was when it was last vouched for?".
 *
 * The scanner has no opinion on policy — it always proposes
 * `approval: 'required'` and the user owns every edit afterwards — so a
 * scan-vs-ontology diff cannot express a policy change at all. The comparison
 * therefore runs against a RECORDED baseline: `orangerail.governance.json` next
 * to `orangerail.config.mjs`. That file is meant to be committed, so a pull
 * request that un-gates an action shows `"approval": "required"` turning into
 * `null` in its own diff.
 *
 * The posture is read from the LIVE REGISTRY, never by parsing `ontology/*.mjs`
 * text: the registry is what actually runs, so a policy hidden behind a
 * conditional or a spread is still measured.
 *
 * Direction is the whole point. Weakening the posture must never be silent, so it
 * is reported and drives a non-zero exit; strengthening it is safe and is reported
 * quietly. A change this module cannot ORDER — a `where` guard whose field/op/value
 * was rewritten, a roles set that is neither equal nor a strict narrowing, a
 * different target — is read as weakening, because sync cannot prove an arbitrary
 * rewrite is not weaker and the human can say so with one flag.
 *
 * It no longer lives under `commands/sync/`: `orangerail mcp` withholds the
 * actions this module reports as weakened and `orangerail status` reports the
 * baseline state, so a governance verdict is a property of the project, not an
 * implementation detail of one command.
 *
 * ## The deny-list (ONT-059)
 *
 * The same file records which scanned models were REFUSED. It belongs here and
 * not in a file of its own for the reason the postures do: this is the committed
 * record of what was intended for the agent's surface, and "these actions are
 * gated" and "this table is not reachable at all" are two clauses of one
 * intention. Two files could disagree, and the second one would arrive with no
 * convention saying it must be committed.
 *
 * It is a list of NAMES considered and refused — never a snapshot of what
 * existed. A table that appears after the refusal was recorded is not in the
 * list, so it is still reported loudly. The cost is that a future, unrelated
 * table reusing a refused name inherits the refusal; the stale-exclusion notice
 * on every readout is what keeps that from going unnoticed.
 */

/** The baseline filename, next to `orangerail.config.mjs`. */
export const GOVERNANCE_FILE = 'orangerail.governance.json';

/** The recorded baseline's schema version — a mismatch is an error, not a downgrade. */
const BASELINE_VERSION = 1;

/**
 * Who put the posture in the file.
 *
 * `sync` means a human ran `orangerail sync --accept-governance`: an assertion
 * that someone looked at this posture and vouched for it. `init` means the file
 * records the posture `orangerail init` generated, untouched, before anyone
 * reviewed anything — a provenance claim, not a review claim.
 *
 * Since ONT-056 an init-recorded baseline is NOT necessarily all-gated: the
 * default `--gate delete` writes `"approval": null` for every create and update.
 * The distinction is what keeps that honest. `init` never asserts a review, and
 * every readout repeats that it is unreviewed, so the file cannot launder a weak
 * posture as approved; what it does buy is that a later weakening is detectable
 * from the first minute. Keeping the two apart is what stops the file claiming a
 * review that never happened, which is the reason ONT-043 declined to write it
 * at all.
 *
 * The limit is worth stating where the file is written: the comparison is against
 * the recorded starting point, so an action that was generated un-gated is
 * recorded un-gated and never trips the weakening check. `orangerail status`
 * prints `N approval-gated, M auto` because that is the readout which does not
 * depend on the baseline being strict.
 */
export type RecordedBy = 'init' | 'sync';

const SYNC_NOTE =
  'Governance baseline recorded by `orangerail sync --accept-governance`: a human reviewed ' +
  'this posture. `orangerail sync` reports and fails when the posture of an action weakens ' +
  'against these rows, and `orangerail mcp` refuses to serve an action that weakened. Commit ' +
  'this file; re-record it after an intentional policy change.';

/**
 * The note written into the baseline so someone who finds the file knows what it
 * is.
 *
 * The `init` note counts its own rows (ONT-056). `orangerail init` no longer
 * gates everything it generates, so "the posture init generated" is not enough
 * on its own for a reviewer to know whether the `null`s below were generated or
 * introduced later. The count is derived from the rows in the same file rather
 * than echoed from the `--gate` value, so it describes what is actually written
 * here and cannot drift from it.
 */
const baselineNote = ({
  recordedBy,
  postures,
  excluded,
}: {
  recordedBy: RecordedBy;
  postures: ActionPosture[];
  excluded: string[];
}): string => {
  // The deny-list clause rides on the SAME note rather than a second key: one
  // note is one thing a reader has to find, and a note that is only sometimes
  // there is a note nobody looks for.
  const exclusions = excluded.length === 0 ? '' : ` ${EXCLUSION_NOTE}`;

  if (recordedBy === 'sync') {
    return `${SYNC_NOTE}${exclusions}`;
  }

  const gated = postures.filter((posture) => posture.approval === 'required').length;

  return (
    'Governance baseline recorded by `orangerail init`: this is the posture init GENERATED ' +
    `(${gated} of ${postures.length} action(s) approval-gated), before anyone reviewed it — it ` +
    'is a starting point, not an approval. Read it, then run ' +
    '`orangerail sync --accept-governance` to vouch for it. `orangerail sync` reports and fails ' +
    'when the posture of an action weakens against these rows, and `orangerail mcp` refuses to ' +
    'serve an action that weakened. Commit this file.' +
    exclusions
  );
};

/**
 * The note written next to a non-empty deny-list.
 *
 * It states the one property of a name-based list that a reader has to know:
 * these are names, so a NEW table is still reported, and a future table reusing
 * one of these names is not. Nothing in the tool can resolve that ambiguity —
 * only the person reading the list can — so the file says it out loud instead of
 * leaving the behavior to be discovered.
 */
const EXCLUSION_NOTE =
  'These model names were considered and refused: `orangerail sync` reports them as excluded ' +
  'instead of proposing them, and `--accept-new` will not create files for them. This is a ' +
  'list of NAMES, not a snapshot — a model that appears later and is not listed here is still ' +
  'reported as new, and a future model that reuses one of these names inherits the refusal. ' +
  'Delete a name here to re-admit that model.';

/**
 * One action's governance posture — the fields that decide whether a call is
 * gated, who may release it, and which row it may touch. Deliberately NOT the
 * action's input shape: that is `diff.ts`'s job, and mixing the two would make
 * every field change look like a policy change (the reason core's own
 * `computeSignatureHash` cannot be reused here).
 */
export interface ActionPosture {
  /** The registry action name. */
  name: string;
  /** `'required'` when a human must release the call, `null` when it auto-executes. */
  approval: 'required' | null;
  /** Approver roles, sorted. Empty means "any approver" — the WIDEST set, not the narrowest. */
  roles: string[];
  /** The `where` guard in comparable form, or `null` when the action carries none. */
  where: string | null;
  /** `<Object>#<idFrom>` when the action targets a row, `null` when it is free-standing. */
  target: string | null;
}

/** One classified difference between the recorded baseline and the live registry. */
export interface GovernanceChange {
  /** The action the change lands on. */
  action: string;
  /**
   * `weakened` — the posture got looser, or moved in a way sync cannot prove is
   * not looser. Reported loudly and fails the run. `strengthened` — the posture
   * got tighter or the action is gone; reported as information only.
   */
  direction: 'weakened' | 'strengthened';
  /** Human-readable statement of what moved, in `was -> now` terms. */
  detail: string;
}

/**
 * Reduce a `where` clause to a comparable string. A functional predicate collapses
 * to the constant `functional` — its body is opaque here exactly as it is to
 * `computeSignatureHash`, so a rewrite INSIDE a functional guard is invisible to
 * sync. That limit is stated in the report rather than papered over.
 */
const whereForm = ({ where }: { where?: WhereClause | undefined }): string | null => {
  if (where === undefined) {
    return null;
  }

  if (typeof where === 'function') {
    return 'functional';
  }

  return `${where.field} ${where.op} ${canonicalJson({ value: where.value ?? null })}`;
};

/** The posture of one live registry action. */
const postureOf = ({ action }: { action: RuntimeAction }): ActionPosture => ({
  name: action.name,
  approval: action.policy?.approval === 'required' ? 'required' : null,
  roles: [...(action.policy?.roles ?? [])].sort(),
  where: whereForm({ where: action.policy?.where }),
  target: action.target === undefined ? null : `${action.target.name}#${action.targetIdFrom ?? ''}`,
});

/** Read the whole live posture off the registry, sorted by action name (AC-8). */
export const actionPostures = ({ registry }: { registry: Registry }): ActionPosture[] =>
  registry
    .listActions()
    .map((action) => postureOf({ action }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** A parsed baseline file: the posture rows, who recorded them, what was refused. */
export interface Baseline {
  /** Who wrote the file — see {@link RecordedBy}. */
  recordedBy: RecordedBy;
  /** Model names considered and refused, sorted and de-duplicated (ONT-059). */
  excluded: string[];
  /** One row per action, sorted by name. */
  actions: ActionPosture[];
}

/** Sort and de-duplicate a deny-list so the file's bytes never depend on argv order. */
export const normalizeExclusions = ({ names }: { names: readonly string[] }): string[] =>
  [...new Set(names)].sort();

/** Render the baseline file's exact bytes — sorted, timestamp-free, newline-terminated. */
export const serializeBaseline = ({
  postures,
  recordedBy,
  excluded,
}: {
  postures: ActionPosture[];
  recordedBy: RecordedBy;
  excluded: string[];
}): string =>
  `${JSON.stringify(
    {
      version: BASELINE_VERSION,
      recordedBy,
      note: baselineNote({ recordedBy, postures, excluded }),
      excluded: normalizeExclusions({ names: excluded }),
      actions: postures,
    },
    null,
    2,
  )}\n`;

/** Whether a recorded value is a well-formed list of names (roles, exclusions). */
const isNameList = ({ value }: { value: unknown }): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const parseRow = ({ row }: { row: unknown }): ActionPosture => {
  const record = row as Record<string, unknown>;

  if (typeof record?.name !== 'string') {
    throw new Error('an action row is missing its `name`');
  }

  if (record.approval !== 'required' && record.approval !== null) {
    throw new Error(`action \`${record.name}\`: \`approval\` must be "required" or null`);
  }

  if (!isNameList({ value: record.roles })) {
    throw new Error(`action \`${record.name}\`: \`roles\` must be an array of strings`);
  }

  if (typeof record.where !== 'string' && record.where !== null) {
    throw new Error(`action \`${record.name}\`: \`where\` must be a string or null`);
  }

  if (typeof record.target !== 'string' && record.target !== null) {
    throw new Error(`action \`${record.name}\`: \`target\` must be a string or null`);
  }

  return {
    name: record.name,
    approval: record.approval,
    roles: [...(record.roles as string[])].sort(),
    where: record.where,
    target: record.target,
  };
};

/**
 * Parse a recorded baseline. Every failure throws: a corrupt or unreadable
 * baseline must surface as an error, never quietly degrade into "nothing to
 * compare against" — that downgrade is precisely the silence this module exists
 * to remove (AC-9).
 */
export const parseBaseline = ({ source }: { source: string }): Baseline => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  const document = parsed as {
    version?: unknown;
    recordedBy?: unknown;
    excluded?: unknown;
    actions?: unknown;
  };

  if (document?.version !== BASELINE_VERSION) {
    throw new Error(`unsupported \`version\` (expected ${BASELINE_VERSION})`);
  }

  if (!Array.isArray(document.actions)) {
    throw new Error('`actions` must be an array');
  }

  // A file written before ONT-059 carries no `excluded`, and an absent deny-list
  // is genuinely an empty one — so, like `recordedBy`, the field is added with no
  // version bump. A malformed one is a different matter and throws: reading a
  // broken deny-list as "nothing was refused" would resurrect the refused models
  // as proposals with `--accept-new` next to them, which is exactly the silence
  // this file exists to remove.
  if (document.excluded !== undefined && !isNameList({ value: document.excluded })) {
    throw new Error('`excluded` must be an array of model names');
  }

  // A file written before ONT-050 carries no `recordedBy`. It can only have come
  // from `--accept-governance`, so it reads as `sync` — upgrading never turns a
  // human's acknowledgement into an unreviewed one, and no version bump is
  // needed to add the field.
  if (
    document.recordedBy !== undefined &&
    document.recordedBy !== 'init' &&
    document.recordedBy !== 'sync'
  ) {
    throw new Error('`recordedBy` must be "init" or "sync"');
  }

  return {
    recordedBy: document.recordedBy === 'init' ? 'init' : 'sync',
    excluded: normalizeExclusions({ names: (document.excluded ?? []) as string[] }),
    actions: document.actions
      .map((row) => parseRow({ row }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

/**
 * Compare two role sets. Both sides treat empty as "any approver" — the widest
 * possible set — so `[]` -> `['admin']` narrows who may release a call and
 * `['admin']` -> `[]` widens it. Anything that is neither equality nor a strict
 * narrowing is not orderable and is read as widening.
 */
const rolesDirection = ({
  before,
  after,
}: {
  before: string[];
  after: string[];
}): 'same' | 'narrowed' | 'widened' => {
  const sameSet =
    before.length === after.length && before.every((role, index) => role === after[index]);

  if (sameSet) {
    return 'same';
  }

  if (before.length === 0) {
    return 'narrowed';
  }

  if (after.length === 0) {
    return 'widened';
  }

  const allowed = new Set(before);

  return after.every((role) => allowed.has(role)) ? 'narrowed' : 'widened';
};

const roleList = ({ roles }: { roles: string[] }): string =>
  roles.length === 0 ? 'any approver' : roles.join(', ');

/** Classify the differences on one action present in BOTH the baseline and the registry. */
const changesOnAction = ({
  before,
  after,
}: {
  before: ActionPosture;
  after: ActionPosture;
}): GovernanceChange[] => {
  const changes: GovernanceChange[] = [];
  const push = ({ direction, detail }: Omit<GovernanceChange, 'action'>): void => {
    changes.push({ action: after.name, direction, detail });
  };

  if (before.approval === 'required' && after.approval === null) {
    push({
      direction: 'weakened',
      detail:
        'approval gate removed — the baseline requires human approval, the ontology no longer does',
    });
  } else if (before.approval === null && after.approval === 'required') {
    push({ direction: 'strengthened', detail: 'approval gate added' });
  }

  if (before.where !== after.where) {
    if (after.where === null) {
      push({
        direction: 'weakened',
        detail: `\`where\` guard removed (was ${before.where})`,
      });
    } else if (before.where === null) {
      push({ direction: 'strengthened', detail: `\`where\` guard added (${after.where})` });
    } else {
      push({
        direction: 'weakened',
        detail: `\`where\` guard changed (was ${before.where}, now ${after.where}) — sync cannot prove the new guard is not weaker`,
      });
    }
  }

  const roles = rolesDirection({ before: before.roles, after: after.roles });

  if (roles === 'widened') {
    push({
      direction: 'weakened',
      detail: `approver roles widened (was ${roleList({ roles: before.roles })}, now ${roleList({ roles: after.roles })})`,
    });
  } else if (roles === 'narrowed') {
    push({
      direction: 'strengthened',
      detail: `approver roles narrowed (was ${roleList({ roles: before.roles })}, now ${roleList({ roles: after.roles })})`,
    });
  }

  if (before.target !== after.target) {
    if (after.target === null) {
      push({
        direction: 'weakened',
        detail: `target removed (was ${before.target}) — the action no longer names the row it governs`,
      });
    } else if (before.target === null) {
      push({ direction: 'strengthened', detail: `target added (${after.target})` });
    } else {
      push({
        direction: 'weakened',
        detail: `target changed (was ${before.target}, now ${after.target}) — the guard now resolves a different row`,
      });
    }
  }

  return changes;
};

/**
 * Diff a recorded baseline against the live posture. Pure — no I/O, no process
 * exit — so the direction table is testable as a table.
 */
export const diffGovernance = ({
  baseline,
  current,
}: {
  baseline: ActionPosture[];
  current: ActionPosture[];
}): GovernanceChange[] => {
  const recorded = new Map(baseline.map((posture) => [posture.name, posture]));
  const live = new Map(current.map((posture) => [posture.name, posture]));
  const changes: GovernanceChange[] = [];

  for (const posture of current) {
    const before = recorded.get(posture.name);

    if (before === undefined) {
      // A new action is new attack surface. Gated, that surface is governed and
      // the baseline is merely stale; un-gated, an executable tool just appeared
      // that no human ever signed off on.
      changes.push(
        posture.approval === 'required'
          ? {
              action: posture.name,
              direction: 'strengthened',
              detail: 'new approval-gated action, not in the recorded baseline',
            }
          : {
              action: posture.name,
              direction: 'weakened',
              detail: 'new action is NOT approval-gated and is not in the recorded baseline',
            },
      );
      continue;
    }

    changes.push(...changesOnAction({ before, after: posture }));
  }

  for (const posture of baseline) {
    if (!live.has(posture.name)) {
      // Removing an action removes exposure; it can never weaken governance.
      changes.push({
        action: posture.name,
        direction: 'strengthened',
        detail: 'action removed from the ontology — no longer exposed',
      });
    }
  }

  return changes.sort(
    (a, b) => a.action.localeCompare(b.action) || a.detail.localeCompare(b.detail),
  );
};

/** Where the baseline for a given project root lives. */
export const governancePath = ({ projectRoot }: { projectRoot: string }): string =>
  join(projectRoot, GOVERNANCE_FILE);

/**
 * What one project's live posture is worth against its recorded baseline.
 *
 * `no-actions` — nothing to vouch for, so a missing baseline is not a finding
 * (a read-only ontology is never nagged). `unrecorded` — there are actions and
 * no baseline: nothing on disk says which gates were ever intended.
 * `unreadable` — a baseline exists but could not be parsed; this must NEVER
 * degrade into "nothing to compare against", which is the exact silence the
 * check exists to remove. `verified` — a baseline was read and nothing weakened.
 * `weakened` — at least one action's posture is looser than the baseline.
 */
export type GovernanceState = 'no-actions' | 'unrecorded' | 'unreadable' | 'verified' | 'weakened';

/** The verdict every command shares: one read of the baseline, one classification. */
export interface GovernanceReview {
  state: GovernanceState;
  /** The live posture, ready to be recorded. */
  postures: ActionPosture[];
  /** Who recorded the baseline — absent unless one was read. */
  recordedBy?: RecordedBy;
  /** Every classified change; empty unless a baseline was read. */
  changes: GovernanceChange[];
  /** Action names whose posture weakened — exactly what the server withholds. */
  weakenedActions: string[];
  /** Model names recorded as refused; empty unless a baseline was read (ONT-059). */
  excluded: string[];
  /**
   * Recorded exclusions the live registry exposes as objects anyway — the file
   * says refused, the ontology says reachable.
   *
   * It is carried as its own field instead of a sixth {@link GovernanceState}
   * because it can co-occur with a weakened posture, and one state cannot say
   * both. `sync` and `status` fail on it; `orangerail mcp` deliberately does not
   * withhold over it — a weakened posture's likely cause is somebody deleting a
   * gate, while this one's likely cause is an operator who changed their mind and
   * has not pruned the file, and taking a running server's tools away over the
   * second is a different decision from ONT-050's.
   */
  exposedExclusions: string[];
  /** Why the baseline could not be read (`state === 'unreadable'`). */
  detail?: string;
}

/**
 * Read the baseline for `projectRoot` and classify the live registry against it.
 * It prints nothing and never exits, so `sync`, `status` and `mcp` each decide
 * what to do with the SAME verdict instead of re-deriving it three ways and
 * disagreeing — which is how the server came to claim a posture `sync` had
 * already reported as broken.
 */
export const reviewGovernance = ({
  projectRoot,
  registry,
}: {
  projectRoot: string;
  registry: Registry;
}): GovernanceReview => {
  const postures = actionPostures({ registry });
  const path = governancePath({ projectRoot });

  if (!existsSync(path)) {
    return {
      state: postures.length === 0 ? 'no-actions' : 'unrecorded',
      postures,
      changes: [],
      weakenedActions: [],
      excluded: [],
      exposedExclusions: [],
    };
  }

  let baseline: Baseline;
  try {
    baseline = parseBaseline({ source: readFileSync(path, 'utf8') });
  } catch (err) {
    return {
      state: 'unreadable',
      postures,
      changes: [],
      weakenedActions: [],
      excluded: [],
      exposedExclusions: [],
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const changes = diffGovernance({ baseline: baseline.actions, current: postures });
  const weakenedActions = [
    ...new Set(
      changes.filter((change) => change.direction === 'weakened').map((change) => change.action),
    ),
  ].sort();

  // Measured against the LIVE registry for the same reason the postures are: an
  // ontology file that is on disk but never imported exposes nothing, and one
  // that is imported exposes its object whatever the generated file set says.
  const exposed = new Set(registry.listObjects().map((object) => object.name));

  return {
    state: weakenedActions.length > 0 ? 'weakened' : 'verified',
    postures,
    recordedBy: baseline.recordedBy,
    changes,
    weakenedActions,
    excluded: baseline.excluded,
    exposedExclusions: baseline.excluded.filter((name) => exposed.has(name)),
  };
};

/** Write the baseline for `projectRoot`; throws with the path on failure. */
export const writeBaseline = ({
  projectRoot,
  postures,
  recordedBy,
  excluded,
}: {
  projectRoot: string;
  postures: ActionPosture[];
  recordedBy: RecordedBy;
  /** The deny-list to record. Callers re-recording a posture pass the one they read. */
  excluded: string[];
}): string => {
  const path = governancePath({ projectRoot });

  writeFileSync(path, serializeBaseline({ postures, recordedBy, excluded }), 'utf8');

  return path;
};

/**
 * True when the baseline exists but nobody has vouched for it — the state a
 * project is in between `orangerail init` and its first
 * `orangerail sync --accept-governance`.
 *
 * Surfacing this on every readout is the price of having `init` write the file
 * at all: a baseline that exists is a baseline people stop looking at, so the
 * one thing it must never do is read as "a human approved this".
 */
export const isUnreviewed = ({ review }: { review: GovernanceReview }): boolean =>
  review.recordedBy === 'init';

/**
 * The one sentence every readout uses for a recorded exclusion the ontology
 * exposes. Shared so `sync` and `status` cannot describe the same contradiction
 * in two ways that a reader would take for two different findings.
 */
export const exposedExclusionDetail = ({ name }: { name: string }): string =>
  `${name} is recorded as excluded in ${GOVERNANCE_FILE}, but the ontology exposes it — ` +
  `remove ontology/${name}.mjs and the actions targeting it, or drop "${name}" from the ` +
  '`excluded` list to admit it deliberately.';

/**
 * A read-only view of `registry` with `names` withheld: those actions are absent
 * from `listActions()` and unresolvable through `getAction()`.
 *
 * The second half is what makes it a refusal rather than a cosmetic filter — the
 * MCP server builds its tool list from `listActions()`, but core's engine
 * resolves the action by name on `stage` and again on `complete`, so hiding the
 * tool alone would still execute for a client that already knew the name.
 * A withheld action cannot be staged, and an approval staged for one before the
 * drift cannot be completed while the drift stands.
 *
 * Objects, links and read tools are untouched: the blast radius of the refusal
 * is exactly the set of actions whose posture moved.
 */
export const withholdActions = ({
  registry,
  names,
}: {
  registry: Registry;
  names: ReadonlySet<string>;
}): Registry => ({
  ...registry,
  getAction: ({ name }: { name: string }) =>
    names.has(name) ? undefined : registry.getAction({ name }),
  listActions: () => registry.listActions().filter((action) => !names.has(action.name)),
});
