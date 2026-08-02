import type { ScannedSource } from './ir';
import { SCANNERS } from './scan';
import type { ResolvedInit } from './wizard';

/**
 * The `--sources` / `--models` / `--exclude` selection layer (ONT-041, ONT-059,
 * ONT-063). Two jobs, both about `init` never claiming success over a project
 * that cannot load:
 *
 * - `resolveSelection` refuses a value that selects nothing, BEFORE a byte is
 *   written, naming the valid set — the behavior `--preset` already models. A
 *   `--sources=nonsense` used to write an empty ontology and exit 0, and a
 *   `--models=Typo` used to write orphan actions and exit 0. It also RESOLVES
 *   what survives to the scanned spelling (see below).
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
 *
 * ## Casing is resolved, never compared away (ONT-063)
 *
 * `--exclude payment` on a schema declaring `Payment` used to be refused: a
 * Postgres operator types the table name `psql` shows them, the scanner reports
 * the Prisma model name, and the comparison was an exact string match. The fix
 * is NOT a lenient comparison. Every consumer downstream of this file is
 * exact-match set membership — `applyFilters`, `sync`'s `excluded.has(name)`,
 * `governance.ts`'s exposed-exclusion check — and an input rule that recorded
 * the TYPED string would put `"excluded": ["payment"]` into a committed
 * `orangerail.governance.json`: a correct-looking deny-list that matches
 * nothing, which is the ONT-059 defect with a file behind it.
 *
 * So a typed name is resolved to the scanned name it refers to, once, here, and
 * only the scanned name leaves this file. The comparisons stay exact, and the
 * meaning of the recorded file does not depend on its reader's matching rules.
 */

/** The scanner names `--sources` accepts, in registration order. */
export const SOURCE_NAMES: string[] = SCANNERS.map((scanner) => scanner.name);

/** Format a list of offending values for a diagnostic: `"a", "b"`. */
const quoteAll = ({ values }: { values: string[] }): string =>
  values.map((value) => `"${value}"`).join(', ');

/** Something a typed name may resolve to, and the spellings that point at it. */
export interface Candidate {
  /** The canonical name — the only spelling that ever leaves resolution. */
  name: string;
  /**
   * Other spellings the scan reported for the SAME model, chiefly its source
   * model name when the allocator had to rename it. These make a collision
   * VISIBLE; they never resolve anything (see {@link resolveNames}).
   */
  aliases?: readonly string[] | undefined;
}

/** A typed name that could refer to more than one scanned model. */
export interface AmbiguousName {
  /** What the operator typed. */
  typed: string;
  /** The canonical names it could mean, in scan order. */
  candidates: string[];
}

/** What {@link resolveNames} made of a list of typed names. */
export interface NameResolution {
  /** Canonical names, in the order typed, each at most once. */
  names: string[];
  /** Typed names that match nothing, even ignoring case. */
  unknown: string[];
  /** Typed names that match two or more models ignoring case. */
  ambiguous: AmbiguousName[];
}

/**
 * Case-fold one name.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: the resolved name is written
 * into a committed file, so which model `--exclude PAYMENT` refers to must not
 * depend on the locale of the machine that ran the command. Turkish is the case
 * that makes this concrete — under `tr`, `I` folds to a dotless i, so a model
 * name carrying one would resolve for one operator and not for their colleague.
 */
const fold = ({ name }: { name: string }): string => name.toLowerCase();

/** The scanned objects as resolution candidates, source model names included. */
export const candidatesOf = ({ source }: { source: ScannedSource }): Candidate[] =>
  source.objects.map((object) => ({
    name: object.name,
    ...(object.sourceModel === undefined || object.sourceModel === object.name
      ? {}
      : { aliases: [object.sourceModel] }),
  }));

