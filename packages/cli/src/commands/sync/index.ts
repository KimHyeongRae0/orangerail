import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadConfig, resolveConfigPath } from '../../config';
import {
  GOVERNANCE_FILE,
  isUnreviewed,
  reviewGovernance,
  writeBaseline,
  type GovernanceReview,
} from '../../governance';
import { emitActionFile } from '../init/codegen/emit-action';
import { emitObjectFile } from '../init/codegen/emit-object';
import type { IrAction } from '../init/ir';
import { scanRepo } from '../init/scan';
import { diffSync, type SyncDiff } from './diff';

/**
 * `orangerail sync` (plan D11). Loads the config (registry = source of truth),
 * re-scans the repo, and reports drift: new models/actions as PROPOSALS (a file
 * is written only under `--accept-new`), changed/added/removed fields, ontology
 * files outside the discovery convention, and a governance posture that no
 * longer matches the recorded baseline. It performs zero edits to existing files
 * and never merges (§5.1.5).
 *
 * ## The exit-code contract (ONT-050)
 *
 * - **0** — the run answered the question and found nothing to act on. Only
 *   `info:` lines may have been printed.
 * - **1** — drift: at least one finding this run did not resolve.
 * - **2** — the run could not answer the question at all: the config would not
 *   load, the baseline could not be read, or the baseline could not be written.
 *
 * Every drift class is counted into ONE {@link SyncFindings} record and the code
 * is derived from it by {@link isDrift}, so no branch can disagree with the
 * report above it. That is not decoration: `sync` used to print
 * `unregistered ontology file: ontology/stray.ts` — a file holding governed
 * actions that the loader never imports — and then `ontology is in sync with
 * your sources`, exit 0.
 *
 * On top of the scan-vs-registry diff it reviews the GOVERNANCE POSTURE against
 * the recorded baseline (ONT-043, `../../governance.ts`). The scan has no
 * opinion on policy, so removing `policy: { approval: 'required' }` from a
 * hand-owned `ontology/*.mjs` used to pass as "in sync" — the one edit that
 * disarms the product went unreported. `--accept-governance` re-records the
 * baseline as the human acknowledgement of a deliberate change.
 */

const ONTOLOGY_DIR = 'ontology';

/**
 * Report ontology files that the discovery convention does not pick up and the
 * config does not import by name (plan D11 membership rule): a `*.mjs` file is
 * registered by convention; any other extension must be explicitly mentioned in
 * the config source, otherwise it is warned as unregistered (§4 discovery
 * model). This un-flags the documented hand-written-`.ts` explicit-import path.
 */
const reportUnregistered = ({ cwd }: { cwd: string }): string[] => {
  const dir = join(cwd, ONTOLOGY_DIR);
  if (!existsSync(dir)) {
    return [];
  }

  const configNames = ['orangerail.config.mjs', 'orangerail.config.js'];
  const configSource = configNames
    .map((name) => join(cwd, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  const warnings: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) {
      continue;
    }

    const registered = entry.name.endsWith('.mjs') || configSource.includes(entry.name);

    if (!registered) {
      warnings.push(
        `unregistered ontology file: ${ONTOLOGY_DIR}/${entry.name} — not picked up by the discovery convention (\`*.mjs\`) and not imported by the config. Rename it to \`.mjs\` or import it explicitly.`,
      );
    }
  }

  return warnings;
};

/**
 * Where a proposed action came from, in the vocabulary of its own scanner.
 * `method`/`path` exist on OpenAPI actions only, so interpolating them
 * unconditionally printed `(from undefined undefined)` for every Prisma-derived
 * proposal; the Prisma branch states the real operation and model instead.
 */
const actionOrigin = ({ action }: { action: IrAction }): string => {
  if (action.source === 'prisma' && action.prisma !== undefined) {
    return `Prisma ${action.prisma.op} on ${action.prisma.model}`;
  }

  return action.method !== undefined && action.path !== undefined
    ? `from ${action.method} ${action.path}`
    : 'source unknown';
};

/** What the scan-vs-registry report found, split by whether `--accept-new` can resolve it. */
interface ScanReport {
  /** New models/actions — resolvable by `--accept-new`. */
  proposals: number;
  /** Field-level drift on existing objects — never resolvable by writing new files. */
  fieldDrift: number;
}

