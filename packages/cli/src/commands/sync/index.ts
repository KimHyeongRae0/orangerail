import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadConfig, resolveConfigPath } from '../../config';
import {
  exposedExclusionDetail,
  GOVERNANCE_FILE,
  isUnreviewed,
  normalizeExclusions,
  reviewGovernance,
  writeBaseline,
  type GovernanceReview,
} from '../../governance';
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
 *
 * ## Refused models (ONT-059)
 *
 * A model the operator left out of the ontology on purpose used to be
 * rediscovered as a proposal on every run, so a narrowed project — the posture
 * this product recommends — could never reach exit 0, and the only remedy the
 * report named was `--accept-new`, which would have generated the very table
 * that was kept away from the agent. A check that can never pass is a check
 * nobody reads, and this one is what makes the ONT-056 un-gated default
 * defensible.
 *
 * So a refusal is now recorded, in the baseline, and honoured here: an excluded
 * model is reported as `info:` instead of proposed, its actions are not
 * proposed, and `--accept-new` will not create it. `--exclude` is the door that
 * records one, and it takes names — nothing is ever suggested, because a name is
 * syntactic and the danger it stands for is not.
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

/**
 * The scan-vs-registry diff with every refused model taken out of it (ONT-059).
 *
 * The suppression is by MODEL NAME, so it reaches a proposed object and the
 * Prisma actions that target it — the three `create/update/delete` rows are the
 * bulk of the noise, and leaving them behind would mean a project could still
 * never go green. An OpenAPI action carries no model, so no name can suppress
 * one; the deny-list is a statement about tables, and pretending otherwise would
 * silence something it was never shown.
 */
interface ExclusionSplit {
  /** The diff the report and `--accept-new` see. */
  visible: SyncDiff;
  /** Suppressed proposed model names, sorted. */
  models: string[];
  /** Suppressed action count per model name. */
  actionsByModel: Map<string, number>;
}

const splitExclusions = ({
  diff,
  excluded,
}: {
  diff: SyncDiff;
  excluded: ReadonlySet<string>;
}): ExclusionSplit => {
  const actionsByModel = new Map<string, number>();

  for (const action of diff.newActions) {
    const model = action.prisma?.model;

    if (model !== undefined && excluded.has(model)) {
      actionsByModel.set(model, (actionsByModel.get(model) ?? 0) + 1);
    }
  }

  const models = diff.newObjects
    .map((object) => object.name)
    .filter((name) => excluded.has(name))
    .sort();

  return {
    visible: {
      ...diff,
      newObjects: diff.newObjects.filter((object) => !excluded.has(object.name)),
      newActions: diff.newActions.filter(
        (action) => action.prisma === undefined || !excluded.has(action.prisma.model),
      ),
    },
    models,
    actionsByModel,
  };
};

/**
 * Report what the deny-list absorbed, and what it has stopped matching.
 *
 * An honoured exclusion prints — silently swallowing a proposal is how a
 * deny-list turns into the "silence everything" rule it must not be. A STALE
 * one prints for a sharper reason: it matches nothing today, so it is doing no
 * work, and the day a new table is created under that name it will silence it.
 * That is the single way a name-based list can go quiet on something real, and
 * pruning it is a one-line diff in a committed file.
 */
