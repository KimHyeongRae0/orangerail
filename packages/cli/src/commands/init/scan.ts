import { sanitizeIdentifier, sanitizeObjectName } from './codegen/escape';
import { emptySource, mergeSources, type ScannedSource } from './ir';
import { prismaScanner } from './scanners/prisma';
import { hasYamlSpec, openapiScanner, YAML_HINT } from './scanners/openapi/scan';
import type { Scanner } from './scanners/types';

/** The registered scanners (plan D2/AC-8: add a source = extend this list). */
export const SCANNERS: Scanner[] = [prismaScanner, openapiScanner];

/**
 * Run every registered scanner over the target repo and merge the results into
 * one scanned source. When no OpenAPI JSON is found but a YAML spec sits in the
 * repo, the actionable convert-to-JSON hint is surfaced as a warning so a
 * YAML-first user is never told "nothing found" (plan D4, agent review note 2).
 */
export const scanRepo = ({ cwd }: { cwd: string }): ScannedSource => {
  let merged = emptySource();

  for (const scanner of SCANNERS) {
    for (const filePath of scanner.detect({ cwd })) {
      merged = mergeSources({ a: merged, b: scanner.scan({ filePath }) });
    }
  }

  const foundOpenApi = openapiScanner.detect({ cwd }).length > 0;
  if (!foundOpenApi && hasYamlSpec({ cwd })) {
    merged.warnings.push(YAML_HINT);
  }

  return allocateNames({ source: merged });
};

/**
 * The key one emitted name claims in the filename namespace: its emitted
 * identifier, CASE-FOLDED (ONT-041). The identifier is the `ontology/<stem>.mjs`
 * filename stem, and macOS/Windows filesystems compare stems case-insensitively
 * — so Prisma's legal `model user` + `model User` pair emitted `user.mjs` and
 * `User.mjs`, the second write clobbered the first, and the surviving file was
 * imported under both spellings. Node's ESM loader keys modules by URL string,
 * so the same inode then evaluated twice and `defineObject` ran twice
 * ("duplicate object name"). Folding the key makes the allocation
 * filesystem-INDEPENDENT: the pair de-collides on Linux exactly as it does on
 * macOS, so a project generated on one platform is the project generated on the
 * other.
 */
const collisionKey = ({ name }: { name: string }): string =>
  sanitizeIdentifier({ value: name }).toLowerCase();

/**
 * Fit a deterministic `_2`/`_3`… suffix onto `base` inside `budget` characters,
 * skipping any candidate whose collision key is already claimed. Returns the
 * chosen name (the suffix lands on the raw `base`; the caller keys `used` on
 * the collision key). Shared by the object and action passes so there is
 * exactly one suffixing implementation (ONT-015); objects pass the smaller
 * `OBJECT_NAME_BUDGET` so a renamed object still leaves room for the MCP
 * server's derived `_get`/`_list` suffix (ONT-041).
 */
const allocateSuffix = ({
  base,
  used,
  budget,
}: {
  base: string;
  used: Map<string, string>;
  budget: number;
}): string => {
  let counter = 2;
  let candidate: string;
  do {
    const suffix = `_${counter}`;
    candidate = `${base.slice(0, budget - suffix.length)}${suffix}`;
    counter += 1;
  } while (used.has(collisionKey({ name: candidate })));

  return candidate;
};

/** The length cap an action's registry name may use (it IS the MCP tool name). */
const ACTION_NAME_BUDGET = 64;

/** The length cap an object's registry name may use — `sanitizeObjectName`'s. */
const OBJECT_NAME_BUDGET = sanitizeObjectName({ value: 'a'.repeat(80) }).length;

/**
 * The global name/filename allocator (ONT-015, promoted from the former
 * action-only `dedupeActionNames`). It claims a single namespace — the emitted
 * identifier `sanitizeIdentifier(name)` CASE-FOLDED, which is BOTH the
 * `export const` binding AND the `ontology/<stem>.mjs` filename stem (1:1) —
 * across objects then actions, so object-object, object-vs-action, and
 * action-action filename collisions all resolve in one pass, identically on a
 * case-sensitive and a case-insensitive filesystem (ONT-041, see
 * `collisionKey`).
 *
 * Objects additionally pass through `sanitizeObjectName` FIRST (ONT-041): the
 * MCP server derives `<name>_get` / `<name>_list` from an object's registry
 * name, so an object name that is not MCP-legal (or is too long to carry the
 * derived suffix) made `orangerail mcp` refuse to boot on generated output.
 * Actions were already minted through the MCP-name sink upstream; this closes
 * the same hole on the object side, and — like the action sink — it RENAMES
 * with a surfaced warning rather than aborting init.
 *
 * Claim order is deterministic: objects first (in `source.objects` order), then
 * actions (in `source.actions` order). The first claimant of a key keeps its
 * un-suffixed name; the 2nd+ collider is renamed with a deterministic `_N`
 * suffix and a warning that NAMES BOTH colliding sources. This preserves the
 * prior action-only allocation order exactly (actions still claim in array
 * order, only now after objects) and makes object-vs-action clashes resolve
 * toward the object keeping its slot. Renaming the IR `name` (the mechanism the
 * old pass already used) keeps `buildFileSet` a pure renderer over an
 * already-collision-free source.
 *
 * NO-OP on non-colliding input: with every name already MCP-legal and no two
 * names sharing a key, `used` never hits, every name is emitted unchanged, and
 * no warning is pushed — so a well-formed schema stays byte-identical (AC-5).
 */
