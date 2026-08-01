import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { IrGenerator } from '../ir';
import {
  adapterForProvider,
  adapterRefusal,
  CLIENT_PACKAGE,
  detectInstalledAdapter,
  detectPrismaMajor,
  majorOf,
  resolveClientModule,
  resolvePrismaConstruction,
  SUPPORTED_ADAPTERS,
} from './prisma-runtime';

const tempDirs: string[] = [];

/**
 * A scratch repo, created UNDER a directory that holds no `node_modules` of its
 * own. Detection walks upward, so a fixture placed inside the workspace would
 * read the workspace's Prisma instead of its own — the tmpdir is what keeps
 * each case's evidence its own.
 */
const makeRepo = ({
  installed,
  declared,
}: {
  installed?: Record<string, string>;
  declared?: Record<string, string>;
}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ont-049-runtime-'));
  tempDirs.push(dir);

  for (const [pkg, version] of Object.entries(installed ?? {})) {
    const pkgDir = join(dir, 'node_modules', ...pkg.split('/'));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version }), 'utf8');
  }

  if (declared !== undefined) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'scratch', dependencies: declared }),
      'utf8',
    );
  }

  return dir;
};

const DOC = 'docs/existing-database.md';

const resolve = ({ cwd, provider }: { cwd: string; provider?: string }) =>
  resolvePrismaConstruction({
    cwd,
    provider,
    urlEnv: undefined,
    hasPrismaCallSites: true,
    docPath: DOC,
  });

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('majorOf', () => {
  it('reads the floor major out of every range npm actually writes', () => {
    expect(majorOf({ range: '6.19.3' })).toBe(6);
    expect(majorOf({ range: '^6.19.3' })).toBe(6);
    expect(majorOf({ range: '~7.0.1' })).toBe(7);
    expect(majorOf({ range: '7.x' })).toBe(7);
    expect(majorOf({ range: '>=7 <8' })).toBe(7);
    expect(majorOf({ range: '7' })).toBe(7);
  });

  it('returns undefined for a range that names no major', () => {
    // `latest` / `*` name no version, and guessing one would be worse than
    // falling back to the pre-7 default.
    expect(majorOf({ range: 'latest' })).toBeUndefined();
    expect(majorOf({ range: '*' })).toBeUndefined();
    expect(majorOf({ range: 'workspace:^' })).toBeUndefined();
  });
});

describe('detectPrismaMajor', () => {
  it('prefers the INSTALLED copy over the declared range', () => {
    // The installed copy is the one `await import('@prisma/client')` loads, so a
    // package.json claiming ^6 over a hoisted 7 is a claim the runtime ignores.
    const cwd = makeRepo({
      installed: { '@prisma/client': '7.9.1' },
      declared: { '@prisma/client': '^6.19.3' },
    });

    expect(detectPrismaMajor({ cwd })).toEqual({
      major: 7,
      evidence: '@prisma/client 7.9.1 (installed)',
    });
  });

  it('falls back to the declared range when nothing is installed', () => {
    const cwd = makeRepo({ declared: { prisma: '^7.9.1' } });

    expect(detectPrismaMajor({ cwd })).toEqual({
      major: 7,
      evidence: 'prisma ^7.9.1 (declared in package.json)',
    });
  });

  it('reports no major at all when Prisma is nowhere to be found', () => {
    const cwd = makeRepo({});

    expect(detectPrismaMajor({ cwd }).major).toBeUndefined();
  });
});

