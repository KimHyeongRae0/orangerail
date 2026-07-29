import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Which Prisma the generated ontology will run against, and therefore how it
 * must construct its client (ONT-049).
 *
 * Prisma 7 removed the no-argument constructor: `new PrismaClient()` throws
 * `PrismaClientInitializationError` ("A driver adapter is required to connect to
 * your database") before a single query runs. The emitter hard-coded the pre-7
 * form, so on the version `npm install prisma` resolves to today (7.9.1) `init`
 * printed its success banner over an ontology that could not construct a client
 * at all. Verified end to end in this ticket against PostgreSQL 16.14 with
 * prisma/@prisma/client 6.19.3 and 7.9.1.
 *
 * This module answers two questions from the TARGET repo's own files — never
 * from a guess:
 *
 *   1. Which Prisma major is installed (or, failing that, declared)?
 *   2. Which driver adapter package is installed, if any?
 *
 * The answers drive one of three outcomes in `init`: emit today's bare
 * construction (major < 7, or nothing resolvable — that is the pre-7 world and
 * its bytes must not move), emit an adapter construction (major >= 7 with a
 * supported adapter present), or REFUSE before writing a byte (major >= 7 with
 * no supported adapter — orangerail cannot install one and will not emit code
 * that cannot run).
 */

/** The environment variable the emitted construction reads when the schema names none. */
export const DEFAULT_URL_ENV = 'DATABASE_URL';

/** The first Prisma major that requires a driver adapter. */
export const ADAPTER_REQUIRED_MAJOR = 7;

/** How a driver-adapter class takes its connection URL. */
export type AdapterArgument = 'connection-string' | 'url-object';

/** A driver adapter the emitter knows how to construct. */
export interface PrismaAdapter {
  /** The npm package the generated code imports the adapter class from. */
  module: string;
  /** The class that package exports. */
  className: string;
  /** Whether the class takes the URL directly or wrapped in `{ url }`. */
  argument: AdapterArgument;
  /** The Prisma `datasource` providers this adapter serves. */
  providers: string[];
}

/**
 * The adapters the emitter will construct, and how.
 *
 * Every entry was checked against the real 7.9.1 package rather than recalled:
 * the export name comes from importing the module, and the argument shape from
 * its shipped `.d.ts` constructor signature. `@prisma/adapter-pg` was
 * additionally run end to end against a live PostgreSQL 16.14 — both
 * `new PrismaPg(url)` and `new PrismaPg({ connectionString: url })` return rows
 * — and `@prisma/adapter-better-sqlite3` was constructed live.
 * `@prisma/adapter-mariadb` and `@prisma/adapter-mssql` are signature-verified
 * only (`constructor(config: … | string)`); no MySQL or SQL Server was reachable
 * here to run a query through.
 *
 * Deliberately absent: `@prisma/adapter-neon`, `-planetscale`, `-libsql`, `-d1`.
 * Their constructors take driver-specific handles or HTTP configuration this
 * emitter has no way to synthesize from a connection URL, and none of them could
 * be exercised here. A repo that has one installed gets the refusal, not a guess.
 */
export const SUPPORTED_ADAPTERS: PrismaAdapter[] = [
  {
    module: '@prisma/adapter-pg',
    className: 'PrismaPg',
    argument: 'connection-string',
    providers: ['postgresql', 'postgres'],
  },
  {
    module: '@prisma/adapter-mariadb',
    className: 'PrismaMariaDb',
    argument: 'connection-string',
    providers: ['mysql'],
  },
  {
    module: '@prisma/adapter-mssql',
    className: 'PrismaMssql',
    argument: 'connection-string',
    providers: ['sqlserver'],
  },
  {
    module: '@prisma/adapter-better-sqlite3',
    className: 'PrismaBetterSqlite3',
    argument: 'url-object',
    providers: ['sqlite'],
  },
];

/** How the generated code constructs its Prisma client. */
export type PrismaConstruction =
  { kind: 'bare' } | { kind: 'adapter'; adapter: PrismaAdapter; urlEnv: string };

/** The pre-7 construction — the default everywhere, so untouched repos emit untouched bytes. */
export const BARE_CONSTRUCTION: PrismaConstruction = { kind: 'bare' };

/**
 * The major of a semver-ish string or range. Reads the first number sequence,
 * which is the floor major for every range npm actually writes into a
 * `package.json` (`6.19.3`, `^6.19.3`, `~7.0`, `>=7 <8`, `7.x`). Returns
 * `undefined` for a range with no number at all (`latest`, `*`, a `workspace:`
 * or `file:` protocol), because those name no major and a guess would be worse
 * than the pre-7 default.
 */
export const majorOf = ({ range }: { range: string }): number | undefined => {
  const match = /\d+/.exec(range);

  if (match === null) {
    return undefined;
  }

  const major = Number.parseInt(match[0], 10);

  return Number.isFinite(major) ? major : undefined;
};

/** Every directory from `cwd` up to the filesystem root, nearest first. */
const ancestors = ({ cwd }: { cwd: string }): string[] => {
  const dirs: string[] = [];

  let current = cwd;

  for (;;) {
    dirs.push(current);

    const parent = dirname(current);

    if (parent === current) {
      return dirs;
    }

    current = parent;
  }
};

/** Parse a JSON file, returning `undefined` rather than throwing on anything unreadable. */
const readJson = ({ path }: { path: string }): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));

    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The `version` an installed package's manifest declares, if it resolves from `cwd` upward. */
