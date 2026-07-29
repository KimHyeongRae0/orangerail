import { verifyAudit } from 'orangerail-core';

import type { OrangerailConfig } from '../config';
import {
  GOVERNANCE_FILE,
  isUnreviewed,
  reviewGovernance,
  type GovernanceReview,
} from '../governance';
import {
  formatServerLiveness,
  heartbeatDirForStore,
  readServerLiveness,
  type ServerLiveness,
} from '../server-heartbeat';

/**
 * The runtime governance posture, gathered from the declared registry and the
 * live store. This is the "confidence signal" a first-run operator needs: proof
 * that governance is actually wired (how many actions are approval-gated), that
 * the audit chain verifies, and whether anything is waiting on a human. Shared
 * by `orangerail status` (the readout) and the MCP server's startup line.
 */
export interface StatusReport {
  /** Declared object types (each with a read contract becomes read tools). */
  objectCount: number;
  /** Actions whose policy requires human approval before they execute. */
  gatedCount: number;
  /** Actions that auto-execute (no approval policy). */
  autoCount: number;
  /** The effective MCP preset (defaults to `approval-for-writes`). */
  preset: string;
  /** `true` when the preset exposes no write tools at all (`readonly`). */
  readOnly: boolean;
  /** Audit-chain verdict: tamper/orphan check plus the record count. */
  audit: { ok: boolean; count: number; issues: string[] };
  /** Approvals staged and awaiting a human decision. */
  pendingCount: number;
  /**
   * Liveness of the `orangerail mcp` server(s) serving this store. This is a
   * live signal (a per-server heartbeat entry written by each serving process),
   * NOT a re-derived claim — the other fields describe what governance WOULD
   * do, this one proves whether a server is actually up to enforce it. It
   * aggregates every server sharing the store, so one shutting down never hides
   * another that is still enforcing.
   */
  server: ServerLiveness;
  /**
   * How the live posture stands against `orangerail.governance.json`.
   *
   * Without it the counts above are self-reported and unfalsifiable: an
   * ontology whose gate someone deleted reports `18 approval-gated, 1 auto`
   * with total confidence, and every word of it is true — the readout simply
   * has no way to say that one of those numbers moved for the worse. The
   * baseline is the only thing on disk that can.
   */
  governance: GovernanceReview;
  /**
   * Actions this readout describes but a server would NOT serve, because their
   * posture is weaker than the baseline. Empty unless `governance.state` is
   * `weakened`.
   */
  withheld: string[];
}

/** Gather the current governance posture from the config's registry and store. */
export const computeStatus = async ({
  config,
  projectRoot,
  governance: reviewed,
}: {
  config: OrangerailConfig;
  /** Where `orangerail.governance.json` lives; defaults to the cwd. */
  projectRoot?: string | undefined;
  /**
   * A verdict already computed against the DECLARED registry. `orangerail mcp`
   * passes one because the config it hands us has the weakened actions already
   * withheld — reviewing that filtered registry would read the withheld action
   * as "removed from the ontology" and report a clean baseline, which is the
   * self-reporting lie this whole change exists to remove.
   */
  governance?: GovernanceReview | undefined;
}): Promise<StatusReport> => {
  const actions = config.registry.listActions();
  const gatedCount = actions.filter((action) => action.policy?.approval === 'required').length;
  const preset = config.preset ?? 'approval-for-writes';

  const audit = await verifyAudit({ store: config.store });
  const pending = await config.store.listPending();

  const server = readServerLiveness({ dir: heartbeatDirForStore({ store: config.store }) });
  const governance =
    reviewed ??
    reviewGovernance({
      projectRoot: projectRoot ?? process.cwd(),
      registry: config.registry,
    });

  return {
    objectCount: config.registry.listObjects().length,
    gatedCount,
    autoCount: actions.length - gatedCount,
    preset,
    readOnly: preset === 'readonly',
    audit: { ok: audit.ok, count: audit.count, issues: audit.issues },
    pendingCount: pending.length,
    server,
    governance,
    withheld: governance.weakenedActions,
  };
};

/**
 * The governance clause of the startup line — short by necessity (it shares one
 * line with the audit chain and the pending count), and never absent when it
 * would change how the rest of the line should be read.
 */
const governanceClause = ({ report }: { report: StatusReport }): string => {
  switch (report.governance.state) {
    case 'weakened':
      return ` · GOVERNANCE DRIFT: ${report.withheld.length} action(s) WITHHELD (weaker than ${GOVERNANCE_FILE}: ${report.withheld.join(', ')}) — run 'orangerail sync'`;
    case 'unreadable':
      return ` · ${GOVERNANCE_FILE} UNREADABLE — the posture above is unverified`;
    case 'unrecorded':
      return ' · no governance baseline recorded — the posture above is unverified';
    case 'verified':
      return isUnreviewed({ review: report.governance })
        ? ' · baseline recorded by init, not yet reviewed'
        : ' · matches the recorded baseline';
    case 'no-actions':
      return '';
  }
};

/**
 * A single-line confidence signal for the MCP server startup (written to
 * stderr, never stdout — stdout is the JSON-RPC channel). It leads with
 * `serving` because the caller prints it once the process is up and the
 * liveness heartbeat is written, so a first-run operator sees the server is
 * genuinely running, not just configured. A broken audit chain is surfaced
 * loudly rather than hidden behind a reassuring claim.
 */
