import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Registry } from 'orangerail-core';

import { loadConfig } from '../../config';
import { emitActionFile } from '../init/codegen/emit-action';
import { emitObjectFile } from '../init/codegen/emit-object';
import {
  EXISTING_DB_DOC,
  type PrismaConstruction,
  resolvePrismaConstruction,
} from '../init/codegen/prisma-runtime';
import type { IrAction } from '../init/ir';
import { scanRepo } from '../init/scan';
import { diffSync, type SyncDiff } from './diff';
import {
  actionPostures,
  diffGovernance,
  GOVERNANCE_FILE,
  parseBaseline,
  serializeBaseline,
  type ActionPosture,
} from './governance';

/**
 * `orangerail sync` (plan D11). Loads the config (registry = source of truth),
 * re-scans the repo, and reports drift: new models/actions as PROPOSALS (a file
 * is written only under `--accept-new`), changed/added/removed fields as
 * warnings, and ontology files outside the discovery convention as
 * "unregistered file" warnings. It performs zero edits to existing files and
 * never merges (§5.1.5). Exit codes: 0 clean / 1 drift found / 2 error.
 *
 * On top of the scan-vs-registry diff it reviews the GOVERNANCE POSTURE against
 * the recorded baseline (ONT-043, `./governance.ts`). The scan has no opinion on
 * policy, so removing `policy: { approval: 'required' }` from a hand-owned
 * `ontology/*.mjs` used to pass as "in sync" — the one edit that disarms the
 * product went unreported. The posture is now compared against
 * `orangerail.governance.json`; weakening it fails the run, strengthening it is
 * reported as information, and `--accept-governance` re-records the baseline as
 * the human acknowledgement of a deliberate change.
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

/** The outcome of comparing the live posture against the recorded baseline. */
interface GovernanceReview {
  /** The live posture, ready to be recorded under `--accept-governance`. */
  postures: ActionPosture[];
  /** Whether a baseline file was found and read. */
  recorded: boolean;
  /**
   * True when there IS a posture to vouch for and no baseline recording it. An
   * ontology with no actions has nothing to vouch for, so it is never nagged.
   */
  unvouched: boolean;
  /** How many changes moved the posture in the dangerous direction. */
  weakened: number;
}

/**
 * Review the live governance posture against `orangerail.governance.json` and
 * print what moved. Throws when the baseline exists but cannot be read: a corrupt
 * baseline must never quietly degrade into "nothing to compare against", which is
 * the exact silence this check removes.
 */