/**
 * Resolve typed model names to the canonical names they refer to (ONT-063).
 *
 * An exact match is never re-examined — it is already canonical. Otherwise the
 * case-folded form decides, and it must land on exactly one model.
 *
 * ## Why aliases exist
 *
 * `scanRepo`'s allocator (ONT-041) already de-collides names that differ only
 * in case, because they would claim the same `ontology/<name>.mjs` on a
 * case-insensitive filesystem: a schema declaring `Order` and `order` is
 * scanned as `Order` and `order_2`. Folding only the canonical names would
 * therefore see no collision at all and quietly resolve `--exclude order` to
 * `Order` — the wrong table, refused in a committed file, with the one the
 * operator meant still on the agent's surface. Folding the SOURCE model name
 * alongside it makes that pair visible, and it is refused instead. The operator
 * can still name either one, by the de-collided name the scan warning gave them.
 *
 * An alias never resolves on its own: it would mean recording a name that is
 * not the one every downstream comparison uses, which is the defect this whole
 * change exists to avoid.
 *
 * Duplicates collapse, so `--exclude PAYMENT,payment` is one model rather than
 * two — which is what the "names every scanned model" guard has to count.
 *
 * No other difference is tolerated. There is no prefix, plural or edit-distance
 * rule here on purpose: those turn a typo into a different table, and these are
 * the flags that decide which tables an agent can reach.
 */
export const resolveNames = ({
  typed,
  known,
}: {
  typed: readonly string[];
  /** What may be resolved to, in scan order. */
  known: readonly Candidate[];
}): NameResolution => {
  /** Case-folded spelling -> the canonical names reachable through it. */
  const owners = new Map<string, string[]>();
  /** Case-folded CANONICAL name -> that canonical name. The only resolver. */
  const canonical = new Map<string, string>();
  const exact = new Set(known.map((candidate) => candidate.name));

  for (const candidate of known) {
    for (const spelling of [candidate.name, ...(candidate.aliases ?? [])]) {
      const key = fold({ name: spelling });
      const owner = owners.get(key);

      if (owner === undefined) {
        owners.set(key, [candidate.name]);
      } else if (!owner.includes(candidate.name)) {
        owner.push(candidate.name);
      }
    }

    const key = fold({ name: candidate.name });

    if (!canonical.has(key)) {
      canonical.set(key, candidate.name);
    }
  }

  const names: string[] = [];
  const unknown: string[] = [];
  const ambiguous: AmbiguousName[] = [];

  for (const name of typed) {
    const candidates = owners.get(fold({ name })) ?? [];

    if (candidates.length > 1) {
      // Reported even when `name` matches one of them exactly. The operator who
      // types `Order` at a schema carrying `Order` and `order` is refusing "the
      // orders table", and half of it would stay reachable without a word said.
      ambiguous.push({ typed: name, candidates });
      continue;
    }

    const resolved = exact.has(name) ? name : canonical.get(fold({ name }));

    if (resolved === undefined) {
      unknown.push(name);
      continue;
    }

    if (!names.includes(resolved)) {
      names.push(resolved);
    }
  }

  return { names, unknown, ambiguous };
};

/**
 * The refusal for a name that could mean either of two models whose source
 * names differ only in case. It names both, because the remedy is to type one
 * of them: the allocator has already given the second one a distinct scanned
 * name, and the scan warning above this refusal says which.
 */
export const ambiguityDetail = ({ ambiguous }: { ambiguous: AmbiguousName[] }): string =>
  ambiguous.map((entry) => entry.candidates.join(' or ')).join('; ');

const ambiguityRefusal = ({
  flag,
  ambiguous,
}: {
  flag: string;
  ambiguous: AmbiguousName[];
}): string =>
  `ambiguous model ${quoteAll({ values: ambiguous.map((entry) => entry.typed) })} in ${flag} — ` +
  `it could mean ${ambiguityDetail({ ambiguous })}, whose source names differ only in case. ` +
  'Name the one you mean exactly as this scan reports it — choosing for you would decide which ' +
  'table an agent can reach on a coin flip.';