export const allocateNames = ({ source }: { source: ScannedSource }): ScannedSource => {
  // collision key -> the name that claimed it, so a collision warning can name
  // BOTH sides rather than only the loser (ONT-041).
  const used = new Map<string, string>();
  const warnings: string[] = [];

  // original object name -> emitted object name, so a Prisma action's `model`
  // reference and a relation's `target` track the same rename the object got —
  // the action's `target:` import and the derived link both resolve to the file
  // that was actually written. The DATABASE accessor no longer rides on this
  // map: it is derived from the untouched `sourceModel` (ONT-041). No-op unless
  // a rename actually happens, so non-colliding input stays unchanged.
  const objectRenames = new Map<string, string>();

  const objects = source.objects.map((object) => {
    const mcpSafe = sanitizeObjectName({ value: object.name });

    if (mcpSafe !== object.name) {
      warnings.push(
        `scan: object '${object.name}' is not a usable MCP tool-name stem (the server derives '<name>_get' and '<name>_list' from it) — renamed to '${mcpSafe}'`,
      );
    }

    const key = collisionKey({ name: mcpSafe });
    const owner = used.get(key);

    const finalName =
      owner === undefined
        ? mcpSafe
        : allocateSuffix({ base: mcpSafe, used, budget: OBJECT_NAME_BUDGET });

    if (owner !== undefined) {
      warnings.push(
        `scan: object '${object.name}' collides with '${owner}' — both claim the file 'ontology/${sanitizeIdentifier({ value: owner })}.mjs' (filenames are matched case-insensitively) — renamed to '${finalName}'`,
      );
    }

    used.set(collisionKey({ name: finalName }), finalName);

    if (finalName === object.name) {
      return object;
    }

    objectRenames.set(object.name, finalName);

    // The schema's own model name is pinned so the emitter keeps deriving
    // `prisma.<accessor>` from it (ONT-041) — a rename must never move the
    // database accessor.
    return { ...object, name: finalName, sourceModel: object.sourceModel ?? object.name };
  });

  // Relations reference their target by object name; a renamed target would
  // otherwise dangle and its link would be silently dropped (`deriveLinks`
  // requires the target to be a known object name).
  const retargeted = objects.map((object) => ({
    ...object,
    relations: object.relations.map((relation) => {
      const renamed = objectRenames.get(relation.target);

      return renamed === undefined ? relation : { ...relation, target: renamed };
    }),
  }));

  const actions = source.actions.map((rawAction) => {
    const renamedModel =
      rawAction.prisma === undefined ? undefined : objectRenames.get(rawAction.prisma.model);

    const action =
      renamedModel === undefined || rawAction.prisma === undefined
        ? rawAction
        : {
            ...rawAction,
            prisma: {
              ...rawAction.prisma,
              model: renamedModel,
              sourceModel: rawAction.prisma.sourceModel ?? rawAction.prisma.model,
            },
          };

    const key = collisionKey({ name: action.name });
    const owner = used.get(key);

    if (owner === undefined) {
      used.set(key, action.name);
      return action;
    }

    const candidate = allocateSuffix({ base: action.name, used, budget: ACTION_NAME_BUDGET });
    used.set(collisionKey({ name: candidate }), candidate);

    warnings.push(
      `scan: '${action.rawName ?? action.name}' sanitizes to '${action.name}', which is already claimed by '${owner}' (filenames are matched case-insensitively) — renamed to '${candidate}'`,
    );

    return { ...action, name: candidate, rawName: action.rawName ?? action.name };
  });

  return {
    ...source,
    objects: retargeted,
    actions,
    warnings: [...source.warnings, ...warnings],
  };
};

/** Whether a scanned source contains anything to generate. */
export const hasScannedContent = ({ source }: { source: ScannedSource }): boolean =>
  source.objects.length > 0 || source.actions.length > 0;
