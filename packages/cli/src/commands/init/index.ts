import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CONFIG_NAMES, type OrangerailConfig } from '../../config';
import { actionPostures, GOVERNANCE_FILE, writeBaseline } from '../../governance';
import { hostSurveyInitBeat, surveyHostConfigs } from '../../host-mcp';
import { runDocs } from '../docs';
import { DEFAULT_STUDIO_PORT, runStudio } from '../studio';
import { runInitFromArtifacts } from './artifacts';
import { buildFileSet, EXISTING_DB_DOC, isActionGated, resolvePrismaConstruction } from './codegen';
import {
  clobberRefusal,
  degradeNotice,
  existingTargets,
  verifyStaged,
  writeFileSet,
} from './atomic';
import type { ScannedSource } from './ir';
import { hasScannedContent, scanRepo } from './scan';
import { hasYamlSpec, YAML_HINT } from './scanners/openapi/scan';
import { applyFilters, assertSelection, unaccountedModels } from './select';
import { runWizard, type InitFlags } from './wizard';

/**
 * Whether a usable config already resolves in the target repo (AC-6 front door).
 * Reads the same name list every other command loads from (D1), so a config
 * `orangerail studio` would happily run is never treated as absent here.
 */
const configExists = ({ cwd }: { cwd: string }): boolean =>
  DEFAULT_CONFIG_NAMES.some((name) => existsSync(join(cwd, name)));

/** Import the config init just generated; `null` when it does not default-export one. */
const loadGeneratedConfig = async ({ cwd }: { cwd: string }): Promise<OrangerailConfig | null> => {
  const module: unknown = await import(pathToFileURL(join(cwd, 'orangerail.config.mjs')).href);

  return (module as { default?: OrangerailConfig }).default ?? null;
};

/**
 * Record the generated posture as the project's governance baseline, from the
 * LIVE registry (ONT-050).
 *
 * ONT-043 deliberately did not do this, on the grounds that a baseline asserts a
 * human reviewed the posture and a scanner cannot make that assertion on
 * someone's behalf. That reasoning is right, and it is the reason the file
 * records WHO wrote it: this one is stamped `recordedBy: "init"`, its note says
 * it is a starting point rather than an approval, and every `sync` and `status`
 * repeats that until someone runs `--accept-governance`.
 *
 * What is left is a claim init can honestly make: these rows ARE what init just
 * generated. Since ONT-056 that is no longer the same as "everything is gated" —
 * under the default `--gate delete` the file records `"approval": null` on every
 * create and update — so the row set is a description, not a recommendation.
 * Recording it still cannot launder a weak posture as approved, because nothing
 * about the file claims approval: `recordedBy` says `init`, the note says it is a
 * starting point, and `sync`/`status`/`mcp` all keep saying "nobody has reviewed
 * this" until someone runs `--accept-governance`. What it buys is that a LATER
 * weakening is detectable from minute one, which without this file it was not.
 *
 * The cost of the ONT-056 default is worth naming here rather than in a report:
 * an action that was born un-gated is recorded un-gated, so it never trips the
 * weakening check. The check compares against the recorded starting point; it
 * does not audit that starting point. `orangerail status` prints
 * `N approval-gated, M auto` for exactly that reason.
 *
 * A failure to write is reported and swallowed: the ontology is already on disk
 * and usable, and taking a successful `init` down to a non-zero exit over the
 * baseline would be worse than the missing file, which `sync` already reports.
 */
const recordInitialBaseline = ({
  config,
  cwd,
  excluded,
}: {
  config: OrangerailConfig;
  cwd: string;
  /** The `--exclude` names, recorded as refused alongside the posture (ONT-059). */
  excluded: string[];
}): string | null => {
  const postures = actionPostures({ registry: config.registry });

  // No actions and nothing refused, so no posture to vouch for — a read-only
  // ontology gets no file and is never nagged about one. A refusal is worth
  // recording on its own, though: it is what keeps a later scan from proposing
  // the table again, and that is true whether or not anything is gated.
  if (postures.length === 0 && excluded.length === 0) {
    return null;
  }

  try {
    return writeBaseline({ projectRoot: cwd, postures, recordedBy: 'init', excluded });
  } catch (err) {
    process.stderr.write(
      `orangerail init: could not write ${GOVERNANCE_FILE} (${err instanceof Error ? err.message : String(err)}) — ` +
        'run `orangerail sync --accept-governance` to record it.\n',
    );

    return null;
  }
};

