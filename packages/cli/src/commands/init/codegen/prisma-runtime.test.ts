import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  adapterForProvider,
  adapterRefusal,
  detectInstalledAdapter,
  detectPrismaMajor,
  majorOf,
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
