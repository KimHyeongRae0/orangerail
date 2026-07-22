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

  return dedupeActionNames({ source: merged });
};

/**
 * Make action names unique across all scanned sources. Sanitization truncates
 * to the 64-char MCP budget, so two distinct operationIds can collapse into
 * one name (real-world case: GitHub's `…organization-definitions` /
 * `…organization-definition` pair) — without this pass the later action
 * silently overwrites the earlier file. Collisions get a deterministic
 * `_2`/`_3`… suffix (fitted inside the 64-char budget) and a warning.
 */
export const dedupeActionNames = ({ source }: { source: ScannedSource }): ScannedSource => {
  const used = new Set<string>();
  const warnings: string[] = [];

  const actions = source.actions.map((action) => {
    if (!used.has(action.name)) {
      used.add(action.name);
      return action;
    }

    let counter = 2;
    let candidate: string;
    do {
      const suffix = `_${counter}`;
      candidate = `${action.name.slice(0, 64 - suffix.length)}${suffix}`;
      counter += 1;
    } while (used.has(candidate));
    used.add(candidate);

    warnings.push(
      `scan: '${action.rawName ?? action.name}' sanitizes to '${action.name}', which is already taken — renamed to '${candidate}'`,
    );

    return { ...action, name: candidate, rawName: action.rawName ?? action.name };
  });

  return { ...source, actions, warnings: [...source.warnings, ...warnings] };
};

/** Whether a scanned source contains anything to generate. */
export const hasScannedContent = ({ source }: { source: ScannedSource }): boolean =>
  source.objects.length > 0 || source.actions.length > 0;
