import { verifyAudit } from 'orangerail-core';

import type { OrangerailConfig } from '../config';
import { reviewCoreSkew, type CoreSkewReview } from '../core-skew';
import {
  exposedExclusionDetail,
  GOVERNANCE_FILE,
  isUnreviewed,
  reviewGovernance,
  type GovernanceReview,
} from '../governance';
import {
  hostSurveyBlock,
  hostSurveyClause,
  surveyHostConfigs,
  type HostSurveyReview,
} from '../host-mcp';
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
  /**
   * Whether the `orangerail-core` this config imports is the one the CLI runs
   * on (ONT-058).
   *
   * It sits on this report because it qualifies every other field the same way
   * the baseline does. A skewed project reports its gates, its clean chain and
   * its pending queue perfectly accurately and cannot complete a single write —
   * the numbers are not wrong, they are describing a machine with a seam
   * through the middle of it, and nothing else on the readout can say so.
   */
  skew: CoreSkewReview;
  /**
   * What else the agent has mounted next to this project (ONT-060).
   *
   * It sits on this report for the same reason the skew verdict does: it
   * qualifies every other field. The counts, the baseline and the chain all
   * describe the surface orangerail declares, and the claim a reader takes from
   * them is that this IS the agent's surface. While another server is mounted
   * beside us that claim is false, and nothing else on this report can say so —
   * a call to a foreign tool is not a weakened posture, not a chain failure and
   * not a pending approval, it is an event this project never sees at all.
   */
  hosts: HostSurveyReview;
}

