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

  return merged;
};

/** Whether a scanned source contains anything to generate. */
export const hasScannedContent = ({ source }: { source: ScannedSource }): boolean =>
  source.objects.length > 0 || source.actions.length > 0;