const printExclusions = ({
  split,
  excluded,
  scannedNames,
  registryNames,
}: {
  split: ExclusionSplit;
  excluded: string[];
  scannedNames: ReadonlySet<string>;
  registryNames: ReadonlySet<string>;
}): void => {
  const out = process.stdout;

  for (const name of split.models) {
    const actions = split.actionsByModel.get(name) ?? 0;

    out.write(
      `info: ${name} is excluded, as recorded in ${GOVERNANCE_FILE}` +
        (actions === 0 ? '' : ` (${actions} action(s) not proposed)`) +
        '\n',
    );
  }

  for (const name of excluded) {
    if (scannedNames.has(name) || registryNames.has(name)) {
      continue;
    }

    out.write(
      `info: recorded exclusion "${name}" matches nothing in your sources — prune it from ` +
        `${GOVERNANCE_FILE}, otherwise a future model of that name is silenced too\n`,
    );
  }
};

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

  // The second door, stated once under the proposals rather than on every line.
  // `--accept-new` was the only remedy this report named, and on a project that
  // narrowed its surface on purpose it is the wrong one — it generates the table
  // that was deliberately kept away from the agent. The models are listed above;
  // which of them are refused is not a question this tool can answer.
  if (diff.newObjects.length > 0) {
    process.stdout.write(
      `          Refusing one instead? \`orangerail sync --exclude <name>[,<name>]\` records that in ${GOVERNANCE_FILE},\n` +
        '          and later runs stay quiet about it. Name each model yourself — nothing is pre-selected.\n',
    );
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

  // Loud and exit-worthy in every run, including a recording one: `--exclude`
  // and `--accept-governance` both re-record, and neither is an instruction to
  // start serving a table the file says was refused. The contradiction survives
  // until the ontology or the list changes.
  for (const name of review.exposedExclusions) {
    out.write(`excluded: ${exposedExclusionDetail({ name })}\n`);
  }

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
    // `--accept-new` always writes a GATED action, whatever `--gate` the project
    // was generated with (ONT-056). `init` is the moment the posture is chosen,
    // over a surface a human is about to read; this is a model that showed up in
    // a later scan of a project somebody already vouched for, and the two are
    // not the same decision.
    //
    // It is also the only choice that keeps the governance verdict coherent.
    // `diffGovernance` reads a new action absent from the baseline as
    // `strengthened` when it is gated and `weakened` when it is not — so writing
    // it un-gated here would put the project into the state `orangerail mcp`
    // withholds, immediately, as the direct result of a sync flag.
    write(emitActionFile({ action, gate: 'all', construction }));
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
  /**
   * Models the baseline records as refused that the ontology exposes anyway. It
   * gets its own counter rather than folding into `governance`, because no flag
   * on this command resolves it — re-recording the posture does not stop a table
   * from being reachable, and a counter that `--accept-governance` could zero
   * would say otherwise.
   */
  exposedExclusions: number;
}

/**
 * The single place the exit code is decided. Drift is drift regardless of which
 * check found it: if a run printed anything but `info:`, it exits 1.
 */
export const isDrift = ({ findings }: { findings: SyncFindings }): boolean =>
  findings.proposals > 0 ||
  findings.fieldDrift > 0 ||
  findings.unregistered > 0 ||
  findings.governance > 0 ||
  findings.exposedExclusions > 0;

/**
 * Refuse an `--exclude` value the run cannot honestly record, before a line of
 * report is printed. Returns the message, or `null` when the names are usable.
 *
 * All three refusals are about the same thing: a recorded refusal outlives the
 * run that wrote it, so it must be true when it is written. A typo would sit in
 * a committed file matching nothing while the operator believed a table was
 * refused; a name the ontology already serves would manufacture the very
 * contradiction the check reports; and with no baseline at all there is no
 * honest `recordedBy` to stamp — `init` did not write the file and nobody
 * reviewed the postures in it.
 */
const refuseExclusions = ({
  names,
  scannedNames,
  registryNames,
  review,
  acceptGovernance,
}: {
  names: string[];
  scannedNames: ReadonlySet<string>;
  registryNames: ReadonlySet<string>;
  review: GovernanceReview;
  acceptGovernance: boolean;
}): string | null => {
  const unknown = names.filter((name) => !scannedNames.has(name) && !registryNames.has(name));

  if (unknown.length > 0) {
    const known = [...scannedNames].sort();

    return (
      `--exclude names ${unknown.map((name) => `"${name}"`).join(', ')}, which your sources do not have — ` +
      (known.length === 0 ? 'this repo scanned no models.' : `expected one of ${known.join(', ')}.`)
    );
  }

  const exposed = names.filter((name) => registryNames.has(name));

  if (exposed.length > 0) {
    return (
      `--exclude names ${exposed.map((name) => `"${name}"`).join(', ')}, which your ontology already exposes. ` +
      'Delete the ontology file(s) and the actions targeting them first, then record the refusal — ' +
      'otherwise the file would say refused while the agent could still reach it.'
    );
  }

  if (review.state === 'unrecorded' && !acceptGovernance) {
    return (
      `there is no ${GOVERNANCE_FILE} to record the exclusion in, and writing one here would have to ` +
      'claim who vouched for the action postures inside it. Run ' +
      `\`orangerail sync --exclude ${names.join(',')} --accept-governance\` to record both at once.`
    );
  }

  return null;
};