/** Gather the current governance posture from the config's registry and store. */
export const computeStatus = async ({
  config,
  projectRoot,
  governance: reviewed,
  skew: skewed,
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
  /**
   * Likewise already computed against the DECLARED registry, and for a sharper
   * reason: the withheld-actions wrapper is an object THIS package builds, so
   * it carries no core instance mark at all. Re-deriving the skew from it would
   * report every drifted project as version-skewed — a false alarm produced by
   * the very filtering that is supposed to be the safe response to drift.
   */
  skew?: CoreSkewReview | undefined;
}): Promise<StatusReport> => {
  const actions = config.registry.listActions();
  const gatedCount = actions.filter((action) => action.policy?.approval === 'required').length;
  const preset = config.preset ?? 'approval-for-writes';

  const audit = await verifyAudit({ store: config.store });
  const pending = await config.store.listPending();

  // Anchored on the project root rather than the cwd, exactly as the governance
  // baseline is: `--config /elsewhere/orangerail.config.mjs` must survey the
  // project being described, not the directory the command was typed in.
  const root = projectRoot ?? process.cwd();

  const server = readServerLiveness({ dir: heartbeatDirForStore({ store: config.store }) });
  const governance =
    reviewed ??
    reviewGovernance({
      projectRoot: root,
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
    skew: skewed ?? reviewCoreSkew({ config }),
    hosts: surveyHostConfigs({ projectRoot: root }),
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
 * The exposed-exclusion clause. `orangerail mcp` does not withhold over this
 * (ONT-059), so the startup line is the only place the operator learns that the
 * server they just launched is serving a table the committed record says was
 * refused. A refusal the product enforces nowhere and mentions nowhere would be
 * a worse fiction than not recording it.
 */
const exclusionClause = ({ report }: { report: StatusReport }): string => {
  const exposed = report.governance.exposedExclusions;

  return exposed.length === 0
    ? ''
    : ` · SERVING ${exposed.length} EXCLUDED model(s) (${exposed.join(', ')}) — ${GOVERNANCE_FILE} records them as refused`;
};

/**
 * The core-skew clause. Short, and present on every variant of the line for the
 * same reason the governance clause is: a line that reports a healthy chain and
 * live gates on a project that cannot complete a write is telling half the
 * truth, and the half it tells is the reassuring one. The detail is in the
 * block written above this line — the clause exists so the line itself never
 * reads as an all-clear.
 */
const skewClause = ({ report }: { report: StatusReport }): string => {
  switch (report.skew.state) {
    case 'stale':
      return ' · CORE VERSION SKEW — no governed write can complete (see above)';
    case 'duplicated':
      return ' · two copies of orangerail-core loaded';
    // `unverifiable` is this CLI's own core being older than the marker. There
    // is no finding to report, only an absent capability, and a line about a
    // check that did not run is not a confidence signal.
    case 'unverifiable':
    case 'aligned':
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
    return `orangerail mcp: serving, but AUDIT CHAIN FAILED (${report.audit.issues.length} issue(s)) — run 'orangerail audit verify'${governanceClause({ report })}${exclusionClause({ report })}${skewClause({ report })}${hostSurveyClause({ review: report.hosts })}`;
  }

  const gate = report.readOnly
    ? 'read-only (no write tools exposed)'
    : `${report.gatedCount} action(s) approval-gated`;
  const pending = report.pendingCount > 0 ? ` · ${report.pendingCount} pending approval(s)` : '';

  return `orangerail mcp: serving · governance active · ${gate}${governanceClause({ report })}${exclusionClause({ report })} · audit chain OK (${report.audit.count} record(s))${pending}${skewClause({ report })}${hostSurveyClause({ review: report.hosts })}`;
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
 * The `excluded:` block — which models were refused, and whether the ontology
 * agrees.
 *
 * It is on this readout because the deny-list is part of what the agent can
 * reach, and the counts above cannot express it: an ontology serving a table the
 * committed record says was refused reports perfectly healthy numbers, and the
 * numbers are correct. Silent when nothing was refused — a line about an empty
 * list on every run is what trains an operator to skip the block.
 */
const writeExclusionBlock = ({ report }: { report: StatusReport }): void => {
  const review = report.governance;

  if (review.excluded.length === 0) {
    return;
  }

  const out = process.stdout;

  out.write(
    `  excluded: ${review.excluded.length} model(s) refused — ${review.excluded.join(', ')}\n`,
  );

  for (const name of review.exposedExclusions) {
    out.write(`            EXPOSED — ${exposedExclusionDetail({ name })}\n`);
  }
};

/**
 * The `runtime:` block — which `orangerail-core` is actually loaded (ONT-058).
 *
 * It is printed ABOVE the counts, unlike the baseline block, because it is the
 * one finding that decides whether the counts describe a working machine at
 * all. A drifted baseline still executes; a skewed core executes nothing, and
 * the readout under it is a list of correct facts about something that does not
 * run. Silent when there is nothing to say — a `runtime: ok` line on every run
 * is noise that trains an operator to skip the block.
 */
const writeRuntimeBlock = ({ report }: { report: StatusReport }): void => {
  const out = process.stdout;

  if (report.skew.state === 'stale') {
    out.write(
      '  runtime:  CORE VERSION SKEW — this config imports an orangerail-core older than the CLI\n' +
        '            running it. Approvals that core creates carry no inputHash, and this CLI refuses\n' +
        '            to execute an approval it cannot bind to its payload: staging and approving will\n' +
        '            keep succeeding and NO GOVERNED WRITE WILL COMPLETE. Install orangerail-core at\n' +
        "            this CLI's version and re-stage anything pending. If you did not just upgrade,\n" +
        '            the two are resolving from different node_modules — dedupe the project install.\n',
    );
    return;
  }

  if (report.skew.state === 'duplicated') {
    out.write(
      '  runtime:  two copies of orangerail-core are loaded (one by this config, one by the CLI).\n' +
        '            They agree on the approval contract, so writes work — until a partial upgrade\n' +
        '            makes them disagree, at which point governed writes stop silently. Dedupe.\n',
    );
  }
};

/**
 * `orangerail status` — the human-readable governance readout. Answers "is this
 * actually protecting me right now?" without a live dashboard: what is gated,
 * whether that still matches the baseline, whether the audit chain verifies, and
 * what is pending.
 *
 * Exit codes: **0** when nothing on the readout is actively wrong, **1** when
 * something is — a broken audit chain, a posture weaker than the recorded
 * baseline, or a core version skew. An absent or unreviewed baseline is
 * reported but is not an error: `status` describes the project, `sync` is the
 * gate that insists on one. A DUPLICATED core is likewise reported and not an
 * error — writes complete today, and failing a health check over a latent
 * hazard is how a health check stops being run.
 *
 * An ungoverned MCP server mounted alongside (ONT-060) is reported loudly and is
 * likewise **not** an error. The other two exit-1 findings are defects IN this
 * project that orangerail can name and the operator must fix; a foreign server
 * is a deliberate, often legitimate configuration choice — mounting a Slack
 * server next to orangerail is ordinary — and it is one this command may not
 * even fully see, since it reads project scope only. Failing a health check on a
 * normal setup is the same mistake as banner-on-every-start, and the loudness
 * belongs in the wording instead. The narrow claim being made is only "these
 * tools are outside this project's governance", never "unsafe".
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
  writeRuntimeBlock({ report });
  out.write(`  objects:  ${report.objectCount}\n`);
  out.write(`  actions:  ${report.gatedCount} approval-gated, ${report.autoCount} auto\n`);
  writeBaselineBlock({ report });
  writeExclusionBlock({ report });
  out.write(`  preset:   ${report.preset}${report.readOnly ? ' (writes not exposed)' : ''}\n`);
  out.write(`  pending:  ${report.pendingCount} approval(s) awaiting a decision\n`);
  out.write(`  server:   ${formatServerLiveness({ server: report.server })}\n`);

  // Below the project's own lines and above the audit verdict, because it is the
  // one block describing something OUTSIDE this project: it qualifies everything
  // above it rather than being another of its properties. Always printed — "we
  // found no host config" is a limit on this readout, not an all-clear (see
  // `hostSurveyBlock`).
  out.write(hostSurveyBlock({ review: report.hosts }));

  if (report.audit.ok) {
    out.write(`  audit:    chain OK — ${report.audit.count} record(s) verified\n`);

    // A weakened posture, a stale core and an exposed exclusion are the findings
    // on this readout that the numbers above cannot express, so they own the
    // exit code the same way a broken chain does.
    return report.governance.state === 'weakened' ||
      report.governance.exposedExclusions.length > 0 ||
      report.skew.state === 'stale'
      ? 1
      : 0;
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
