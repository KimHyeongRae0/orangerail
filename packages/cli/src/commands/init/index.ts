import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CONFIG_NAMES, type OrangerailConfig } from '../../config';
import { runDocs } from '../docs';
import { DEFAULT_STUDIO_PORT, runStudio } from '../studio';
import { runInitFromArtifacts } from './artifacts';
import { buildFileSet, resolvePrismaConstruction } from './codegen';
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
 * Where a user with a live database and no schema file is sent. Named once and
 * carried into both the "nothing found" refusal and the Prisma-major refusal, so
 * the two most likely dead ends point at the same walkthrough.
 */
const EXISTING_DB_DOC = 'docs/existing-database.md';

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
    hasPrismaCallSites: hasPrismaOutput({ source }),
    docPath: EXISTING_DB_DOC,
  });

  if (!prisma.ok) {
    process.stderr.write(prisma.refusal);

    return 1;
  }

  const files = buildFileSet({ source, preset: options.preset, construction: prisma.construction });

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