/** Print the human-readable drift report; returns what it found. */
const printReport = ({ diff }: { diff: SyncDiff }): ScanReport => {
  for (const object of diff.newObjects) {
    process.stdout.write(
      `proposal: new model ${object.name} (run \`orangerail sync --accept-new\` to create ontology/${object.name}.mjs)\n`,
    );
  }

  for (const action of diff.newActions) {
    process.stdout.write(`proposal: new action ${action.name} (${actionOrigin({ action })})\n`);
  }

  for (const fieldDrift of diff.fieldDrifts) {
    process.stdout.write(
      `drift: ${fieldDrift.object}.${fieldDrift.field} ${fieldDrift.kind} — ${fieldDrift.detail}\n`,
    );
  }

  for (const name of diff.registryOnlyObjects) {
    process.stdout.write(
      `info: ${name} is in your ontology but not the source (user-owned extension)\n`,
    );
  }

  return {
    proposals: diff.newObjects.length + diff.newActions.length,
    fieldDrift: diff.fieldDrifts.length,
  };
};

/**
 * Print the governance section of the report and return how many findings in it
 * are DRIFT. `--accept-governance` resolves every governance finding by
 * definition (the run is re-recording the posture as the reviewed one), so it
 * reports zero — but it still prints what it is accepting, so an
 * acknowledgement is never silent.
 */
const printGovernance = ({
  review,
  recording,
}: {
  review: GovernanceReview;
  /** Whether this run is about to re-record the baseline (`--accept-governance`). */
  recording: boolean;
}): number => {
  const out = process.stdout;

  for (const change of review.changes) {
    out.write(
      change.direction === 'weakened'
        ? `governance: ${change.action} — ${change.detail}\n`
        : `info: governance ${change.action} — ${change.detail}\n`,
    );
  }

  if (review.state === 'weakened' && !recording) {
    out.write(
      `            \`orangerail mcp\` will refuse to serve ${review.weakenedActions.length} action(s): ${review.weakenedActions.join(', ')}.\n` +
        '            Intentional? Re-record the baseline with `orangerail sync --accept-governance`.\n',
    );

    if (review.postures.some((posture) => posture.where === 'functional')) {
      out.write(
        '            Note: a functional `where` predicate is opaque to this check — its body is never compared.\n',
      );
    }
  }

  if (review.state === 'unrecorded' && !recording) {
    out.write(
      `governance: no recorded baseline — ${GOVERNANCE_FILE} is missing, so sync cannot tell whether the gates on your ${review.postures.length} action(s) still match what a human approved.\n` +
        `            Review \`orangerail status\`, then run \`orangerail sync --accept-governance\` to record it (commit the file).\n`,
    );
  }

  // Recorded but never reviewed: `init` wrote the posture it generated. That is
  // a real baseline — drift against it is detected from the first run — but it
  // is not an approval, and a readout that let it pass for one would be the
  // whole reason ONT-043 declined to write the file at all.
  if (isUnreviewed({ review }) && !recording) {
    out.write(
      `info: governance baseline was recorded by \`orangerail init\` — it is the posture init generated, which nobody has reviewed yet.\n` +
        `      Read ${GOVERNANCE_FILE}, then run \`orangerail sync --accept-governance\` to vouch for it.\n`,
    );
  }

  if (recording) {
    return 0;
  }

  return review.state === 'weakened' || review.state === 'unrecorded' ? 1 : 0;
};

/** What `--accept-new` managed to materialize, and what it could not. */
interface AcceptResult {
  created: number;
  /**
   * Proposals skipped because a file of that name already exists. The registry
   * still does not carry them, so the drift they represent is NOT resolved — the
   * file is there but nothing imports it.
   */
  skipped: number;
}

/** Materialize new-model / new-action proposals as NEW files only (D11). */
const acceptNewFiles = ({ diff, cwd }: { diff: SyncDiff; cwd: string }): AcceptResult => {
  let created = 0;
  let skipped = 0;

  const write = ({ filename, content }: { filename: string; content: string }): void => {
    const target = join(cwd, ONTOLOGY_DIR, filename);

    if (existsSync(target)) {
      skipped += 1;
      process.stdout.write(
        `skipped ontology/${filename} — the file already exists but the registry does not import it\n`,
      );
      return;
    }

    writeFileSync(target, content, 'utf8');
    created += 1;
    process.stdout.write(`created ontology/${filename}\n`);
  };

  for (const object of diff.newObjects) {
    write(emitObjectFile({ object }));
  }

  for (const action of diff.newActions) {
    write(emitActionFile({ action }));
  }

  return { created, skipped };
};

