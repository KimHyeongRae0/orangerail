import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Scanner } from '../types';
import { mapPrismaToIr } from './map';
import { parsePrismaSchema } from './parse';

/** Conventional root Prisma schema locations, in detection order. */
const CANDIDATES = ['prisma/schema.prisma', 'schema.prisma'];

/** Monorepo workspace roots whose immediate children hold nested schemas. */
const WORKSPACE_DIRS = ['packages', 'apps'];

/**
 * Immediate subdirectory names of `<cwd>/<workspace>`, sorted lexicographically.
 * A missing workspace dir yields an empty list; only directories are returned,
 * so a stray file under `packages/` never contributes a phantom candidate.
 */
const workspaceSubdirs = ({ cwd, workspace }: { cwd: string; workspace: string }): string[] => {
  const abs = join(cwd, workspace);

  if (!existsSync(abs)) {
    return [];
  }

  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
};

/**
 * The full ordered list of candidate schema paths for a repo: root candidates
 * first (they keep priority), then one bounded level of workspace dirs. Each
 * workspace subdir applies BOTH root candidate shapes in the same order —
 * `<workspace>/<dir>/prisma/schema.prisma` then `<workspace>/<dir>/schema.prisma`
 * — so a package named `prisma` holding the schema directly (cal.com's real
 * layout) is found too. Subdirs come from a single `readdirSync` per workspace
 * dir. No recursion, no full-tree crawl — deterministic and bounded (plan I1).
 */
const candidatePaths = ({ cwd }: { cwd: string }): string[] => {
  const roots = CANDIDATES.map((rel) => join(cwd, rel));

  const nested = WORKSPACE_DIRS.flatMap((workspace) =>
    workspaceSubdirs({ cwd, workspace }).flatMap((dir) =>
      CANDIDATES.map((rel) => join(cwd, workspace, dir, rel)),
    ),
  );

  return [...roots, ...nested];
};

/**
 * The Prisma scanner (plan D3). `detect` looks for a schema at the conventional
 * root paths plus one bounded level of monorepo workspace dirs
 * (`packages/*`/`apps/*`), returning every hit in detection order (root first);
 * the init orchestrator scans and merges all of them. `scan` reads, parses, and
 * maps a schema into the shared IR. It only ever reads the schema file (never
 * the generated client), so init succeeds even when `@prisma/client` is absent —
 * a missing client surfaces later as a tool-call-time error from the generated
 * lazy import (D6).
 */
export const prismaScanner: Scanner = {
  name: 'prisma',

  detect: ({ cwd }) => candidatePaths({ cwd }).filter((abs) => existsSync(abs)),

  scan: ({ filePath }) => {
    const source = readFileSync(filePath, 'utf8');
    const parsed = parsePrismaSchema({ source });

    return mapPrismaToIr({ parsed });
  },
};
