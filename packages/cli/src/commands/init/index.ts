import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CONFIG_NAMES, type OrangerailConfig } from '../../config';
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

  process.stdout.write(
    `  ✓  scanned your sources — ${objectCount} object(s), ${actionCount} action(s)\n` +
      '  ✓  generated a governed MCP server under ontology/\n' +
      `  ✓  ${gateLine}\n\n` +
      '  These files are yours — re-scans never modify them; `orangerail sync` reports drift.\n',
  );

  // Both degrade kinds land here: the files are on disk either way, and only
  // the docs/studio handoff — which needs the config to actually load — is
  // skipped. Exit 0, because init did the job it promised.
  if (!verdict.ok) {
    process.stdout.write(degradeNotice({ verdict }));

    return 0;
  }

  const configPath = join(cwd, 'orangerail.config.mjs');
  const module: unknown = await import(pathToFileURL(configPath).href);
  const config = (module as { default?: OrangerailConfig }).default;

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
