import {
  canonicalJson,
  type Registry,
  type RuntimeAction,
  type WhereClause,
} from 'orangerail-core';

/**
 * The governance side of `orangerail sync` (ONT-043). `diff.ts` answers "does the
 * ontology still match the scanned source?"; this module answers the question the
 * scan structurally cannot: "is the ontology still governed the way it was when a
 * human last looked at it?".
 *
 * The scanner has no opinion on policy — it always proposes
 * `approval: 'required'` and the user owns every edit afterwards — so a
 * scan-vs-ontology diff cannot express a policy change at all. The comparison
 * therefore runs against a RECORDED baseline: `orangerail.governance.json` at the
 * repo root, written only by `orangerail sync --accept-governance`. That file is
 * meant to be committed, so a pull request that un-gates an action shows
 * `"approval": "required"` turning into `null` in its own diff.
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
 */

/** The baseline filename, at the repo root next to `orangerail.config.mjs`. */
export const GOVERNANCE_FILE = 'orangerail.governance.json';

/** The recorded baseline's schema version — a mismatch is an error, not a downgrade. */
const BASELINE_VERSION = 1;

/** The line written into the baseline so someone who finds the file knows what it is. */
const BASELINE_NOTE =
  'Governance baseline recorded by orangerail. `orangerail sync` reports and fails when the ' +
  'posture of an action weakens against these rows. Commit this file; re-record it with ' +
  '`orangerail sync --accept-governance` after an intentional policy change.';

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

/** Render the baseline file's exact bytes — sorted, timestamp-free, newline-terminated. */
export const serializeBaseline = ({ postures }: { postures: ActionPosture[] }): string =>
  `${JSON.stringify({ version: BASELINE_VERSION, note: BASELINE_NOTE, actions: postures }, null, 2)}\n`;

/** Whether a recorded `roles` value is a well-formed list of role names. */
const isRoleList = ({ value }: { value: unknown }): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const parseRow = ({ row }: { row: unknown }): ActionPosture => {
  const record = row as Record<string, unknown>;

  if (typeof record?.name !== 'string') {
    throw new Error('an action row is missing its `name`');
  }

  if (record.approval !== 'required' && record.approval !== null) {
    throw new Error(`action \`${record.name}\`: \`approval\` must be "required" or null`);
  }

  if (!isRoleList({ value: record.roles })) {
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
export const parseBaseline = ({ source }: { source: string }): ActionPosture[] => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  const document = parsed as { version?: unknown; actions?: unknown };

  if (document?.version !== BASELINE_VERSION) {
    throw new Error(`unsupported \`version\` (expected ${BASELINE_VERSION})`);
  }

  if (!Array.isArray(document.actions)) {
    throw new Error('`actions` must be an array');
  }

  return document.actions
    .map((row) => parseRow({ row }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
