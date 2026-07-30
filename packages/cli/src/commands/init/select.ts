import type { ScannedSource } from './ir';
import { SCANNERS } from './scan';
import type { ResolvedInit } from './wizard';

/**
 * The `--sources` / `--models` / `--exclude` selection layer (ONT-041, ONT-059).
 * Two jobs, both about `init` never claiming success over a project that cannot
 * load:
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
 *
 * `--exclude` is the deny-list's front door and validates identically, because
 * the two flags fail in the same way: a typo in either silently changes which
 * tables an agent can reach. The difference is downstream — `--models` narrows
 * this run, while an `--exclude` name is also written into
 * `orangerail.governance.json` as a refusal that later scans honour (ONT-059).
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
  const known = scanned.length === 0 ? '(this repo has no scanned models)' : scanned.join(', ');
  const unknownModels = (options.models ?? []).filter((name) => !scanned.includes(name));

  if (unknownModels.length > 0) {
    throw new Error(
      `unknown model ${quoteAll({ values: unknownModels })} — expected one of ${known}`,
    );
  }

  const excluded = options.exclude ?? [];
  const unknownExcluded = excluded.filter((name) => !scanned.includes(name));

  // A typo'd `--exclude` is worse than a typo'd `--models`, because the refusal
  // it writes outlives this run: `orangerail sync` would keep reporting the table
  // the operator believed they had refused, while the deny-list quietly carried a
  // name that matches nothing.
  if (unknownExcluded.length > 0) {
    throw new Error(
      `unknown model ${quoteAll({ values: unknownExcluded })} in --exclude — expected one of ${known}`,
    );
  }

  const contradictory = (options.models ?? []).filter((name) => excluded.includes(name));

  // Neither precedence rule is honest here: whichever flag won, half of what the
  // operator typed would be discarded without a word, and the half discarded
  // decides whether a table is on the agent's surface.
  if (contradictory.length > 0) {
    throw new Error(
      `${quoteAll({ values: contradictory })} appears in both --models and --exclude — ` +
        'keep it or refuse it, not both',
    );
  }

  if (excluded.length > 0 && scanned.every((name) => excluded.includes(name))) {
    throw new Error('--exclude names every scanned model — there would be nothing left to govern');
  }
};

/**
 * Apply the wizard's source/model selection to a scanned source. `sources`
 * gates BOTH objects and actions by the scanner that produced them (an action
 * carries its own `source`, so `--sources=prisma` keeps the Prisma CRUD actions
 * it also produced instead of silently dropping them). `models` keeps only the
 * named objects, the relations between them, and the actions that target them.
 * `exclude` then drops the named objects from whatever survived. Absent filters
 * keep everything (the flag-driven default), and the whole function is a no-op on
 * an unfiltered scan.
 *
 * The two model filters compose in that order rather than one overriding the
 * other, and `assertSelection` has already refused a name given to both — so
 * `--models` answers "which of these do I want" and `--exclude` answers "which of
 * these have I refused", and no name has to mean both at once.
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
  const excluded = options.exclude ?? [];

  const kept = !keepsSource({ name: 'prisma' })
    ? []
    : models === undefined
      ? source.objects
      : source.objects.filter((o) => models.includes(o.name));

  const objects = kept.filter((o) => !excluded.includes(o.name));

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
    // The datasource survives filtering: `--models` narrows WHICH tables are
    // governed, never WHICH database they live in (ONT-049).
    ...(source.datasource === undefined ? {} : { datasource: source.datasource }),
    warnings: source.warnings,
    infos: source.infos,
  };
};

/**
 * Scanned models this run neither generated nor recorded as refused (ONT-059).
 *
 * `--models a,b` is a statement about what the operator wants, not about the
 * models they left out: nobody enumerated those and said no to them. Recording
 * the complement as a deny-list would make the tool assert a decision that was
 * never made — the same laundering `recordedBy: 'init'` exists to prevent — so
 * `init` names them instead and hands back the command that would record them,
 * with the names in it.
 *
 * Only an allow-list produces leftovers. Without `--models` every scanned model
 * was either generated or explicitly refused, so there is nothing to report.
 */
export const unaccountedModels = ({
  source,
  options,
}: {
  /** The scan BEFORE filtering — the full set the operator narrowed against. */
  source: ScannedSource;
  options: ResolvedInit;
}): string[] => {
  const models = options.models;

  if (models === undefined) {
    return [];
  }

  const excluded = options.exclude ?? [];

  return source.objects
    .map((object) => object.name)
    .filter((name) => !models.includes(name) && !excluded.includes(name));
};