/**
 * Whether the file set will contain any `@prisma/client` call site (ONT-049).
 *
 * The conditions are the emitters' own, restated: `emitObjectFile` emits the
 * lazy client only for an object that has an `idField` (that is what gates
 * `renderResolve`), and `emitActionFile` only for a `source: 'prisma'` action.
 * An OpenAPI-only scan therefore imports no client at all and must never be
 * refused over the repo's Prisma version.
 */
const hasPrismaOutput = ({ source }: { source: ScannedSource }): boolean =>
  source.objects.some((object) => object.idField !== undefined) ||
  source.actions.some((action) => action.source === 'prisma');

/**
 * `orangerail init` (plan D1/D9/D12). Dispatches WITHOUT a config (it creates
 * one); refuses when a config already resolves, pointing at `orangerail sync`.
 * Scans the repo, runs the survey (flags/TTY), renders the deterministic file
 * set, atomically stages + smoke-loads it, writes it in place, generates
 * AGENTS.md via docs-gen, and hands off to the studio in-process — inheriting
 * ONT-005's port/open/watch behavior wholesale.
 */
export const runInit = async ({
  flags,
  cwd,
}: {
  flags: InitFlags;
  cwd: string;
}): Promise<number> => {
  if (configExists({ cwd })) {
    process.stderr.write(
      'orangerail init: an orangerail config already exists here — init never overwrites your ontology.\n' +
        'Run `orangerail sync` to re-scan your sources and review drift.\n',
    );

    return 1;
  }

  // Flag-driven human-source (Jira/Slack) scan path. When --from-jira is
  // present, run the parallel instance scanner and return; the type-level
  // Prisma/OpenAPI path below is byte-unaffected when the flag is absent (AC-1).
  if (flags.fromJira !== undefined) {
    return runInitFromArtifacts({
      cwd,
      fromJira: flags.fromJira,
      ...(flags.fromSlack === undefined ? {} : { fromSlack: flags.fromSlack }),
    });
  }

  const scanned = scanRepo({ cwd });

  for (const info of scanned.infos) {
    process.stderr.write(`${info}\n`);
  }
  for (const warning of scanned.warnings) {
    process.stderr.write(`orangerail init: ${warning}\n`);
  }

  if (!hasScannedContent({ source: scanned })) {
    // A refusal, not a result — so it goes to stderr and exits non-zero
    // (ONT-049). It used to print on stdout and exit 0, which told every
    // scripted caller that init had succeeded over a repo it never touched.
    //
    // The message now also names the on-ramp. Most people adopting a governance
    // tool already have a database and no schema file, so "add a
    // prisma/schema.prisma" is an instruction they cannot follow without first
    // being told that `prisma db pull` writes one for them.
    process.stderr.write(
      'orangerail init: no Prisma schema or OpenAPI JSON found in this repo.\n' +
        'Add a `prisma/schema.prisma` and/or an `openapi.json`, then re-run.\n' +
        `Already have a live database and no schema file? \`prisma db pull\` writes one — see ${EXISTING_DB_DOC}.\n`,
    );

    if (hasYamlSpec({ cwd })) {
      process.stderr.write(`Hint: ${YAML_HINT}\n`);
    }

    return 1;
  }

  const result = await runWizard({
    flags,
    stdin: process.stdin,
    stdout: process.stdout,
    isTTY: Boolean(process.stdin.isTTY),
  });

  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    return 1;
  }

  const options = result.options;

  // A `--sources` / `--models` value that selects nothing is refused here,
  // before a byte is written — the same contract `--preset` already has.
  assertSelection({ source: scanned, options });

  const source = applyFilters({ source: scanned, options });

  // Which Prisma the generated code will run against decides how it must
  // construct its client (ONT-049). On Prisma 7+ with no driver adapter
  // installed there is no construction that works, so init refuses HERE —
  // before the file set is rendered, and long before the success banner — rather
  // than writing an ontology whose every Prisma call site throws.
  const prisma = resolvePrismaConstruction({
    cwd,
    provider: source.datasource?.provider,
    urlEnv: source.datasource?.urlEnv,
    // And WHERE that client comes from (ONT-067): Prisma 7's default generator
    // writes it into its own `output` directory, so an ontology importing
    // `@prisma/client` resolves a package carrying no client at all.
    ...(source.generator === undefined ? {} : { generator: source.generator }),
    hasPrismaCallSites: hasPrismaOutput({ source }),
    docPath: EXISTING_DB_DOC,
  });

  if (!prisma.ok) {
    process.stderr.write(prisma.refusal);

    return 1;
  }

  const files = buildFileSet({
    source,
    preset: options.preset,
    gate: options.gate,
    construction: prisma.construction,
  });

  // Nothing is written until every generated path is known to be free. Without
  // a config, a populated `ontology/` is the only trace of a previous init —
  // and "these files are yours" has to survive the config having been renamed,
  // moved, or deleted.
  const existing = existingTargets({ files, baseDir: cwd });

  if (existing.length > 0) {
    process.stderr.write(clobberRefusal({ existing }));

    return 1;
  }

  const verdict = await verifyStaged({ files, cwd });

  writeFileSet({ files, baseDir: cwd });

  const objectCount = source.objects.length;
  const actionCount = source.actions.length;

  // Counted through the SAME predicate the emitter branched on, so the number in
  // the summary and the `policy` lines on disk cannot disagree (ONT-056). Before
  // this it printed `actionCount` and called it the gated count, which was only
  // ever true because init gated everything.
  const gatedCount = source.actions.filter((action) =>
    isActionGated({ action, gate: options.gate }),
  ).length;
  const ungatedCount = actionCount - gatedCount;

  // Load the generated config here rather than after the summary: the
  // governance baseline is read off the LIVE REGISTRY (never off the generated
  // text), and the summary has to be able to say whether it was recorded. A
  // degraded verdict means the config does not load, so there is no registry to
  // read and no baseline is written — `sync` then reports the absent baseline
  // exactly as it does for a project that predates the file.
  const excluded = options.exclude ?? [];
  const config = verdict.ok ? await loadGeneratedConfig({ cwd }) : null;
  const baseline = config === null ? null : recordInitialBaseline({ config, cwd, excluded });

  // A three-beat confirmation of what init just did — scanned, generated, and
  // (per the chosen preset) how writes are governed. The gate line states the
  // preset's real behavior rather than a blanket claim: `approval-for-writes`
  // runs actions as declared, `sandbox` dry-runs them, `readonly` exposes no
  // write tools at all.
  //
  // Under `approval-for-writes` it also has to say WHICH writes are gated and
  // which are not, and name the `--gate` value that decided it (ONT-056). A run
  // that leaves four of six actions executable on the agent's word must not
  // close with a line the reader can mistake for "all of them are gated".
  const gateLine =
    options.preset === 'readonly'
      ? 'read-only — no write tools exposed'
      : options.preset === 'sandbox'
        ? `${actionCount} write action(s) — sandbox (dry-run, nothing executes)`
        : `--gate ${options.gate}: ${gatedCount} of ${actionCount} write action(s) gated behind human approval` +
          (ungatedCount === 0 ? '' : ` — the other ${ungatedCount} run when the agent calls them`);

  // Where to go to change it, in both directions: the files, or another init.
  // Only under `approval-for-writes`, because it is the only preset under which
  // the per-action gate is what decides whether a call executes.
  const gateGuidance =
    options.preset === 'approval-for-writes'
      ? '\n  Change what is gated by editing `policy` in ontology/<action>.mjs, or re-run init\n' +
        '  with `--gate all` (gate every write) or `--gate none` (gate nothing).\n'
      : '';

  // The governance beat, in whichever of its two forms is true. When the config
  // loaded, the posture is on disk and what is left is a review. When it did not
  // — the deps are not installed yet, the common first run — there was no live
  // registry to read, and the honest thing is to name the one command that
  // closes the gap rather than record a posture derived from somewhere else.
  const governanceBeat =
    actionCount === 0 && excluded.length === 0
      ? { tick: '', body: '' }
      : baseline === null
        ? {
            tick: `  ⚠  no governance baseline recorded — the generated config did not load\n`,
            body:
              `  ${GOVERNANCE_FILE} is what makes a later "someone deleted an approval gate" visible.\n` +
              '  Recording it needs the config to load, so run `orangerail sync --accept-governance`\n' +
              '  once the step below is done, and commit the file.\n',
          }
        : {
            tick: `  ✓  recorded that posture in ${GOVERNANCE_FILE} — commit it\n`,
            body:
              `  ${GOVERNANCE_FILE} holds the posture init just generated, which nobody has reviewed yet.\n` +
              '  From now on `orangerail sync` fails when an action gets weaker than that file, and\n' +
              '  `orangerail mcp` refuses to serve it. Read the file, then run\n' +
              '  `orangerail sync --accept-governance` to vouch for it as reviewed.\n',
          };

  // The refusal beat exists so the recorded deny-list is never something the
  // operator finds later in a JSON file: what `sync` will stay quiet about from
  // now on is stated in the same breath as what was generated (ONT-059).
  const excludedBeat =
    excluded.length === 0
      ? ''
      : `  ✓  refused ${excluded.length} model(s) — ${excluded.join(', ')} — recorded in ${GOVERNANCE_FILE}\n`;

  // The surface this run just narrowed is not necessarily the whole surface
  // (ONT-060). This is the exact moment the operator believes otherwise — they
  // asked for four models and were handed four models — so if the project's own
  // host config already declares a server orangerail does not govern, the
  // closing summary is where that has to be said, not a later `status` nobody
  // ran. Silent when nothing foreign is declared, which is the common case here:
  // a project generated seconds ago usually has no host config at all.
  const hostBeat = hostSurveyInitBeat({ review: surveyHostConfigs({ projectRoot: cwd }) });

  process.stdout.write(
    `  ✓  scanned your sources — ${objectCount} object(s), ${actionCount} action(s)\n` +
      '  ✓  generated a governed MCP server under ontology/\n' +
      `  ✓  ${gateLine}\n` +
      excludedBeat +
      governanceBeat.tick +
      hostBeat.tick +
      '\n  These files are yours — re-scans never modify them; `orangerail sync` reports drift.\n' +
      gateGuidance +
      governanceBeat.body +
      hostBeat.body,
  );

  // Models the allow-list left behind without refusing them. `sync` will report
  // every one of them on every run, and the only remedy it used to name was
  // `--accept-new` — the one that generates the table. Naming them here, with the
  // command that records the refusal, is the difference between a drift check
  // that can go green and one that cannot.
  const unaccounted = unaccountedModels({ source: scanned, options });

  if (unaccounted.length > 0) {
    process.stdout.write(
      `\n  ${unaccounted.length} scanned model(s) were neither generated nor refused: ${unaccounted.join(', ')}\n` +
        '  `orangerail sync` reports these as new on every run, because nothing on disk says you\n' +
        '  considered them. Record the ones you refuse — read the list first, nothing is selected\n' +
        '  for you:\n\n' +
        `    orangerail sync --exclude ${unaccounted.join(',')}\n`,
    );
  }

  // Both degrade kinds land here: the files are on disk either way, and only
  // the docs/studio handoff — which needs the config to actually load — is
  // skipped. Exit 0, because init did the job it promised.
  if (!verdict.ok) {
    process.stdout.write(degradeNotice({ verdict }));

    return 0;
  }

  const configPath = join(cwd, 'orangerail.config.mjs');

  if (!config) {
    process.stderr.write('orangerail init: generated config failed to load.\n');
    return 1;
  }

  if (options.docs) {
    runDocs({ config, outDir: join(cwd, '.orangerail', 'generated') });
  }

  if (!options.studio) {
    process.stdout.write(
      '\nDone. Run `orangerail studio` to explore the map, or `orangerail mcp`.\n',
    );
    return 0;
  }

  process.stdout.write('\nStarting the studio…\n');

  return runStudio({
    config,
    configPath,
    port: options.port ?? DEFAULT_STUDIO_PORT,
    open: options.open,
  });
};
