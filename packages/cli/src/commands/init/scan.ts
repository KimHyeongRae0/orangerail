import { sanitizeIdentifier } from './codegen/escape';
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
 * Fit a deterministic `_2`/`_3`… suffix onto `base` inside the 64-char budget,
 * skipping any candidate whose emitted identifier is already claimed. Returns
 * the chosen name (the suffix lands on the raw `base`; the caller keys `used`
 * on the emitted identifier). Shared by the object and action passes so there
 * is exactly one suffixing implementation (ONT-015).
 */
const allocateSuffix = ({ base, used }: { base: string; used: Set<string> }): string => {
  let counter = 2;
  let candidate: string;
  do {
    const suffix = `_${counter}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    counter += 1;
  } while (used.has(sanitizeIdentifier({ value: candidate })));

  return candidate;
};

/**
 * The global name/filename allocator (ONT-015, promoted from the former
 * action-only `dedupeActionNames`). It claims a single namespace — the emitted
 * identifier `sanitizeIdentifier(name)`, which is BOTH the `export const`
 * binding AND the `ontology/<stem>.mjs` filename stem (1:1) — across objects
 * then actions, so object-object, object-vs-action, and action-action filename
 * collisions all resolve in one pass.
 *
 * Claim order is deterministic: objects first (in `source.objects` order), then
 * actions (in `source.actions` order). The first claimant of an identifier keeps
 * its un-suffixed name; the 2nd+ collider is renamed with a deterministic
 * `_N` suffix and a surfaced warning. This preserves the prior action-only
 * allocation order exactly (actions still claim in array order, only now after
 * objects) and makes object-vs-action clashes resolve toward the object keeping
 * its slot. Renaming the IR `name` (the mechanism the old pass already used)
 * keeps `buildFileSet` a pure renderer over an already-collision-free source.
 *
 * NO-OP on non-colliding input: with no two names sanitizing to the same
 * identifier, `used` never hits, every name is emitted unchanged, and no warning
 * is pushed — so a well-formed schema stays byte-identical (AC-5).
 */
export const allocateNames = ({ source }: { source: ScannedSource }): ScannedSource => {
  const used = new Set<string>();
  const warnings: string[] = [];

  const objects = source.objects.map((object) => {
    const id = sanitizeIdentifier({ value: object.name });
    if (!used.has(id)) {
      used.add(id);
      return object;
    }

    const candidate = allocateSuffix({ base: object.name, used });
    used.add(sanitizeIdentifier({ value: candidate }));

    warnings.push(
      `scan: object '${object.name}' maps to identifier '${id}', which is already taken — renamed to '${candidate}'`,
    );

    return { ...object, name: candidate };
  });

  const actions = source.actions.map((action) => {
    const id = sanitizeIdentifier({ value: action.name });
    if (!used.has(id)) {
      used.add(id);
      return action;
    }

    const candidate = allocateSuffix({ base: action.name, used });
    used.add(sanitizeIdentifier({ value: candidate }));

    warnings.push(
      `scan: '${action.rawName ?? action.name}' sanitizes to '${action.name}', which is already taken — renamed to '${candidate}'`,
    );

    return { ...action, name: candidate, rawName: action.rawName ?? action.name };
  });

  return { ...source, objects, actions, warnings: [...source.warnings, ...warnings] };
};

/** Whether a scanned source contains anything to generate. */
export const hasScannedContent = ({ source }: { source: ScannedSource }): boolean =>
  source.objects.length > 0 || source.actions.length > 0;