const installedVersion = ({ cwd, pkg }: { cwd: string; pkg: string }): string | undefined => {
  for (const dir of ancestors({ cwd })) {
    const manifest = join(dir, 'node_modules', ...pkg.split('/'), 'package.json');

    if (existsSync(manifest)) {
      const version = readJson({ path: manifest })?.['version'];

      if (typeof version === 'string') {
        return version;
      }
    }
  }

  return undefined;
};

/** The range the repo's own `package.json` declares for `pkg`, across every dependency field. */
const declaredRange = ({ cwd, pkg }: { cwd: string; pkg: string }): string | undefined => {
  const manifest = readJson({ path: join(cwd, 'package.json') });

  if (manifest === undefined) {
    return undefined;
  }

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = manifest[field];

    if (typeof deps === 'object' && deps !== null) {
      const range = (deps as Record<string, unknown>)[pkg];

      if (typeof range === 'string') {
        return range;
      }
    }
  }

  return undefined;
};

/** What the Prisma-major detection concluded, and the evidence it concluded it from. */
export interface PrismaMajor {
  major: number | undefined;
  /** Operator-facing evidence, e.g. `@prisma/client 7.9.1 (installed)`. */
  evidence: string;
}

/**
 * The Prisma major the generated code will run against.
 *
 * INSTALLED beats DECLARED, because the installed copy is the one the generated
 * `await import('@prisma/client')` will actually load — a `package.json` saying
 * `^6` over a hoisted 7 would be a lie the runtime does not honor. `@prisma/client`
 * is consulted before the `prisma` CLI for the same reason: the client is what
 * the ontology imports.
 *
 * Nothing resolvable returns `undefined`, which every caller treats as the pre-7
 * world. That is the safe default in both directions: a repo with no Prisma at
 * all emits no Prisma call sites anyway, and a repo whose layout hides its
 * install keeps today's bytes rather than being refused on a guess.
 */
export const detectPrismaMajor = ({ cwd }: { cwd: string }): PrismaMajor => {
  for (const pkg of ['@prisma/client', 'prisma']) {
    const version = installedVersion({ cwd, pkg });

    if (version !== undefined) {
      const major = majorOf({ range: version });

      if (major !== undefined) {
        return { major, evidence: `${pkg} ${version} (installed)` };
      }
    }
  }

  for (const pkg of ['@prisma/client', 'prisma']) {
    const range = declaredRange({ cwd, pkg });

    if (range !== undefined) {
      const major = majorOf({ range });

      if (major !== undefined) {
        return { major, evidence: `${pkg} ${range} (declared in package.json)` };
      }
    }
  }

  return { major: undefined, evidence: 'no Prisma resolvable from this directory' };
};