/** Run `orangerail sync`. */
export const runSync = async ({
  acceptGovernance,
  acceptNew,
  exclude,
  configPath,
  cwd,
}: {
  acceptGovernance: boolean;
  acceptNew: boolean;
  /** `--exclude` — model names to record as refused (ONT-059). */
  exclude?: string[] | undefined;
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
  const review = reviewGovernance({ projectRoot, registry });

  if (review.state === 'unreadable') {
    process.stderr.write(
      `orangerail sync: ${GOVERNANCE_FILE} could not be read: ${review.detail}. ` +
        'Restore it from version control, or delete it and re-record with `orangerail sync --accept-governance`.\n',
    );
    return 2;
  }

  const scannedNames = new Set(scanned.objects.map((object) => object.name));
  const registryNames = new Set(registry.listObjects().map((object) => object.name));

  // The refusal is checked before anything is printed, so a rejected `--exclude`
  // never leaves a half-run behind: no report, no file, and an exit code that
  // cannot be mistaken for "drift found".
  if (exclude !== undefined) {
    const refusal = refuseExclusions({
      names: exclude,
      scannedNames,
      registryNames,
      review,
      acceptGovernance,
    });

    if (refusal !== null) {
      process.stderr.write(`orangerail sync: ${refusal}\n`);
      return 2;
    }
  }

  // What this run honours: the recorded list plus whatever `--exclude` adds. The
  // new names take effect in the same run that records them, so the report the
  // operator reads is the one the next run will print.
  const excluded = normalizeExclusions({ names: [...review.excluded, ...(exclude ?? [])] });
  const excludedSet = new Set(excluded);

  const diff = diffSync({ scanned, registry });
  const split = splitExclusions({ diff, excluded: excludedSet });

  const report = printReport({ diff: split.visible });

  printExclusions({ split, excluded, scannedNames, registryNames });

  const unregistered = reportUnregistered({ cwd });
  for (const warning of unregistered) {
    process.stdout.write(`${warning}\n`);
  }

  const findings: SyncFindings = {
    proposals: report.proposals,
    fieldDrift: report.fieldDrift,
    unregistered: unregistered.length,
    governance: printGovernance({ review, recording: acceptGovernance }),
    exposedExclusions: review.exposedExclusions.length,
  };

  // Re-recording is the human acknowledgement: whatever the posture is right
  // now becomes the reviewed baseline, so it can no longer be drift.
  //
  // `--exclude` writes through the same call but says nothing about the
  // postures, so it carries `recordedBy` across untouched: recording a refusal
  // must never turn an init-generated posture nobody has read into a reviewed
  // one.
  if (acceptGovernance || exclude !== undefined) {
    const recordedBy = acceptGovernance ? 'sync' : (review.recordedBy ?? 'sync');

    try {
      writeBaseline({ projectRoot, postures: review.postures, recordedBy, excluded });
    } catch (err) {
      process.stderr.write(
        `orangerail sync: could not write ${GOVERNANCE_FILE}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }

    if (acceptGovernance) {
      process.stdout.write(
        `sync: recorded the governance posture of ${review.postures.length} action(s) in ${GOVERNANCE_FILE} — commit it.\n`,
      );
    }

    if (exclude !== undefined) {
      process.stdout.write(
        `sync: recorded ${exclude.length} refused model(s) in ${GOVERNANCE_FILE} — ${excluded.join(', ')} — commit it.\n`,
      );
    }
  }

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
      // Asked of the VISIBLE diff: a refused model is never written, so its
      // Prisma call sites do not exist and must not decide whether the run is
      // refused over the repo's Prisma major.
      hasPrismaCallSites:
        split.visible.newObjects.some((object) => object.idField !== undefined) ||
        split.visible.newActions.some((action) => action.source === 'prisma'),
      docPath: EXISTING_DB_DOC,
      command: 'orangerail sync --accept-new',
    });

    if (!prisma.ok) {
      process.stderr.write(prisma.refusal);

      return 1;
    }

    // The VISIBLE diff again, and this is the whole point of ONT-059: the
    // remedy the report used to name would have written `ontology/<refused>.mjs`
    // and put the table an operator deliberately kept away from the agent back
    // on its surface. A refused model is not a proposal, so there is nothing
    // here to accept.
    const { created, skipped } = acceptNewFiles({
      diff: split.visible,
      cwd,
      construction: prisma.construction,
    });
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