export const formatStatusLine = ({ report }: { report: StatusReport }): string => {
  if (!report.audit.ok) {
    // The governance clause rides along even here: a broken chain and a weakened
    // posture are different failures, and swallowing one because the other is
    // louder is how a readout ends up telling half the truth.
    return `orangerail mcp: serving, but AUDIT CHAIN FAILED (${report.audit.issues.length} issue(s)) — run 'orangerail audit verify'${governanceClause({ report })}`;
  }

  const gate = report.readOnly
    ? 'read-only (no write tools exposed)'
    : `${report.gatedCount} action(s) approval-gated`;
  const pending = report.pendingCount > 0 ? ` · ${report.pendingCount} pending approval(s)` : '';

  return `orangerail mcp: serving · governance active · ${gate}${governanceClause({ report })} · audit chain OK (${report.audit.count} record(s))${pending}`;
};

/**
 * The `baseline:` block of the readout. It is written next to the action counts
 * because it is the only line that can qualify them: `18 approval-gated, 1 auto`
 * is a true sentence about an ontology someone just un-gated, and on its own it
 * reads like health.
 */
const writeBaselineBlock = ({ report }: { report: StatusReport }): void => {
  const out = process.stdout;
  const review = report.governance;

  if (review.state === 'no-actions') {
    out.write('  baseline: not needed — this ontology declares no actions\n');
    return;
  }

  if (review.state === 'unrecorded') {
    out.write(
      `  baseline: NONE — ${GOVERNANCE_FILE} does not exist, so nothing on disk says which of the\n` +
        '            gates above were ever intended. Run `orangerail sync --accept-governance`.\n',
    );
    return;
  }

  if (review.state === 'unreadable') {
    out.write(
      `  baseline: UNREADABLE — ${GOVERNANCE_FILE} could not be parsed (${review.detail ?? 'unknown'}),\n` +
        '            so the posture above is unverified. Restore it from version control.\n',
    );
    return;
  }

  if (review.state === 'weakened') {
    out.write(
      `  baseline: DRIFTED — ${report.withheld.length} action(s) are weaker than ${GOVERNANCE_FILE}:\n`,
    );
    for (const change of review.changes.filter((entry) => entry.direction === 'weakened')) {
      out.write(`              - ${change.action}: ${change.detail}\n`);
    }
    out.write(
      '            `orangerail mcp` withholds these until the baseline is re-recorded with\n' +
        '            `orangerail sync --accept-governance`.\n',
    );
    return;
  }

  out.write(
    isUnreviewed({ review })
      ? `  baseline: ${review.postures.length} action(s) recorded by \`orangerail init\` and unchanged since —\n` +
          '            nobody has reviewed it yet. `orangerail sync --accept-governance` vouches for it.\n'
      : `  baseline: ${review.postures.length} action(s) match ${GOVERNANCE_FILE}\n`,
  );
};

/**
 * `orangerail status` — the human-readable governance readout. Answers "is this
 * actually protecting me right now?" without a live dashboard: what is gated,
 * whether that still matches the baseline, whether the audit chain verifies, and
 * what is pending.
 *
 * Exit codes: **0** when nothing on the readout is actively wrong, **1** when
 * something is — a broken audit chain, or a posture weaker than the recorded
 * baseline. An absent or unreviewed baseline is reported but is not an error:
 * `status` describes the project, `sync` is the gate that insists on one.
 */
export const runStatus = async ({
  config,
  projectRoot,
}: {
  config: OrangerailConfig;
  projectRoot?: string | undefined;
}): Promise<number> => {
  const report = await computeStatus({ config, projectRoot });
  const out = process.stdout;

  out.write('orangerail status\n');
  out.write(`  objects:  ${report.objectCount}\n`);
  out.write(`  actions:  ${report.gatedCount} approval-gated, ${report.autoCount} auto\n`);
  writeBaselineBlock({ report });
  out.write(`  preset:   ${report.preset}${report.readOnly ? ' (writes not exposed)' : ''}\n`);
  out.write(`  pending:  ${report.pendingCount} approval(s) awaiting a decision\n`);
  out.write(`  server:   ${formatServerLiveness({ server: report.server })}\n`);

  if (report.audit.ok) {
    out.write(`  audit:    chain OK — ${report.audit.count} record(s) verified\n`);

    // A weakened posture is the one finding on this readout that the numbers
    // above cannot express, so it owns the exit code the same way a broken
    // chain does.
    return report.governance.state === 'weakened' ? 1 : 0;
  }

  // The FAILURE goes to STDERR, not stdout: `orangerail status >/dev/null` used
  // to erase the one finding on this readout that must never be missed, leaving
  // only a silent exit 1. A diagnostic an operator can silence by redirecting is
  // a diagnostic they will miss. The healthy readout above stays on stdout so
  // scripts that capture it are unaffected.
  const err = process.stderr;

  err.write(
    `  audit:    FAILED — ${report.audit.count} record(s), ${report.audit.issues.length} issue(s):\n`,
  );
  for (const issue of report.audit.issues) {
    err.write(`              - ${issue}\n`);
  }

  return 1;
};
