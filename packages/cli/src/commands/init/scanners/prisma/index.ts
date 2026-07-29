import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Scanner } from '../types';
import { mapPrismaToIr } from './map';
import { parsePrismaSchema } from './parse';

/** Conventional root Prisma schema locations, in detection order. */
const CANDIDATES = ['prisma/schema.prisma', 'schema.prisma'];

/**
 * Conventional multi-file (`prismaSchemaFolder`) schema DIRECTORIES, in
 * detection order (ONT-042 D). The layout is GA in Prisma; before this the
 * candidate list held single files only, so a repo whose whole schema lives in
 * `prisma/schema/*.prisma` was told nothing was found.
 */
const FOLDER_CANDIDATES = ['prisma/schema'];

/** How deep a schema folder's subdirectories are walked (Prisma allows nesting). */
const MAX_FOLDER_DEPTH = 4;

/** Whether a path exists and is a directory (a schema folder, not a schema file). */
const isDirectory = ({ path }: { path: string }): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Every `*.prisma` file under a schema folder, recursively within
 * `MAX_FOLDER_DEPTH` and sorted by path so the concatenation order — and
 * therefore the generated output — is deterministic.
 */
const schemaFolderFiles = ({ dir, depth = 0 }: { dir: string; depth?: number }): string[] => {
  if (depth > MAX_FOLDER_DEPTH) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.prisma'))
    .map((entry) => join(dir, entry.name));

  const nested = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => schemaFolderFiles({ dir: join(dir, entry.name), depth: depth + 1 }));

  return [...files, ...nested];
};

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
 * workspace subdir applies EVERY root candidate shape in the same order —
 * `<workspace>/<dir>/prisma/schema.prisma`, `<workspace>/<dir>/schema.prisma`,
 * then `<workspace>/<dir>/prisma/schema/` — so a package named `prisma` holding
 * the schema directly (cal.com's real layout) and a package on the multi-file
 * layout are both found. Subdirs come from a single `readdirSync` per workspace
 * dir. No recursion, no full-tree crawl — deterministic and bounded (plan I1).
 */
const candidatePaths = ({ cwd }: { cwd: string }): string[] => {
  const shapes = [...CANDIDATES, ...FOLDER_CANDIDATES];
  const roots = shapes.map((rel) => join(cwd, rel));

  const nested = WORKSPACE_DIRS.flatMap((workspace) =>
    workspaceSubdirs({ cwd, workspace }).flatMap((dir) =>
      shapes.map((rel) => join(cwd, workspace, dir, rel)),
    ),
  );

  return [...roots, ...nested];
};

/**
 * Whether a candidate path is a real schema source: an existing file, or a
 * schema FOLDER that actually holds at least one `*.prisma` file (an empty
 * `prisma/schema/` must not become a phantom candidate).
 */
const isSchemaSource = ({ path }: { path: string }): boolean => {
  if (!existsSync(path)) {
    return false;
  }

  return isDirectory({ path }) ? schemaFolderFiles({ dir: path }).length > 0 : true;
};

/**
 * The schema text for one detected source. A `prismaSchemaFolder` directory is
 * read as ONE logical schema — its files are concatenated before parsing rather
 * than scanned one by one — because a multi-file schema splits models across
 * files freely: parsing `user.prisma` alone would not know that the `Post` in
 * `posts Post[]` is a model declared in `post.prisma`, and would report the
 * relation as an unsupported field type.
 */
const readSchemaSource = ({ filePath }: { filePath: string }): string =>
  isDirectory({ path: filePath })
    ? schemaFolderFiles({ dir: filePath })
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n')
    : readFileSync(filePath, 'utf8');

/**
 * The Prisma scanner (plan D3). `detect` looks for a schema at the conventional
 * root paths — single-file AND the `prismaSchemaFolder` directory layout — plus
 * one bounded level of monorepo workspace dirs (`packages/*`/`apps/*`),
 * returning every hit in detection order (root first); the init orchestrator
 * scans and merges all of them. `scan` reads, parses, and maps a schema into the
 * shared IR, treating a detected FOLDER as one schema. It only ever reads the
 * schema source (never the generated client), so init succeeds even when
 * `@prisma/client` is absent —
 * a missing client surfaces later as a tool-call-time error from the generated
 * lazy import (D6).
 */
export const prismaScanner: Scanner = {
  name: 'prisma',

  detect: ({ cwd }) => candidatePaths({ cwd }).filter((abs) => isSchemaSource({ path: abs })),

  scan: ({ filePath }) => {
    const source = readSchemaSource({ filePath });
    const parsed = parsePrismaSchema({ source });

    return mapPrismaToIr({ parsed });
  },
};
