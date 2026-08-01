import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import type { IrGenerator } from '../ir';

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
 * `@prisma/adapter-mariadb` was run end to end against a live MySQL 9.7.1 in
 * ONT-067: read, create, update and an approved gated delete through the shipped
 * MCP server, with `orangerail audit verify` reporting `audit chain OK`.
 * `@prisma/adapter-mssql` is signature-verified only
 * (`constructor(config: … | string)`); no SQL Server was reachable here to run a
 * query through.
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

/**
 * How the generated code constructs its Prisma client.
 *
 * `clientModule` is the module the emitted `await import(…)` names, and it is
 * OPTIONAL for one reason: absent means `@prisma/client`, which is the specifier
 * every generated file has always carried. A schema whose client generator is
 * the legacy `prisma-client-js`, or that declares no generator at all, leaves it
 * absent and emits the bytes it always emitted (ONT-067).
 */
export type PrismaConstruction =
  | { kind: 'bare'; clientModule?: string }
  | { kind: 'adapter'; adapter: PrismaAdapter; urlEnv: string; clientModule?: string };

/** The pre-7 construction — the default everywhere, so untouched repos emit untouched bytes. */
export const BARE_CONSTRUCTION: PrismaConstruction = { kind: 'bare' };

/** The package the emitted client import names when the generator writes into it. */
export const CLIENT_PACKAGE = '@prisma/client';

/**
 * The generator provider that writes its client into its OWN `output` directory
 * instead of into `@prisma/client` — Prisma 7's `prisma init` default.
 */
export const TS_CLIENT_GENERATOR = 'prisma-client';

/** The entry file that generator writes at the root of its output directory. */
export const GENERATED_CLIENT_ENTRY = 'client.ts';

/**
 * The directory generated ontology files are written to, relative to the project
 * root. `buildFileSet` renders every path through it and the client specifier is
 * computed relative to it, so the two cannot drift into an import that resolves
 * from a directory the files are no longer in.
 */
export const ONTOLOGY_DIR = 'ontology';

/**
 * The module specifier a generated `ontology/<Object>.mjs` uses to reach an
 * absolute path — POSIX-separated and explicitly relative, which is what an ESM
 * specifier must be.
 */
const ontologySpecifier = ({ cwd, target }: { cwd: string; target: string }): string => {
  const rel = relative(join(cwd, ONTOLOGY_DIR), target).split(sep).join('/');

  return rel.startsWith('.') ? rel : `./${rel}`;
};

