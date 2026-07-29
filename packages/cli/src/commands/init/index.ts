import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CONFIG_NAMES, type OrangerailConfig } from '../../config';
import { actionPostures, GOVERNANCE_FILE, writeBaseline } from '../../governance';
import { runDocs } from '../docs';
import { DEFAULT_STUDIO_PORT, runStudio } from '../studio';
import { runInitFromArtifacts } from './artifacts';
import { buildFileSet } from './codegen';
import {
  clobberRefusal,
  degradeNotice,
  existingTargets,
  verifyStaged,
  writeFileSet,
} from './atomic';
import { hasScannedContent, scanRepo } from './scan';
import { hasYamlSpec, YAML_HINT } from './scanners/openapi/scan';
import { applyFilters, assertSelection } from './select';
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
 * What is left is a claim init can honestly make: every action it generated
 * carries `policy: { approval: 'required' }`, so this row set is the strongest
 * posture the tool can produce. Recording it cannot launder a weak posture as
 * approved; it can only make a later weakening detectable — which without this
 * file it simply was not, in exactly the state every new project starts in.
 *
 * A failure to write is reported and swallowed: the ontology is already on disk
 * and usable, and taking a successful `init` down to a non-zero exit over the
 * baseline would be worse than the missing file, which `sync` already reports.
 */
const recordInitialBaseline = ({
  config,
  cwd,
}: {
  config: OrangerailConfig;
  cwd: string;
}): string | null => {
  const postures = actionPostures({ registry: config.registry });

  // No actions, no posture to vouch for — a read-only ontology gets no file and
  // is never nagged about one.
  if (postures.length === 0) {
    return null;
  }

  try {
    return writeBaseline({ projectRoot: cwd, postures, recordedBy: 'init' });
  } catch (err) {
    process.stderr.write(
      `orangerail init: could not write ${GOVERNANCE_FILE} (${err instanceof Error ? err.message : String(err)}) — ` +
        'run `orangerail sync --accept-governance` to record it.\n',
    );

    return null;
  }
};

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
    process.stdout.write(
      'orangerail init: no Prisma schema or OpenAPI JSON found in this repo.\n' +
        'Add a `prisma/schema.prisma` and/or an `openapi.json`, then re-run.\n',
    );

    if (hasYamlSpec({ cwd })) {
      process.stdout.write(`Hint: ${YAML_HINT}\n`);
    }

    return 0;
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
  const files = buildFileSet({ source, preset: options.preset });

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

  // Load the generated config here rather than after the summary: the
  // governance baseline is read off the LIVE REGISTRY (never off the generated
  // text), and the summary has to be able to say whether it was recorded. A
  // degraded verdict means the config does not load, so there is no registry to
  // read and no baseline is written — `sync` then reports the absent baseline
  // exactly as it does for a project that predates the file.
  const config = verdict.ok ? await loadGeneratedConfig({ cwd }) : null;
  const baseline = config === null ? null : recordInitialBaseline({ config, cwd });

  // A three-beat confirmation of what init just did — scanned, generated, and
  // (per the chosen preset) how writes are governed. The gate line states the
  // preset's real behavior rather than a blanket claim: `approval-for-writes`
  // stages every write for a human, `sandbox` dry-runs them, `readonly` exposes
  // no write tools at all.
  const gateLine =
    options.preset === 'readonly'
      ? 'read-only — no write tools exposed'
      : options.preset === 'sandbox'
        ? `${actionCount} write action(s) — sandbox (dry-run, nothing executes)`
        : `${actionCount} write action(s) gated behind human approval`;

  // The governance beat, in whichever of its two forms is true. When the config
  // loaded, the posture is on disk and what is left is a review. When it did not
  // — the deps are not installed yet, the common first run — there was no live
  // registry to read, and the honest thing is to name the one command that
  // closes the gap rather than record a posture derived from somewhere else.
  const governanceBeat =
    actionCount === 0
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

  process.stdout.write(
    `  ✓  scanned your sources — ${objectCount} object(s), ${actionCount} action(s)\n` +
      '  ✓  generated a governed MCP server under ontology/\n' +
      `  ✓  ${gateLine}\n` +
      governanceBeat.tick +
      '\n  These files are yours — re-scans never modify them; `orangerail sync` reports drift.\n' +
      governanceBeat.body,
  );

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
