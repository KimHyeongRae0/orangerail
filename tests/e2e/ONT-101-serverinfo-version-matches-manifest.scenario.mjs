/**
 * ONT-101 e2e driver — the MCP server reports the version it actually shipped at.
 *
 * `serverInfo.version` was the string literal `'0.1.0'` from the day it was
 * typed until #163, while the package went out as `0.1.1`, `0.1.2` and `0.1.3`.
 * Nothing failed, because nothing was looking. This driver is the thing that
 * looks.
 *
 * It does not read the source. A literal is invisible to a source-level check
 * the moment someone writes a different one, and the interesting failure is not
 * the literal at all — it is that the manifest read might not RESOLVE after
 * bundling. `dist/` is one level under the package root in the repo and in the
 * published tarball, and npm always ships `package.json`, but that is a claim
 * about the packed artifact and it has to be checked against a packed artifact.
 *
 * So: pack this tree, install the tarballs into a scratch project, generate an
 * ontology, spawn `orangerail mcp` as a real stdio server, and compare the
 * `initialize` response against the version npm actually installed.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. The runtime assertion covers the ESM
 * build, which is the one the CLI loads and therefore the one every user
 * reaches. The CJS build gets a STRUCTURAL assertion instead — that tsup's
 * `shims` option supplied `import.meta.url`, without which that build would
 * report `unknown`. `unknown` is a degraded answer rather than a wrong one,
 * which is why the weaker check is the proportionate one here, and saying so is
 * cheaper than implying the runtime check covered both.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The five workspace packages the scratch project installs from this tree. */
const PACKAGES = [
  { name: 'orangerail', dir: 'packages/cli' },
  { name: 'orangerail-core', dir: 'packages/core' },
  { name: 'orangerail-mcp', dir: 'packages/mcp' },
  { name: 'orangerail-docs-gen', dir: 'packages/docs-gen' },
  { name: 'orangerail-studio', dir: 'packages/studio' },
];

const SCHEMA = `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Customer {
  id    Int    @id @default(autoincrement())
  name  String
  email String
}

model Order {
  id         Int    @id @default(autoincrement())
  customerId Int
  total      Int
  status     String @default("open")
}
`;

let failures = 0;

/** Reports one assertion and remembers whether the run can still pass. */
const check = ({ ok, label, detail }) => {
  if (ok) {
    console.log(`  ok    ${label}`);

    return;
  }

  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

const run = ({ command, args, cwd, env }) =>
  spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

const mustRun = ({ command, args, cwd, env, label }) => {
  const result = run({ command, args, cwd, env });

  if (result.status !== 0) {
    console.log(`  SETUP FAIL  ${label}`);
    console.log(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    process.exit(1);
  }

  return result;
};

// ───────── a minimal MCP stdio client (the ONT-003/018/019 pattern) ─────────

/**
 * Spawns the server, completes the handshake, and hands back the `initialize`
 * result. Only `initialize` is needed here: the version is in its response, and
 * a server that cannot answer it has already failed the thing being tested.
 */
const initialize = ({ command, args, cwd, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no initialize response within 30s\n${stderr}`));
    }, 30_000);

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);

      for (const line of buffer.split('\n').slice(0, -1)) {
        if (!line.trim()) continue;

        const message = JSON.parse(line);
        if (message.id !== 1) continue;

        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve(message.result);

        return;
      }

      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ONT-101', version: '0' },
        },
      })}\n`,
    );
  });

// ───────── setup ─────────

const workspace = mkdtempSync(join(tmpdir(), 'ont-101-'));
const project = join(workspace, 'project');
const packDest = join(workspace, 'tarballs');
mkdirSync(join(project, 'prisma'), { recursive: true });
mkdirSync(packDest, { recursive: true });

console.log('ONT-101: packing this tree');

const tarballs = PACKAGES.map((pkg) => {
  const dest = join(packDest, pkg.name);
  mkdirSync(dest, { recursive: true });

  // `pnpm pack`, not `npm pack`: the CLI depends on the other four as
  // `workspace:*`, and only pnpm rewrites that to a real version when packing.
  mustRun({
    command: 'pnpm',
    args: ['pack', '--pack-destination', dest],
    cwd: join(ROOT, pkg.dir),
    label: `pnpm pack ${pkg.dir}`,
  });

  const tgz = readdirSync(dest).find((name) => name.endsWith('.tgz'));
  if (!tgz) {
    console.log(`  SETUP FAIL  no tarball produced for ${pkg.dir}`);
    process.exit(1);
  }

  return join(dest, tgz);
});

writeFileSync(join(project, 'prisma', 'schema.prisma'), SCHEMA);
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'ont-101', private: true }));

console.log('ONT-101: installing the packed tarballs');

const env = { DATABASE_URL: 'file:./dev.db' };

mustRun({
  command: 'npm',
  args: [
    'install',
    '--no-audit',
    '--no-fund',
    '--save-dev',
    ...tarballs,
    'prisma@6',
    '@prisma/client@6',
  ],
  cwd: project,
  env,
  label: 'npm install',
});

mustRun({
  command: join(project, 'node_modules', '.bin', 'prisma'),
  args: ['generate'],
  cwd: project,
  env,
  label: 'prisma generate',
});

const cli = join(project, 'node_modules', '.bin', 'orangerail');

mustRun({
  command: cli,
  args: ['init', '--yes', '--preset', 'approval-for-writes', '--no-studio'],
  cwd: project,
  env,
  label: 'orangerail init',
});

// Without this, `orangerail mcp` refuses to serve a posture nobody vouched for.
mustRun({
  command: cli,
  args: ['sync', '--accept-governance'],
  cwd: project,
  env,
  label: 'orangerail sync --accept-governance',
});

// ───────── the assertions ─────────

console.log('ONT-101: what the installed package says its version is');

const installed = join(project, 'node_modules', 'orangerail-mcp');
const installedVersion = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;

console.log(`  orangerail-mcp installed at ${installedVersion}`);

const result = await initialize({ command: cli, args: ['mcp'], cwd: project, env });
const reported = result?.serverInfo?.version;

console.log(`  initialize reported ${JSON.stringify(reported)}`);

check({
  ok: reported === installedVersion,
  label: 'serverInfo.version equals the installed package version',
  detail: `reported ${JSON.stringify(reported)}, installed ${JSON.stringify(installedVersion)} — a hardcoded literal drifts the moment a release goes out`,
});

check({
  ok: result?.serverInfo?.name === 'orangerail',
  label: 'serverInfo.name is unchanged',
  detail: `clients key off this: got ${JSON.stringify(result?.serverInfo?.name)}`,
});

// The CJS build cannot be driven the same way without a registry, so this is a
// structural check and is labelled as one. Without the shim, `import.meta.url`
// is absent there and every CJS consumer reads `unknown`.
const cjs = readFileSync(join(installed, 'dist', 'index.cjs'), 'utf8');

check({
  ok: cjs.includes('importMetaUrl') && !cjs.includes('import.meta'),
  label: 'the packed CJS build resolves its manifest through the tsup shim',
  detail:
    'tsup `shims: true` in packages/mcp/tsup.config.ts is what supplies import.meta.url to CJS',
});

rmSync(workspace, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\nONT-101: ${failures} assertion(s) failed`);
  process.exit(1);
}

console.log('\nONT-101: the version a client is shown is the version npm installed');
