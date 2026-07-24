import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { OrangerailConfig } from '../../config';
import { runDocs } from '../docs';
import { DEFAULT_STUDIO_PORT, runStudio } from '../studio';
import { runInitFromArtifacts } from './artifacts';
import { buildFileSet } from './codegen';
import type { ScannedSource } from './ir';
import { specifiersResolvable, smokeLoadStaged, writeFileSet } from './atomic';
import { hasScannedContent, scanRepo } from './scan';
import { hasYamlSpec, YAML_HINT } from './scanners/openapi/scan';
import { runWizard, type InitFlags, type ResolvedInit } from './wizard';

/** Config filenames whose presence means the repo is already initialized (D1). */
const CONFIG_NAMES = ['orangerail.config.mjs', 'orangerail.config.js'];

/** Whether a usable config already resolves in the target repo (AC-6 front door). */
const configExists = ({ cwd }: { cwd: string }): boolean =>
  CONFIG_NAMES.some((name) => existsSync(join(cwd, name)));

/**
 * Apply the wizard's source/model selection to a scanned source. `sources`
 * gates by scanner origin (objects come from Prisma, actions from OpenAPI);
 * `models` keeps only the named objects (and links referencing them). Absent
 * filters keep everything (the flag-driven default).
 */
const applyFilters = ({
  source,
  options,
}: {
  source: ScannedSource;
  options: ResolvedInit;
}): ScannedSource => {
  const keepObjects = options.sources === undefined || options.sources.includes('prisma');
  const keepActions = options.sources === undefined || options.sources.includes('openapi');

  const models = options.models;

  const objects = !keepObjects
    ? []
    : models === undefined
      ? source.objects
      : source.objects.filter((o) => models.includes(o.name));

  const objectNames = new Set(objects.map((o) => o.name));

  return {
    objects: objects.map((o) => ({
      ...o,
      relations: o.relations.filter((r) => objectNames.has(r.target)),
    })),
    enums: source.enums,
    actions: keepActions ? source.actions : [],
    warnings: source.warnings,
    infos: source.infos,
  };
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
  const source = applyFilters({ source: scanned, options });
  const files = buildFileSet({ source, preset: options.preset });

  const resolvable = specifiersResolvable({ cwd });

  if (resolvable) {
    await smokeLoadStaged({ files, cwd });
  }

  writeFileSet({ files, baseDir: cwd });

  const objectCount = source.objects.length;
  const actionCount = source.actions.length;
  process.stdout.write(
    `orangerail init: generated ${objectCount} object(s) and ${actionCount} action(s) under ontology/.\n` +
      'These files are yours — re-scans never modify them; `orangerail sync` reports drift.\n',
  );

  if (!resolvable) {
    process.stdout.write(
      '\nNext step: install the runtime deps so the generated code can load:\n' +
        '  npm install orangerail-core zod\n' +
        'Then run `orangerail studio` or `orangerail mcp`.\n',
    );

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