describe('resolvePrismaConstruction', () => {
  it('emits the bare pre-7 construction on Prisma 6', () => {
    const cwd = makeRepo({ installed: { '@prisma/client': '6.19.3' } });

    expect(resolve({ cwd })).toEqual({ ok: true, construction: { kind: 'bare' } });
  });

  it('emits the bare construction when no Prisma resolves at all', () => {
    // The safe default in both directions: a repo with no Prisma emits no Prisma
    // call sites anyway, and a repo whose layout hides its install keeps today's
    // bytes rather than being refused on a guess.
    const cwd = makeRepo({});

    expect(resolve({ cwd })).toEqual({ ok: true, construction: { kind: 'bare' } });
  });

  it('emits an adapter construction on Prisma 7 with a supported adapter installed', () => {
    const cwd = makeRepo({
      installed: { '@prisma/client': '7.9.1', '@prisma/adapter-pg': '7.9.1' },
    });

    const outcome = resolve({ cwd, provider: 'postgresql' });

    expect(outcome).toEqual({
      ok: true,
      construction: {
        kind: 'adapter',
        adapter: SUPPORTED_ADAPTERS[0],
        urlEnv: 'DATABASE_URL',
      },
    });
  });

  it('honors the env var the schema named, instead of assuming DATABASE_URL', () => {
    const cwd = makeRepo({
      installed: { '@prisma/client': '7.9.1', '@prisma/adapter-pg': '7.9.1' },
    });

    const outcome = resolvePrismaConstruction({
      cwd,
      provider: 'postgresql',
      urlEnv: 'PG_URL',
      hasPrismaCallSites: true,
      docPath: DOC,
    });

    expect(outcome.ok && outcome.construction).toMatchObject({ urlEnv: 'PG_URL' });
  });

  it('accepts an adapter that is only DECLARED, not yet installed', () => {
    const cwd = makeRepo({
      installed: { '@prisma/client': '7.9.1' },
      declared: { '@prisma/adapter-pg': '^7.9.1' },
    });

    expect(resolve({ cwd, provider: 'postgresql' }).ok).toBe(true);
  });

  it('REFUSES on Prisma 7 with no supported adapter, naming the one to install', () => {
    const cwd = makeRepo({ installed: { '@prisma/client': '7.9.1' } });

    const outcome = resolve({ cwd, provider: 'postgresql' });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.refusal).toContain('npm install @prisma/adapter-pg');
    expect(outcome.ok === false && outcome.refusal).toContain('7.9.1 (installed)');
    expect(outcome.ok === false && outcome.refusal).toContain(DOC);
  });

  it('REFUSES on Prisma 7 with an adapter the emitter cannot construct', () => {
    // @prisma/adapter-neon takes a driver-specific handle this emitter has no way
    // to synthesize from a URL, so it is not in the table and does not count.
    const cwd = makeRepo({
      installed: { '@prisma/client': '7.9.1', '@prisma/adapter-neon': '7.9.1' },
    });

    expect(resolve({ cwd, provider: 'postgresql' }).ok).toBe(false);
  });

  it('never refuses when the file set has no Prisma call sites', () => {
    // An OpenAPI-only scan imports no client, so the repo's Prisma major is
    // irrelevant and a repo that carries Prisma 7 for unrelated reasons must
    // still be able to run init.
    const cwd = makeRepo({ installed: { '@prisma/client': '7.9.1' } });

    const outcome = resolvePrismaConstruction({
      cwd,
      provider: undefined,
      urlEnv: undefined,
      hasPrismaCallSites: false,
      docPath: DOC,
    });

    expect(outcome).toEqual({ ok: true, construction: { kind: 'bare' } });
  });
});

describe('detectInstalledAdapter', () => {
  it('finds each supported adapter by its own package name', () => {
    for (const adapter of SUPPORTED_ADAPTERS) {
      const cwd = makeRepo({ installed: { [adapter.module]: '7.9.1' } });

      expect(detectInstalledAdapter({ cwd })).toEqual(adapter);
    }
  });
});

describe('adapterForProvider', () => {
  it('maps every provider the table claims', () => {
    expect(adapterForProvider({ provider: 'postgresql' })?.className).toBe('PrismaPg');
    expect(adapterForProvider({ provider: 'mysql' })?.className).toBe('PrismaMariaDb');
    expect(adapterForProvider({ provider: 'sqlserver' })?.className).toBe('PrismaMssql');
    expect(adapterForProvider({ provider: 'sqlite' })?.className).toBe('PrismaBetterSqlite3');
  });

  it('knows no adapter for a provider it never verified', () => {
    expect(adapterForProvider({ provider: 'mongodb' })).toBeUndefined();
    expect(adapterForProvider({ provider: undefined })).toBeUndefined();
  });
});

describe('adapterRefusal', () => {
  it('lists every option when the schema named no provider', () => {
    // Prisma 7 schemas often declare only a provider, and some declare none the
    // scanner can read — a refusal that named one arbitrary adapter would send
    // half of those users to the wrong package.
    const refusal = adapterRefusal({ evidence: 'prisma 7.9.1', provider: undefined, docPath: DOC });

    for (const adapter of SUPPORTED_ADAPTERS) {
      expect(refusal).toContain(adapter.module);
    }
  });

  it('offers the pin-to-6 escape hatch', () => {
    const refusal = adapterRefusal({ evidence: 'prisma 7.9.1', provider: 'sqlite', docPath: DOC });

    expect(refusal).toContain('@prisma/adapter-better-sqlite3');
    expect(refusal).toContain('prisma@6');
  });
});

/**
 * ONT-067 — `prisma init` on Prisma 7 writes
 * `generator client { provider = "prisma-client"  output = "../generated/prisma" }`,
 * which generates the client into that directory and leaves `@prisma/client`
 * carrying nothing. These pin WHICH module the emitted import names.
 */
