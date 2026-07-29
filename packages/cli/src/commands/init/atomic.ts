import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { GeneratedFile } from './codegen';

/**
 * Atomic, self-validating generation (plan D9). The full file set is rendered
 * in memory, then staged inside the repo (`.orangerail/.init-staging-<pid>/`)
 * and smoke-loaded once so the registry and store are proven to construct
 * BEFORE anything lands in place. The staging dir is removed on every exit path,
 * so pre-verification leaves the repo byte-identical whatever it concludes.
 *
 * Pre-verification never aborts the run. It returns a verdict — `ok` unlocks the
 * docs/studio handoff, `missing-deps` prints the install command, `load-failed`
 * prints the loader's own message — and the deterministic file set is written in
 * all three cases. A pre-flight opinion must cost at most the handoff, never the
 * user's whole `init`.
 *
 * Writes are one-way: `writeFileSet` refuses to overwrite an existing target, so
 * "these files are yours" holds at the layer that actually touches the disk.
 */

const REQUIRED_SPECIFIERS = ['orangerail-core', 'zod'];

/** Resolve one specifier the way the generated code's loader will (throws when it cannot). */
type SpecifierResolver = ({ specifier }: { specifier: string }) => Promise<void>;

/** Outcome of staged pre-verification — a verdict, never an exception. */
export type StagedVerdict =
  | { ok: true }
  | { ok: false; kind: 'missing-deps' }
  | { ok: false; kind: 'load-failed'; detail: string };

/**
 * Run `body` against a freshly created staging dir inside the repo, removing it
 * on every exit path — including a SIGINT-free throw from the body.
 */
const withStagingDir = async <T>({
  cwd,
  body,
}: {
  cwd: string;
  body: ({ dir }: { dir: string }) => Promise<T>;
}): Promise<T> => {
  const stagingDir = join(cwd, '.orangerail', `.init-staging-${process.pid}`);

  rmSync(stagingDir, { recursive: true, force: true });

  try {
    mkdirSync(stagingDir, { recursive: true });

    return await body({ dir: stagingDir });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });

    // The `.orangerail` parent created for staging is removed too when it ended
    // up empty (rmdirSync refuses non-empty dirs, so a real `.orangerail` is
    // never touched).
    try {
      rmdirSync(dirname(stagingDir));
    } catch {
      /* non-empty or absent — leave it */
    }
  }
};

/**
 * Ask the ESM loader itself whether a bare specifier resolves from where the
 * generated code will live, by importing a one-line probe module staged beside
 * it.
 *
 * It has to be that loader and nothing cheaper, because both cheaper probes
 * disagree with it in exactly the case that matters:
 *
 *   - CJS `require.resolve` honors `NODE_PATH`, which pnpm's bin shim and
 *     `pnpm dlx` both export at `.pnpm/node_modules`. The ESM loader ignores
 *     `NODE_PATH` entirely, so CJS answers "yes" for a package `import()` cannot
 *     see — the false verdict that used to send every pnpm user into the
 *     smoke-load branch and abort their `init`. The `paths` option does not help;
 *     `NODE_PATH` arrives through the always-added global folders.
 *   - `import.meta.resolve` has the right semantics, but pointing it at another
 *     parent needs `--experimental-import-meta-resolve`. Without the flag the
 *     `parent` argument is silently ignored and resolution happens from THIS
 *     bundle, which lists `orangerail-core` among its own dependencies — a
 *     second false "yes", and a silent one.
 *
 * Importing a staged probe needs no flag and cannot disagree with the smoke load
 * that follows: same loader, same directory, same resolution root.
 */
const esmProbe =
  ({ dir }: { dir: string }): SpecifierResolver =>
  async ({ specifier }) => {
    const probePath = join(dir, `.probe-${specifier.replace(/[^a-z0-9]+/gi, '-')}.mjs`);

    writeFileSync(probePath, `import ${JSON.stringify(specifier)};\n`, 'utf8');

    await import(pathToFileURL(probePath).href);
  };

/**
 * Stage the file set inside the repo, prove the generated code's dependencies
 * load from there, and smoke-load the config once so `{ registry, store }` is
 * known to construct (AC-5 pre-verification) — all without touching anything in
 * place.
 *
 * `resolver` is injectable so both degrade branches stay unit-testable without
 * depending on the ambient module-resolution paths, which leak the workspace
 * under a test runner.
 */