/**
 * Refuse a `--sources` that is not a scanner or a `--models` / `--exclude` that
 * names something this repo does not have, and return the selection with every
 * surviving model name resolved to its scanned spelling (ONT-063).
 *
 * Mirrors the `--preset` refusal exactly — the message names the offending
 * value(s) and the valid set, and it runs before codegen, so nothing is written.
 * A selection that matches everything, or is absent, is a no-op.
 *
 * The return value is the whole point and is not optional: the caller must go on
 * with THESE options, because they are the only ones whose names match what the
 * scan, the codegen and the recorded baseline all compare against.
 */
export const resolveSelection = ({
  source,
  options,
}: {
  source: ScannedSource;
  options: ResolvedInit;
}): ResolvedInit => {
  const unknownSources = (options.sources ?? []).filter((name) => !SOURCE_NAMES.includes(name));

  if (unknownSources.length > 0) {
    throw new Error(
      `unknown source ${quoteAll({ values: unknownSources })} — expected one of ${SOURCE_NAMES.join(', ')}`,
    );
  }

  const scanned = source.objects.map((object) => object.name);
  const known = scanned.length === 0 ? '(this repo has no scanned models)' : scanned.join(', ');
  const candidates = candidatesOf({ source });

  const models = resolveNames({ typed: options.models ?? [], known: candidates });

  if (models.unknown.length > 0) {
    throw new Error(
      `unknown model ${quoteAll({ values: models.unknown })} — expected one of ${known}`,
    );
  }

  if (models.ambiguous.length > 0) {
    throw new Error(ambiguityRefusal({ flag: '--models', ambiguous: models.ambiguous }));
  }

  const exclude = resolveNames({ typed: options.exclude ?? [], known: candidates });

  // A typo'd `--exclude` is worse than a typo'd `--models`, because the refusal
  // it writes outlives this run: `orangerail sync` would keep reporting the table
  // the operator believed they had refused, while the deny-list quietly carried a
  // name that matches nothing.
  if (exclude.unknown.length > 0) {
    throw new Error(
      `unknown model ${quoteAll({ values: exclude.unknown })} in --exclude — expected one of ${known}`,
    );
  }

  if (exclude.ambiguous.length > 0) {
    throw new Error(ambiguityRefusal({ flag: '--exclude', ambiguous: exclude.ambiguous }));
  }

  // On RESOLVED names, so `--models Payment --exclude payment` is the same
  // contradiction as `--models Payment --exclude Payment`. Comparing what was
  // typed would let a difference in casing smuggle one model into both lists,
  // and `applyFilters` would then generate it and record it as refused.
  const contradictory = models.names.filter((name) => exclude.names.includes(name));

  // Neither precedence rule is honest here: whichever flag won, half of what the
  // operator typed would be discarded without a word, and the half discarded
  // decides whether a table is on the agent's surface.
  if (contradictory.length > 0) {
    throw new Error(
      `${quoteAll({ values: contradictory })} appears in both --models and --exclude — ` +
        'keep it or refuse it, not both',
    );
  }

  // Counted in models, not in typed strings: `--exclude PAYMENT,payment` on a
  // two-model schema names one model, and refusing it here would be a refusal
  // over an arithmetic accident.
  if (exclude.names.length > 0 && scanned.every((name) => exclude.names.includes(name))) {
    throw new Error('--exclude names every scanned model — there would be nothing left to govern');
  }

  return {
    ...options,
    ...(options.models === undefined ? {} : { models: models.names }),
    ...(options.exclude === undefined ? {} : { exclude: exclude.names }),
  };
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
 * other, and `resolveSelection` has already refused a name given to both — so
 * `--models` answers "which of these do I want" and `--exclude` answers "which of
 * these have I refused", and no name has to mean both at once.
 *
 * Both comparisons are exact, and stay exact: the names arriving here have
 * already been resolved to the scanned spelling by `resolveSelection` (ONT-063).
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
    // governed, never WHICH database they live in (ONT-049). The client
    // generator survives for the same reason — narrowing the model set does not
    // move where the client was generated (ONT-067).
    ...(source.datasource === undefined ? {} : { datasource: source.datasource }),
    ...(source.generator === undefined ? {} : { generator: source.generator }),
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
