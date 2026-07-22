import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { GeneratedFile } from './codegen';

/**
 * Atomic, self-validating generation (plan D9). The full file set is rendered
 * in memory, then — when the generated code's two bare specifiers
 * (`orangerail-core`, `zod`) resolve from the target repo — staged inside the
 * repo (`.orangerail/.init-staging-<pid>/`) and smoke-loaded once so the registry
 * and store are proven to construct BEFORE anything lands in place. The staging
 * dir is removed on every exit path; a failed smoke load or a SIGINT leaves the
 * repo untouched. When the specifiers do not resolve, the files are still
 * written (deterministic) but the smoke load and studio handoff are skipped and
 * the exact install command is printed as the stated next step.
 */

const REQUIRED_SPECIFIERS = ['orangerail-core', 'zod'];

/** Resolve one specifier from the target repo (throws when unresolvable). */
type SpecifierResolver = ({ specifier }: { specifier: string }) => void;

const repoResolver = ({ cwd }: { cwd: string }): SpecifierResolver => {
  const require = createRequire(join(cwd, 'package.json'));

  return ({ specifier }) => {
    require.resolve(specifier);
  };
};

/**
 * Whether the generated code's bare specifiers resolve from the target repo.
 * The resolver is injectable so the degrade branch (D9) is unit-testable
 * without depending on the ambient module-resolution paths, which leak the
 * workspace under a test runner.
 */
export const specifiersResolvable = ({
  cwd,
  resolver,
}: {
  cwd: string;
  resolver?: SpecifierResolver | undefined;
}): boolean => {
  const resolve = resolver ?? repoResolver({ cwd });

  try {
    for (const specifier of REQUIRED_SPECIFIERS) {
      resolve({ specifier });
    }

    return true;
  } catch {
    return false;
  }
};

/** Write a file set under `baseDir`, creating parent directories as needed. */
export const writeFileSet = ({
  files,
  baseDir,
}: {
  files: GeneratedFile[];
  baseDir: string;
}): void => {
  for (const file of files) {
    const target = join(baseDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
};

/**
 * Stage the file set inside the repo and dynamic-import the config once,
 * validating that `{ registry, store }` construct (AC-5 pre-verification). The
 * staged config resolves bare specifiers exactly as the final location will
 * (both inside the repo). Throws with a clear message when the smoke load fails
 * or the module does not export a usable config. The staging dir is always
 * removed.
 */
export const smokeLoadStaged = async ({
  files,
  cwd,
}: {
  files: GeneratedFile[];
  cwd: string;
}): Promise<void> => {
  const stagingDir = join(cwd, '.orangerail', `.init-staging-${process.pid}`);

  rmSync(stagingDir, { recursive: true, force: true });

  try {
    writeFileSet({ files, baseDir: stagingDir });

    const configPath = join(stagingDir, 'orangerail.config.mjs');
    const module: unknown = await import(pathToFileURL(configPath).href);
    const config = (module as { default?: { registry?: unknown; store?: unknown } }).default;

    if (!config || !config.registry || !config.store) {
      throw new Error('generated config did not export a usable { registry, store }');
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
};
