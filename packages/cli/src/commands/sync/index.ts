import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../../config';
import { emitActionFile } from '../init/codegen/emit-action';
import { emitObjectFile } from '../init/codegen/emit-object';
import { scanRepo } from '../init/scan';
import { diffSync, type SyncDiff } from './diff';

/**
 * `orangerail sync` (plan D11). Loads the config (registry = source of truth),
 * re-scans the repo, and reports drift: new models/actions as PROPOSALS (a file
 * is written only under `--accept-new`), changed/added/removed fields as
 * warnings, and ontology files outside the discovery convention as
 * "unregistered file" warnings. It performs zero edits to existing files and
 * never merges (§5.1.5). Exit codes: 0 clean / 1 drift found / 2 error.
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

/** Print the human-readable drift report; returns whether any drift was found. */
const printReport = ({ diff }: { diff: SyncDiff }): boolean => {
  let drift = false;

  for (const object of diff.newObjects) {
    drift = true;
    process.stdout.write(
      `proposal: new model ${object.name} (run \`orangerail sync --accept-new\` to create ontology/${object.name}.mjs)\n`,
    );
  }

  for (const action of diff.newActions) {
    drift = true;
    process.stdout.write(
      `proposal: new action ${action.name} (from ${action.method} ${action.path})\n`,
    );
  }

  for (const fieldDrift of diff.fieldDrifts) {
    drift = true;
    process.stdout.write(
      `drift: ${fieldDrift.object}.${fieldDrift.field} ${fieldDrift.kind} — ${fieldDrift.detail}\n`,
    );
  }

  for (const name of diff.registryOnlyObjects) {
    process.stdout.write(
      `info: ${name} is in your ontology but not the source (user-owned extension)\n`,
    );
  }

  return drift;
};

/** Materialize new-model / new-action proposals as NEW files only (D11). */
const acceptNewFiles = ({ diff, cwd }: { diff: SyncDiff; cwd: string }): number => {
  let created = 0;

  for (const object of diff.newObjects) {
    const file = emitObjectFile({ object });
    const target = join(cwd, ONTOLOGY_DIR, file.filename);

    if (!existsSync(target)) {
      writeFileSync(target, file.content, 'utf8');
      created += 1;
      process.stdout.write(`created ontology/${file.filename}\n`);
    }
  }

  for (const action of diff.newActions) {
    const file = emitActionFile({ action });
    const target = join(cwd, ONTOLOGY_DIR, file.filename);

    if (!existsSync(target)) {
      writeFileSync(target, file.content, 'utf8');
      created += 1;
      process.stdout.write(`created ontology/${file.filename}\n`);
    }
  }

  return created;
};

/** Run `orangerail sync`. */
export const runSync = async ({
  acceptNew,
  configPath,
  cwd,
}: {
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

  const drift = printReport({ diff });

  for (const warning of reportUnregistered({ cwd })) {
    process.stdout.write(`${warning}\n`);
  }

  if (acceptNew) {
    const created = acceptNewFiles({ diff, cwd });
    process.stdout.write(
      created === 0
        ? 'sync: no new proposals to create.\n'
        : `sync: created ${created} new file(s).\n`,
    );

    return 0;
  }

  if (drift) {
    process.stdout.write(
      '\nsync: drift found — review the report above. No files were modified.\n',
    );
    return 1;
  }

  process.stdout.write('sync: ontology is in sync with your sources.\n');

  return 0;
};