const reviewGovernance = ({
  cwd,
  recording,
  registry,
}: {
  cwd: string;
  /** Whether this run is about to re-record the baseline (`--accept-governance`). */
  recording: boolean;
  registry: Registry;
}): GovernanceReview => {
  const postures = actionPostures({ registry });
  const path = join(cwd, GOVERNANCE_FILE);

  if (!existsSync(path)) {
    // No actions means no posture to vouch for — a read-only ontology is never
    // nagged about a baseline it does not need, and neither is a run that is
    // recording one right now.
    if (postures.length > 0 && !recording) {
      process.stdout.write(
        `governance: no recorded baseline — ${GOVERNANCE_FILE} is missing, so sync cannot tell whether the gates on your ${postures.length} action(s) still match what a human approved.\n` +
          `            Review \`orangerail status\`, then run \`orangerail sync --accept-governance\` to record it (commit the file).\n`,
      );
    }

    return { postures, recorded: false, unvouched: postures.length > 0, weakened: 0 };
  }

  let baseline: ActionPosture[];
  try {
    baseline = parseBaseline({ source: readFileSync(path, 'utf8') });
  } catch (err) {
    throw new Error(
      `${GOVERNANCE_FILE} could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
        'Restore it from version control, or delete it and re-record with `orangerail sync --accept-governance`.',
    );
  }

  const changes = diffGovernance({ baseline, current: postures });
  let weakened = 0;

  for (const change of changes) {
    if (change.direction === 'weakened') {
      weakened += 1;
      process.stdout.write(`governance: ${change.action} — ${change.detail}\n`);
      continue;
    }

    process.stdout.write(`info: governance ${change.action} — ${change.detail}\n`);
  }

  if (weakened > 0 && !recording) {
    process.stdout.write(
      '            Intentional? Re-record the baseline with `orangerail sync --accept-governance`.\n',
    );

    if (postures.some((posture) => posture.where === 'functional')) {
      process.stdout.write(
        '            Note: a functional `where` predicate is opaque to this check — its body is never compared.\n',
      );
    }
  }

  return { postures, recorded: true, unvouched: false, weakened };
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
const acceptNewFiles = ({
  diff,
  cwd,
  construction,
}: {
  diff: SyncDiff;
  cwd: string;
  construction: PrismaConstruction;
}): AcceptResult => {
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
    write(emitObjectFile({ object, construction }));
  }

  for (const action of diff.newActions) {
    write(emitActionFile({ action, construction }));
  }

  return { created, skipped };
};

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
  try {
    const config = await loadConfig({ configPath });
    registry = config.registry;
  } catch (err) {
    process.stderr.write(`orangerail sync: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const scanned = scanRepo({ cwd });
  const diff = diffSync({ scanned, registry });

  const report = printReport({ diff });

  for (const warning of reportUnregistered({ cwd })) {
    process.stdout.write(`${warning}\n`);
  }

  let governance: GovernanceReview;
  try {
    governance = reviewGovernance({ cwd, recording: acceptGovernance, registry });
  } catch (err) {
    process.stderr.write(`orangerail sync: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // Re-recording is the human acknowledgement: whatever the posture is right
  // now becomes the reviewed baseline, so it can no longer be drift.
  if (acceptGovernance) {
    try {
      writeFileSync(
        join(cwd, GOVERNANCE_FILE),
        serializeBaseline({ postures: governance.postures }),
        'utf8',
      );
    } catch (err) {
      process.stderr.write(
        `orangerail sync: could not write ${GOVERNANCE_FILE}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }

    process.stdout.write(
      `sync: recorded the governance posture of ${governance.postures.length} action(s) in ${GOVERNANCE_FILE} — commit it.\n`,
    );
  }

  const governanceDrift = !acceptGovernance && (governance.weakened > 0 || governance.unvouched);

  if (acceptNew) {
    // `--accept-new` is the second doorway that writes generated Prisma call
    // sites, so it answers the Prisma-major question exactly the way `init`
    // does (ONT-049) — otherwise a Prisma 7 project adopting a new model would
    // get a file with a constructor Prisma 7 rejects, from a command that
    // reported success.
    const prisma = resolvePrismaConstruction({
      cwd,
      provider: scanned.datasource?.provider,
      urlEnv: scanned.datasource?.urlEnv,
      hasPrismaCallSites:
        diff.newObjects.some((object) => object.idField !== undefined) ||
        diff.newActions.some((action) => action.source === 'prisma'),
      docPath: EXISTING_DB_DOC,
      command: 'orangerail sync --accept-new',
    });

    if (!prisma.ok) {
      process.stderr.write(prisma.refusal);

      return 1;
    }

    const { created, skipped } = acceptNewFiles({
      diff,
      cwd,
      construction: prisma.construction,
    });
    process.stdout.write(
      created === 0
        ? 'sync: no new proposals to create.\n'
        : `sync: created ${created} new file(s).\n`,
    );

    // The proposals just written are resolved; anything `--accept-new` cannot
    // write is still drift, and reporting it as clean is how a CI step that
    // auto-adopts new models used to pass green with drift on the board.
    if (report.fieldDrift > 0 || skipped > 0 || governanceDrift) {
      process.stdout.write(
        '\nsync: drift remains that --accept-new cannot resolve — review the report above.\n',
      );
      return 1;
    }

    return 0;
  }

  if (report.proposals > 0 || report.fieldDrift > 0 || governanceDrift) {
    process.stdout.write(
      '\nsync: drift found — review the report above. No files were modified.\n',
    );
    return 1;
  }

  process.stdout.write(
    governance.recorded && !acceptGovernance
      ? 'sync: ontology is in sync with your sources; governance matches the recorded baseline.\n'
      : 'sync: ontology is in sync with your sources.\n',
  );

  return 0;
};
