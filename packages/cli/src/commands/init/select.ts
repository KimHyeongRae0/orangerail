import type { ScannedSource } from './ir';
import { SCANNERS } from './scan';
import type { ResolvedInit } from './wizard';

/**
 * The `--sources` / `--models` selection layer (ONT-041). Two jobs, both about
 * `init` never claiming success over a project that cannot load:
 *
 * - `assertSelection` refuses a value that selects nothing, BEFORE a byte is
 *   written, naming the valid set — the behavior `--preset` already models. A
 *   `--sources=nonsense` used to write an empty ontology and exit 0, and a
 *   `--models=Typo` used to write orphan actions and exit 0.
 * - `applyFilters` drops an action whose target object the selection removed. A
 *   Prisma CRUD action imports its object's file (`target:`) and calls that
 *   model, so keeping it after its object was filtered out emitted an import of
 *   a file that is never written — `--models` on any schema with 2+ models
 *   produced a project that dies at load with `Cannot find module`.
 */

/** The scanner names `--sources` accepts, in registration order. */
export const SOURCE_NAMES: string[] = SCANNERS.map((scanner) => scanner.name);

/** Format a list of offending values for a diagnostic: `"a", "b"`. */
const quoteAll = ({ values }: { values: string[] }): string =>
  values.map((value) => `"${value}"`).join(', ');

/**
 * Throw when `--sources` names something that is not a scanner, or `--models`
 * names something this repo does not have. Mirrors the `--preset` refusal
 * exactly — the message names the offending value(s) and the valid set, and it
 * runs before codegen, so nothing is written. A selection that matches
 * everything, or is absent, is a no-op.
 */
export const assertSelection = ({
  source,
  options,
}: {
  source: ScannedSource;
  options: ResolvedInit;
}): void => {
  const unknownSources = (options.sources ?? []).filter((name) => !SOURCE_NAMES.includes(name));

  if (unknownSources.length > 0) {
    throw new Error(
      `unknown source ${quoteAll({ values: unknownSources })} — expected one of ${SOURCE_NAMES.join(', ')}`,
    );
  }

  const scanned = source.objects.map((object) => object.name);
  const unknownModels = (options.models ?? []).filter((name) => !scanned.includes(name));

  if (unknownModels.length > 0) {
    const known = scanned.length === 0 ? '(this repo has no scanned models)' : scanned.join(', ');

    throw new Error(
      `unknown model ${quoteAll({ values: unknownModels })} — expected one of ${known}`,
    );
  }
};

/**
 * Apply the wizard's source/model selection to a scanned source. `sources`
 * gates BOTH objects and actions by the scanner that produced them (an action
 * carries its own `source`, so `--sources=prisma` keeps the Prisma CRUD actions
 * it also produced instead of silently dropping them). `models` keeps only the
 * named objects, the relations between them, and the actions that target them.
 * Absent filters keep everything (the flag-driven default), and the whole
 * function is a no-op on an unfiltered scan.
 */
export const applyFilters = ({
  source,
  options,
}: {
  source: ScannedSource;
  options: ResolvedInit;
}): ScannedSource => {
  const sources = options.sources;
  const keepsSource = ({ name }: { name: string }): boolean =>
    sources === undefined || sources.includes(name);

  const models = options.models;

  const objects = !keepsSource({ name: 'prisma' })
    ? []
    : models === undefined
      ? source.objects
      : source.objects.filter((o) => models.includes(o.name));

  const objectNames = new Set(objects.map((o) => o.name));

  // An action survives only when its own scanner survived AND — for a Prisma
  // CRUD action, which imports and writes its object — its object survived. A
  // kept action whose object was dropped is an orphan: the generated file
  // imports `./<Object>.mjs`, which the file set never contains.
  const actions = source.actions.filter(
    (action) =>
      keepsSource({ name: action.source }) &&
      (action.prisma === undefined || objectNames.has(action.prisma.model)),
  );

  return {
    objects: objects.map((o) => ({
      ...o,
      relations: o.relations.filter((r) => objectNames.has(r.target)),
    })),
    enums: source.enums,
    actions,
    warnings: source.warnings,
    infos: source.infos,
  };
};