/** The first supported adapter package installed in the target repo, in table order. */
export const detectInstalledAdapter = ({ cwd }: { cwd: string }): PrismaAdapter | undefined =>
  SUPPORTED_ADAPTERS.find(
    (adapter) =>
      installedVersion({ cwd, pkg: adapter.module }) !== undefined ||
      declaredRange({ cwd, pkg: adapter.module }) !== undefined,
  );

/** The adapter that serves a Prisma `datasource` provider, when the table knows one. */
export const adapterForProvider = ({
  provider,
}: {
  provider: string | undefined;
}): PrismaAdapter | undefined =>
  provider === undefined
    ? undefined
    : SUPPORTED_ADAPTERS.find((adapter) => adapter.providers.includes(provider.toLowerCase()));

/**
 * The refusal shown when the repo is on Prisma 7+ and no supported driver
 * adapter is installed. It states the finding, the reason, the exact install
 * command (narrowed to the scanned provider when the schema declared one), and
 * the pin-to-6 escape hatch — and it is printed INSTEAD of generating, because
 * emitting a client construction that cannot construct is the failure this
 * ticket exists to remove.
 */
export const adapterRefusal = ({
  evidence,
  provider,
  docPath,
}: {
  evidence: string;
  provider: string | undefined;
  docPath: string;
}): string => {
  const match = adapterForProvider({ provider });

  const install =
    match === undefined
      ? SUPPORTED_ADAPTERS.map(
          (adapter) => `  npm install ${adapter.module}   # ${adapter.providers.join(' / ')}\n`,
        ).join('')
      : `  npm install ${match.module}\n`;

  const providerLine =
    provider === undefined
      ? 'Your schema declares no datasource provider, so pick the adapter for your database:\n'
      : `Your datasource provider is \`${provider}\`, so install:\n`;

  return (
    `orangerail init: this repo is on Prisma ${ADAPTER_REQUIRED_MAJOR}+ (${evidence}) and no supported driver adapter is installed.\n` +
    'Prisma 7 removed the no-argument client constructor — generated code must pass a driver\n' +
    'adapter, and orangerail will not write an ontology that cannot construct a client.\n\n' +
    providerLine +
    install +
    '\nThen re-run `orangerail init`.\n' +
    `Staying on Prisma 6 also works: \`npm install prisma@6 @prisma/client@6\`.\n` +
    `See ${docPath} for the full existing-database walkthrough.\n`
  );
};

/**
 * Decide how the generated code should construct its client, or refuse.
 *
 * `hasPrismaCallSites` is the gate: an OpenAPI-only scan emits no
 * `@prisma/client` import at all, so the Prisma major is irrelevant there and a
 * repo that happens to carry Prisma 7 for unrelated reasons must not be refused.
 */
export const resolvePrismaConstruction = ({
  cwd,
  provider,
  urlEnv,
  hasPrismaCallSites,
  docPath,
}: {
  cwd: string;
  provider: string | undefined;
  urlEnv: string | undefined;
  hasPrismaCallSites: boolean;
  docPath: string;
}): { ok: true; construction: PrismaConstruction } | { ok: false; refusal: string } => {
  if (!hasPrismaCallSites) {
    return { ok: true, construction: BARE_CONSTRUCTION };
  }

  const { major, evidence } = detectPrismaMajor({ cwd });

  if (major === undefined || major < ADAPTER_REQUIRED_MAJOR) {
    return { ok: true, construction: BARE_CONSTRUCTION };
  }

  const adapter = detectInstalledAdapter({ cwd });

  if (adapter === undefined) {
    return { ok: false, refusal: adapterRefusal({ evidence, provider, docPath }) };
  }

  return {
    ok: true,
    construction: { kind: 'adapter', adapter, urlEnv: urlEnv ?? DEFAULT_URL_ENV },
  };
};
