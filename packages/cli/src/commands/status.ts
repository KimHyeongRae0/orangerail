import { verifyAudit } from 'orangerail-core';

import type { OrangerailConfig } from '../config';
import {
  formatServerLiveness,
  heartbeatPathForStore,
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
   * Liveness of an `orangerail mcp` server serving this store. This is a live
   * signal (a heartbeat file written by the serving process), NOT a re-derived
   * claim — the other fields describe what governance WOULD do, this one proves
   * whether a server is actually up to enforce it.
   */
  server: ServerLiveness;
}

/** Gather the current governance posture from the config's registry and store. */
export const computeStatus = async ({
  config,
}: {
  config: OrangerailConfig;
}): Promise<StatusReport> => {
  const actions = config.registry.listActions();
  const gatedCount = actions.filter((action) => action.policy?.approval === 'required').length;
  const preset = config.preset ?? 'approval-for-writes';

  const audit = await verifyAudit({ store: config.store });
  const pending = await config.store.listPending();

  const server = readServerLiveness({ path: heartbeatPathForStore({ store: config.store }) });

  return {
    objectCount: config.registry.listObjects().length,
    gatedCount,
    autoCount: actions.length - gatedCount,
    preset,
    readOnly: preset === 'readonly',
    audit: { ok: audit.ok, count: audit.count, issues: audit.issues },
    pendingCount: pending.length,
    server,
  };
};

/**
 * A single-line confidence signal for the MCP server startup (written to
 * stderr, never stdout — stdout is the JSON-RPC channel). A broken audit chain
 * is surfaced loudly rather than hidden behind an "active" claim.
 */
export const formatStatusLine = ({ report }: { report: StatusReport }): string => {
  if (!report.audit.ok) {
    return `orangerail: governance active, but AUDIT CHAIN FAILED (${report.audit.issues.length} issue(s)) — run 'orangerail audit verify'`;
  }

  const gate = report.readOnly
    ? 'read-only (no write tools exposed)'
    : `${report.gatedCount} action(s) approval-gated`;
  const pending = report.pendingCount > 0 ? ` · ${report.pendingCount} pending approval(s)` : '';

  return `orangerail: governance active · ${gate} · audit chain OK (${report.audit.count} record(s))${pending}`;
};

/**
 * `orangerail status` — the human-readable governance readout. Answers "is this
 * actually protecting me right now?" without a live dashboard: what is gated,
 * whether the audit chain verifies, and what is pending. Exits non-zero when the
 * audit chain is broken so scripts can gate on it.
 */
export const runStatus = async ({ config }: { config: OrangerailConfig }): Promise<number> => {
  const report = await computeStatus({ config });
  const out = process.stdout;

  out.write('orangerail status\n');
  out.write(`  objects:  ${report.objectCount}\n`);
  out.write(`  actions:  ${report.gatedCount} approval-gated, ${report.autoCount} auto\n`);
  out.write(`  preset:   ${report.preset}${report.readOnly ? ' (writes not exposed)' : ''}\n`);
  out.write(`  pending:  ${report.pendingCount} approval(s) awaiting a decision\n`);
  out.write(`  server:   ${formatServerLiveness({ server: report.server })}\n`);

  if (report.audit.ok) {
    out.write(`  audit:    chain OK — ${report.audit.count} record(s) verified\n`);
    return 0;
  }

  out.write(
    `  audit:    FAILED — ${report.audit.count} record(s), ${report.audit.issues.length} issue(s):\n`,
  );
  for (const issue of report.audit.issues) {
    out.write(`              - ${issue}\n`);
  }

  return 1;
};