/** Whether an absolute path lies inside the project root (the root itself counts). */
const insideProject = ({ cwd, target }: { cwd: string; target: string }): boolean => {
  const rel = relative(cwd, target);

  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * The header every generator refusal shares: what was found, and the commitment
 * it is enforcing. Kept identical in shape to `adapterRefusal` — this is the same
 * promise ("orangerail will not write an ontology that cannot construct a
 * client") applied one step earlier, to the import rather than the constructor.
 */
const generatorRefusal = ({
  problem,
  remedy,
  docPath,
  command,
}: {
  problem: string;
  remedy: string;
  docPath: string;
  command: string;
}): string =>
  `${command}: ${problem}\n` +
  `The \`${TS_CLIENT_GENERATOR}\` generator writes the client into the directory its \`output\` names\n` +
  'and puts nothing into `@prisma/client`, so orangerail cannot name a module the generated\n' +
  'ontology could import — and it will not write an ontology whose client import cannot resolve.\n\n' +
  remedy +
  `\nThen re-run \`${command}\`.\n` +
  `See ${docPath} for the full existing-database walkthrough.\n`;

/**
 * The `prisma-client-js` escape hatch, offered by every generator refusal. It is
 * the legacy generator that still generates into `@prisma/client`, so it needs no
 * `output` at all — and it is what `docs/existing-database.md` prescribed before
 * the `output` was read.
 */
const LEGACY_GENERATOR_REMEDY =
  'Or switch to the legacy generator, which generates into `@prisma/client`:\n\n' +
  '  generator client {\n' +
  '    provider = "prisma-client-js"\n' +
  '  }\n';

/** The `output` line `prisma init` itself writes, quoted back as the first remedy. */
const OUTPUT_REMEDY =
  "Add the `output` field — this is what Prisma's own `prisma init` writes:\n\n" +
  '  generator client {\n' +
  `    provider = "${TS_CLIENT_GENERATOR}"\n` +
  '    output   = "../generated/prisma"\n' +
  '  }\n\n';

/**
 * The module the generated ontology imports `PrismaClient` from, or a refusal.
 *
 * Three schemas resolve to today's `@prisma/client` and therefore to today's
 * bytes: no client generator at all, `provider = "prisma-client-js"`, and a
 * provider this table does not know (a third-party generator does not move where
 * the Prisma client lands). Only `prisma-client` redirects the import, because it
 * is the only one that generates somewhere else.
 *
 * It refuses in exactly the three cases where the schema states an `output` that
 * cannot be turned into an import, and never merely because the provider is
 * `prisma-client` — that is the Prisma 7 default, and the schema that declares it
 * normally carries everything needed to emit a working import.
 */
export const resolveClientModule = ({
  cwd,
  generator,
  docPath,
  command,
}: {
  cwd: string;
  generator: IrGenerator | undefined;
  docPath: string;
  command: string;
}): { ok: true; clientModule: string } | { ok: false; refusal: string } => {
  if (generator?.provider !== TS_CLIENT_GENERATOR) {
    return { ok: true, clientModule: CLIENT_PACKAGE };
  }

  if (generator.outputExpression !== undefined) {
    return {
      ok: false,
      refusal: generatorRefusal({
        problem: `your Prisma schema declares \`output = ${generator.outputExpression}\`, which names a value this scan cannot resolve.`,
        remedy:
          'Write the path as a plain string literal:\n\n' +
          '  generator client {\n' +
          `    provider = "${TS_CLIENT_GENERATOR}"\n` +
          '    output   = "../generated/prisma"\n' +
          '  }\n\n' +
          LEGACY_GENERATOR_REMEDY,
        docPath,
        command,
      }),
    };
  }

  const outputDir = generator.outputDir;

  if (outputDir === undefined) {
    return {
      ok: false,
      refusal: generatorRefusal({
        problem: `your Prisma schema declares \`generator client { provider = "${TS_CLIENT_GENERATOR}" }\` with no \`output\` field.`,
        remedy: OUTPUT_REMEDY + LEGACY_GENERATOR_REMEDY,
        docPath,
        command,
      }),
    };
  }

  if (!insideProject({ cwd, target: outputDir })) {
    // Emitting the `../../..` specifier this would produce is worse than
    // refusing: it would be an import reaching outside the repo, resolved
    // against wherever the ontology happens to be checked out.
    return {
      ok: false,
      refusal: generatorRefusal({
        problem: `your Prisma schema generates its client to \`${outputDir}\`, which is outside this project.`,
        remedy:
          'Point `output` at a directory inside the project:\n\n' +
          '  generator client {\n' +
          `    provider = "${TS_CLIENT_GENERATOR}"\n` +
          '    output   = "../generated/prisma"\n' +
          '  }\n\n' +
          LEGACY_GENERATOR_REMEDY,
        docPath,
        command,
      }),
    };
  }

  return {
    ok: true,
    clientModule: ontologySpecifier({ cwd, target: join(outputDir, GENERATED_CLIENT_ENTRY) }),
  };
};

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
  command = 'orangerail init',
}: {
  evidence: string;
  provider: string | undefined;
  docPath: string;
  /** The command that refused — `sync --accept-new` writes generated files too. */
  command?: string;
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
    `${command}: this repo is on Prisma ${ADAPTER_REQUIRED_MAJOR}+ (${evidence}) and no supported driver adapter is installed.\n` +
    'Prisma 7 removed the no-argument client constructor — generated code must pass a driver\n' +
    'adapter, and orangerail will not write an ontology that cannot construct a client.\n\n' +
    providerLine +
    install +
    `\nThen re-run \`${command}\`.\n` +
    `Staying on Prisma 6 also works: \`npm install prisma@6 @prisma/client@6\`.\n` +
    `See ${docPath} for the full existing-database walkthrough.\n`
  );
};

/**
 * Where a user with a live database and no schema file is sent. Named once and
 * carried into every refusal that could be the dead end they hit.
 */
export const EXISTING_DB_DOC = 'docs/existing-database.md';

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
  generator,
  hasPrismaCallSites,
  docPath,
  command = 'orangerail init',
}: {
  cwd: string;
  provider: string | undefined;
  urlEnv: string | undefined;
  /** The scanned client generator, which decides WHICH module the client comes from (ONT-067). */
  generator?: IrGenerator;
  hasPrismaCallSites: boolean;
  docPath: string;
  /** The command shown in the refusal; defaults to `orangerail init`. */
  command?: string;
}): { ok: true; construction: PrismaConstruction } | { ok: false; refusal: string } => {
  if (!hasPrismaCallSites) {
    return { ok: true, construction: BARE_CONSTRUCTION };
  }

  // WHERE the client comes from is asked before WHICH constructor it takes, and
  // independently of the Prisma major: the `prisma-client` generator predates
  // Prisma 7, so a Prisma 6 repo on it needs the redirected import even though
  // it keeps the pre-7 bare constructor (ONT-067).
  const client = resolveClientModule({ cwd, generator, docPath, command });

  if (!client.ok) {
    return { ok: false, refusal: client.refusal };
  }

  // Absent for `@prisma/client`, so every schema that resolved to the package
  // renders the specifier it always rendered.
  const clientModule =
    client.clientModule === CLIENT_PACKAGE ? {} : { clientModule: client.clientModule };

  const { major, evidence } = detectPrismaMajor({ cwd });

  if (major === undefined || major < ADAPTER_REQUIRED_MAJOR) {
    return { ok: true, construction: { kind: 'bare', ...clientModule } };
  }

  const adapter = detectInstalledAdapter({ cwd });

  if (adapter === undefined) {
    return {
      ok: false,
      refusal: adapterRefusal({ evidence, provider, docPath, command }),
    };
  }

  return {
    ok: true,
    construction: { kind: 'adapter', adapter, urlEnv: urlEnv ?? DEFAULT_URL_ENV, ...clientModule },
  };
};
