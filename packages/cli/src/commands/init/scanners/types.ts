import type { ScannedSource } from '../ir';

/**
 * The one interface both scanners implement (plan D2 / AC-8). `detect` finds
 * candidate source files in the target repo; `scan` parses a single file into
 * the shared IR. init and sync call `detect` then `scan` per file and merge —
 * neither knows anything about Prisma or OpenAPI specifically, so a future
 * source is a new module implementing this interface plus one registration.
 */
export interface Scanner {
  /** Stable scanner name (e.g. `'prisma'`, `'openapi'`) used in diagnostics. */
  name: string;
  /** Return absolute paths of candidate source files found under `cwd`. */
  detect: ({ cwd }: { cwd: string }) => string[];
  /** Parse one detected source file into the shared IR. */
  scan: ({ filePath }: { filePath: string }) => ScannedSource;
}