export const verifyStaged = async ({
  files,
  cwd,
  resolver,
}: {
  files: GeneratedFile[];
  cwd: string;
  resolver?: SpecifierResolver | undefined;
}): Promise<StagedVerdict> =>
  withStagingDir({
    cwd,
    body: async ({ dir }): Promise<StagedVerdict> => {
      const resolve = resolver ?? esmProbe({ dir });

      for (const specifier of REQUIRED_SPECIFIERS) {
        try {
          await resolve({ specifier });
        } catch {
          return { ok: false, kind: 'missing-deps' };
        }
      }

      try {
        writeFileSet({ files, baseDir: dir });

        const configPath = join(dir, 'orangerail.config.mjs');
        const module: unknown = await import(pathToFileURL(configPath).href);
        const config = (module as { default?: { registry?: unknown; store?: unknown } }).default;

        if (!config || !config.registry || !config.store) {
          return {
            ok: false,
            kind: 'load-failed',
            detail: 'it did not export a usable { registry, store }',
          };
        }
      } catch (error) {
        return {
          ok: false,
          kind: 'load-failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }

      return { ok: true };
    },
  });

/** Generated targets that already exist under `baseDir` (the clobber guard). */
export const existingTargets = ({
  files,
  baseDir,
}: {
  files: GeneratedFile[];
  baseDir: string;
}): string[] => files.map((file) => file.path).filter((path) => existsSync(join(baseDir, path)));

/**
 * Write a file set under `baseDir`, creating parent directories as needed.
 *
 * Never overwrites. Every path in a generated set is one `init` promises belongs
 * to the user ("re-scans never modify them"), so an existing target is
 * hand-edited work rather than a stale artifact, and the write layer refuses
 * instead of trusting its caller to have looked. Callers that can phrase a
 * better refusal check `existingTargets` first; this throw is the backstop no
 * future path can walk past.
 */
export const writeFileSet = ({
  files,
  baseDir,
}: {
  files: GeneratedFile[];
  baseDir: string;
}): void => {
  const existing = existingTargets({ files, baseDir });

  if (existing.length > 0) {
    throw new Error(
      `refusing to overwrite ${existing.length} existing file(s) under ${baseDir}: ${existing.join(', ')}`,
    );
  }

  for (const file of files) {
    const target = join(baseDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
};

/** How many colliding paths a refusal lists before it summarizes the rest. */
const MAX_LISTED_COLLISIONS = 8;

/**
 * The refusal shown when `init` would generate over files that already exist —
 * the config front door's promise (init never overwrites your ontology) applied
 * to the case where the config is gone but the ontology is not.
 */
export const clobberRefusal = ({ existing }: { existing: string[] }): string => {
  const listed = existing.slice(0, MAX_LISTED_COLLISIONS);
  const rest = existing.length - listed.length;

  return (
    'orangerail init: these files already exist here — init never overwrites your ontology.\n' +
    listed.map((path) => `  ${path}\n`).join('') +
    (rest > 0 ? `  … and ${rest} more\n` : '') +
    'Move them aside and re-run, or restore your orangerail config and run `orangerail sync` to review drift.\n'
  );
};

/**
 * The stated next step when pre-verification degraded. `missing-deps` is the
 * ordinary "the runtime is not installed yet" case (the one pnpm users reach);
 * `load-failed` means the dependencies are there but the generated code did not
 * construct — the files are still written and still theirs, and the handoff is
 * the only thing skipped.
 */
export const degradeNotice = ({
  verdict,
}: {
  verdict: Extract<StagedVerdict, { ok: false }>;
}): string =>
  verdict.kind === 'missing-deps'
    ? '\nNext step: install the runtime deps so the generated code can load:\n' +
      '  npm install orangerail-core zod\n' +
      'Then run `orangerail studio` or `orangerail mcp`.\n'
    : `\nNote: the generated config did not load here — ${verdict.detail}\n` +
      'The files above are written and yours to edit; the studio handoff was skipped.\n' +
      'Fix or report that error, then run `orangerail studio`.\n';