/**
 * Everything one run found, in the only two classes the exit contract knows.
 * Each counter holds what is STILL unresolved after the `--accept-*` flags have
 * done their work, so the exit code is a property of the report rather than of
 * whichever branch happened to run last.
 */
export interface SyncFindings {
  /** New models/actions still not in the registry (`--accept-new` resolves these). */
  proposals: number;
  /** Field-level drift on existing objects — no flag resolves it; sync never edits. */
  fieldDrift: number;
  /** Ontology files the config loader never imports, so their actions do not exist. */
  unregistered: number;
  /** A weakened posture, or a project with actions and no baseline at all. */
  governance: number;
}

/**
 * The single place the exit code is decided. Drift is drift regardless of which
 * check found it: if a run printed anything but `info:`, it exits 1.
 */
export const isDrift = ({ findings }: { findings: SyncFindings }): boolean =>
  findings.proposals > 0 ||
  findings.fieldDrift > 0 ||
  findings.unregistered > 0 ||
  findings.governance > 0;

/** Run `orangerail sync`. */
export const runSync = async ({
  acceptGovernance,
  acceptNew,
  configPath,
  cwd,
}: {
  acceptGovernance: boolean;
  acceptNew: boolean;
  configPath?: string | undefined;
  cwd: string;
}): Promise<number> => {
  let registry;
  let projectRoot;
  try {
    const config = await loadConfig({ configPath });
    registry = config.registry;
    // The baseline describes the REGISTRY, so it lives next to the config that
    // declares it. With no `--config` that is the cwd, exactly as before.
    projectRoot = dirname(resolveConfigPath({ configPath }));
  } catch (err) {
    process.stderr.write(`orangerail sync: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const scanned = scanRepo({ cwd });
  const diff = diffSync({ scanned, registry });

  const report = printReport({ diff });

  const unregistered = reportUnregistered({ cwd });
  for (const warning of unregistered) {
    process.stdout.write(`${warning}\n`);
  }

  const review = reviewGovernance({ projectRoot, registry });

  if (review.state === 'unreadable') {
    process.stderr.write(
      `orangerail sync: ${GOVERNANCE_FILE} could not be read: ${review.detail}. ` +
        'Restore it from version control, or delete it and re-record with `orangerail sync --accept-governance`.\n',
    );
    return 2;
  }

  const findings: SyncFindings = {
    proposals: report.proposals,
    fieldDrift: report.fieldDrift,
    unregistered: unregistered.length,
    governance: printGovernance({ review, recording: acceptGovernance }),
  };

  // Re-recording is the human acknowledgement: whatever the posture is right
  // now becomes the reviewed baseline, so it can no longer be drift.
  if (acceptGovernance) {
    try {
      writeBaseline({ projectRoot, postures: review.postures, recordedBy: 'sync' });
    } catch (err) {
      process.stderr.write(
        `orangerail sync: could not write ${GOVERNANCE_FILE}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }

    process.stdout.write(
      `sync: recorded the governance posture of ${review.postures.length} action(s) in ${GOVERNANCE_FILE} — commit it.\n`,
    );
  }

  if (acceptNew) {
    const { created, skipped } = acceptNewFiles({ diff, cwd });
    process.stdout.write(
      created === 0
        ? 'sync: no new proposals to create.\n'
        : `sync: created ${created} new file(s).\n`,
    );

    // Only the proposals actually written are resolved. A proposal whose target
    // file already existed is still drift — the file is there and nothing
    // imports it — and reporting that as clean is how a CI step that
    // auto-adopts new models used to pass green with drift on the board.
    findings.proposals = skipped;
  }

  if (isDrift({ findings })) {
    process.stdout.write(
      acceptNew
        ? '\nsync: drift remains that --accept-new cannot resolve — review the report above.\n'
        : '\nsync: drift found — review the report above. No files were modified.\n',
    );

    return 1;
  }

  // A run that just wrote files does not get to call the ontology "in sync":
  // the registry it compared against was loaded before those files existed and
  // will not carry them until the next run.
  if (acceptNew) {
    return 0;
  }

  process.stdout.write(
    review.state === 'verified' && !acceptGovernance
      ? 'sync: ontology is in sync with your sources; governance matches the recorded baseline.\n'
      : 'sync: ontology is in sync with your sources.\n',
  );

  return 0;
};