describe('resolveClientModule (ONT-067)', () => {
  const resolveClient = ({ cwd, generator }: { cwd: string; generator?: IrGenerator }) =>
    resolveClientModule({
      cwd,
      generator,
      docPath: DOC,
      command: 'orangerail init',
    });

  it('names the generated client, relative to the ontology directory', () => {
    const result = resolveClient({
      cwd: '/repo',
      generator: { provider: 'prisma-client', outputDir: '/repo/generated/prisma' },
    });

    // `ontology/Customer.mjs` is one level below the project root, so the
    // specifier climbs out of `ontology/` before descending into `generated/`.
    expect(result).toEqual({ ok: true, clientModule: '../generated/prisma/client.ts' });
  });

  it('leaves the legacy generator on `@prisma/client`, which is where it generates', () => {
    expect(resolveClient({ cwd: '/repo', generator: { provider: 'prisma-client-js' } })).toEqual({
      ok: true,
      clientModule: CLIENT_PACKAGE,
    });
  });

  it('leaves a schema with no generator block on `@prisma/client`', () => {
    expect(resolveClient({ cwd: '/repo' })).toEqual({ ok: true, clientModule: CLIENT_PACKAGE });
  });

  it('does not redirect the import for a generator that emits no client', () => {
    expect(
      resolveClient({
        cwd: '/repo',
        generator: { provider: 'prisma-erd-generator', outputDir: '/repo/docs' },
      }),
    ).toEqual({ ok: true, clientModule: CLIENT_PACKAGE });
  });

  it('refuses a `prisma-client` generator that declares no output', () => {
    const result = resolveClient({ cwd: '/repo', generator: { provider: 'prisma-client' } });

    expect(result.ok).toBe(false);
    const refusal = result.ok ? '' : result.refusal;
    // Prisma's own default differs by generator and version, so the refusal names
    // the field to add rather than guessing a path that would fail elsewhere.
    expect(refusal).toContain('`output`');
    expect(refusal).toContain('output   = "../generated/prisma"');
    expect(refusal).toContain('prisma-client-js');
    expect(refusal).toContain(DOC);
  });

  it('refuses an output it cannot resolve at scan time', () => {
    const result = resolveClient({
      cwd: '/repo',
      generator: { provider: 'prisma-client', outputExpression: 'env("GEN_OUT")' },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.refusal).toContain('env("GEN_OUT")');
  });

  it('refuses an output that leaves the project instead of emitting a climbing import', () => {
    const result = resolveClient({
      cwd: '/repo',
      generator: { provider: 'prisma-client', outputDir: '/elsewhere/generated/prisma' },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.refusal).toContain('/elsewhere/generated/prisma');
  });
});

describe('resolvePrismaConstruction carries the client module (ONT-067)', () => {
  const withGenerator = ({ cwd, generator }: { cwd: string; generator?: IrGenerator }) =>
    resolvePrismaConstruction({
      cwd,
      provider: 'mysql',
      urlEnv: undefined,
      ...(generator === undefined ? {} : { generator }),
      hasPrismaCallSites: true,
      docPath: DOC,
    });

  it('redirects the import on a Prisma 6 repo too — the generator predates 7', () => {
    const cwd = makeRepo({ installed: { '@prisma/client': '6.19.3' } });

    const result = withGenerator({
      cwd,
      generator: { provider: 'prisma-client', outputDir: join(cwd, 'generated', 'prisma') },
    });

    expect(result).toEqual({
      ok: true,
      construction: { kind: 'bare', clientModule: '../generated/prisma/client.ts' },
    });
  });

  it('leaves the construction untouched when the client is the package', () => {
    const cwd = makeRepo({ installed: { '@prisma/client': '6.19.3' } });

    expect(withGenerator({ cwd, generator: { provider: 'prisma-client-js' } })).toEqual({
      ok: true,
      construction: { kind: 'bare' },
    });
  });

  it('refuses before the Prisma-major question is even asked', () => {
    // No adapter is installed here either, so both refusals are available. The
    // import is the one that decides whether ANY module loads, so it is asked
    // first — and its remedy is the one the reader can act on.
    const cwd = makeRepo({ installed: { '@prisma/client': '7.9.1' } });

    const result = withGenerator({ cwd, generator: { provider: 'prisma-client' } });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.refusal).toContain('`output`');
  });

  it('emits no Prisma call site, and so asks nothing, for an OpenAPI-only scan', () => {
    const cwd = makeRepo({ installed: { '@prisma/client': '7.9.1' } });

    const result = resolvePrismaConstruction({
      cwd,
      provider: undefined,
      urlEnv: undefined,
      generator: { provider: 'prisma-client' },
      hasPrismaCallSites: false,
      docPath: DOC,
    });

    expect(result).toEqual({ ok: true, construction: { kind: 'bare' } });
  });
});
