import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSync } from './index';
import { GOVERNANCE_FILE } from './governance';

/**
 * `runSync` end-to-end over a throwaway repo. Run dirs live under the repo's own
 * `.docs/scratch` (the e2e convention) so the hand-written
 * `orangerail.config.mjs` — loaded by a REAL dynamic `import()`, not by vite —
 * resolves `zod` through the workspace's node_modules. The config never imports
 * `orangerail-core`, whose entry is a build artifact that does not exist yet when
 * `verify.sh` runs the tests.
 */

const SCRATCH = fileURLToPath(new URL('../../../../../.docs/scratch/', import.meta.url));

/**
 * A config whose registry is a plain literal — `diffSync` and the governance
 * review only ever call `listObjects` / `listActions` / `listLinks`, so this is a
 * faithful stand-in for a loaded ontology with zero build dependencies.
 */
const configSource = ({ actions }: { actions: string }): string =>
  `import { z } from 'zod';

const Order = {
  kind: 'object',
  name: 'Order',
  schema: z.object({ id: z.string(), total: z.number() }),
};

export default {
  store: {},
  registry: {
    listObjects: () => [Order],
    listActions: () => [${actions}],
    listLinks: () => [],
  },
};
`;

const GATED_DELETE =
  "{ kind: 'action', name: 'deleteOrder', policy: { approval: 'required' }, target: Order, targetIdFrom: 'id' }";
const UNGATED_DELETE = "{ kind: 'action', name: 'deleteOrder', target: Order, targetIdFrom: 'id' }";

let cwd: string;
let out: string[];
let configPath: string;
let configSerial = 0;

const sync = async ({
  acceptGovernance = false,
  acceptNew = false,
}: { acceptGovernance?: boolean; acceptNew?: boolean } = {}): Promise<number> =>
  runSync({ acceptGovernance, acceptNew, cwd, configPath });

const printed = (): string => out.join('');

const writeConfig = ({ actions }: { actions: string }): void => {
  // A fresh filename per write: `loadConfig` goes through the native module
  // cache, which would otherwise hand back the first version of the config for
  // the rest of the test.
  configSerial += 1;
  configPath = join(cwd, `orangerail.config.${configSerial}.mjs`);
  writeFileSync(configPath, configSource({ actions }), 'utf8');
};

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  cwd = mkdtempSync(join(SCRATCH, 'sync-test-'));
  mkdirSync(join(cwd, 'ontology'), { recursive: true });
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

describe('runSync — governance drift (the reported defect)', () => {
  it('fails and reports when an approval gate is deleted from the ontology', async () => {
    writeConfig({ actions: GATED_DELETE });
    expect(await sync({ acceptGovernance: true })).toBe(0);

    // The one edit that disarms the product: the `policy` line is gone.
    writeConfig({ actions: UNGATED_DELETE });
    out = [];

    const code = await sync();

    expect(printed()).toContain('governance: deleteOrder — approval gate removed');
    expect(printed()).not.toContain('sync: ontology is in sync with your sources.');
    expect(code).toBe(1);
  });

  it('goes green again once the change is acknowledged with --accept-governance', async () => {
    writeConfig({ actions: GATED_DELETE });
    await sync({ acceptGovernance: true });

    writeConfig({ actions: UNGATED_DELETE });
    expect(await sync()).toBe(1);

    out = [];
    expect(await sync({ acceptGovernance: true })).toBe(0);
    expect(printed()).toContain(
      `recorded the governance posture of 1 action(s) in ${GOVERNANCE_FILE}`,
    );

    out = [];
    expect(await sync()).toBe(0);
    expect(printed()).toContain('governance matches the recorded baseline');
  });

  it('records a committable, deterministic baseline file', async () => {
    writeConfig({ actions: GATED_DELETE });
    await sync({ acceptGovernance: true });

    const path = join(cwd, GOVERNANCE_FILE);
    expect(existsSync(path)).toBe(true);

    const first = readFileSync(path, 'utf8');
    expect(JSON.parse(first)).toMatchObject({
      version: 1,
      actions: [{ name: 'deleteOrder', approval: 'required', target: 'Order#id' }],
    });

    await sync({ acceptGovernance: true });
    expect(readFileSync(path, 'utf8')).toBe(first);
  });

  it('reports a strengthened posture without failing the run', async () => {
    writeConfig({ actions: UNGATED_DELETE });
    await sync({ acceptGovernance: true });

    writeConfig({ actions: GATED_DELETE });
    out = [];

    expect(await sync()).toBe(0);
    expect(printed()).toContain('info: governance deleteOrder — approval gate added');
  });

  it('refuses to vouch for a posture with no recorded baseline', async () => {
    writeConfig({ actions: GATED_DELETE });

    const code = await sync();

    expect(printed()).toContain('governance: no recorded baseline');
    expect(printed()).toContain('--accept-governance');
    expect(code).toBe(1);
  });

  it('says nothing about a baseline when the ontology exposes no actions', async () => {
    writeConfig({ actions: '' });

    expect(await sync()).toBe(0);
    expect(printed()).not.toContain('governance');
  });

  it('errors out on a corrupt baseline rather than reading it as "nothing recorded"', async () => {
    writeConfig({ actions: GATED_DELETE });
    writeFileSync(join(cwd, GOVERNANCE_FILE), '{ this is not json', 'utf8');

    expect(await sync()).toBe(2);
    expect(printed()).toContain(`${GOVERNANCE_FILE} could not be read`);
  });
});

describe('runSync — exit codes and proposal provenance', () => {
  const PRISMA_SCHEMA = `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Order {
  id    String @id
  total Float
}

model Refund {
  id     String @id
  amount Float
}
`;

  const withPrismaSource = (): void => {
    mkdirSync(join(cwd, 'prisma'), { recursive: true });
    writeFileSync(join(cwd, 'prisma', 'schema.prisma'), PRISMA_SCHEMA, 'utf8');
  };

  /**
   * Plant a package manifest in the repo's OWN node_modules (ONT-049). The
   * Prisma-major probe walks upward and takes the nearest hit, so this outranks
   * the workspace's Prisma 6 without touching it.
   */
  const installPackage = ({ pkg, version }: { pkg: string; version: string }): void => {
    const dir = join(cwd, 'node_modules', ...pkg.split('/'));

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version }), 'utf8');
  };

  it('names the real origin of a Prisma-derived proposal', async () => {
    writeConfig({ actions: GATED_DELETE });
    withPrismaSource();

    expect(await sync({ acceptGovernance: true })).toBe(1);
    expect(printed()).toContain('proposal: new action createRefund (Prisma create on Refund)');
    expect(printed()).not.toContain('undefined undefined');
  });

  it('exits 1 from --accept-new while drift it cannot resolve is still on the board', async () => {
    writeConfig({ actions: GATED_DELETE });
    withPrismaSource();
    // A file already sitting where a proposal would land: `--accept-new` cannot
    // write it, and the registry still does not import it, so the drift stays.
    writeFileSync(join(cwd, 'ontology', 'Refund.mjs'), '// hand-written\n', 'utf8');

    const code = await sync({ acceptNew: true, acceptGovernance: true });

    expect(printed()).toContain('skipped ontology/Refund.mjs');
    expect(printed()).toContain('drift remains that --accept-new cannot resolve');
    expect(code).toBe(1);
  });

  it('exits 1 from --accept-new when the governance posture is unacknowledged', async () => {
    writeConfig({ actions: GATED_DELETE });

    const code = await sync({ acceptNew: true });

    expect(printed()).toContain('sync: no new proposals to create.');
    expect(code).toBe(1);
  });

  it('exits 0 from --accept-new once every proposal is materialized', async () => {
    writeConfig({ actions: GATED_DELETE });
    withPrismaSource();

    const code = await sync({ acceptNew: true, acceptGovernance: true });

    expect(existsSync(join(cwd, 'ontology', 'Refund.mjs'))).toBe(true);
    expect(code).toBe(0);
    // The pre-7 construction, unchanged (ONT-049 AC-1). This repo resolves the
    // workspace's own Prisma 6 by walking up.
    expect(readFileSync(join(cwd, 'ontology', 'Refund.mjs'), 'utf8')).toContain(
      'client = new PrismaClient();',
    );
  });

  it('refuses --accept-new on Prisma 7 with no driver adapter (ONT-049)', async () => {
    // `--accept-new` is the second doorway that writes generated Prisma call
    // sites. Without this it would hand a Prisma 7 project a file carrying a
    // constructor Prisma 7 rejects — from a command that reported success.
    writeConfig({ actions: GATED_DELETE });
    withPrismaSource();
    installPackage({ pkg: '@prisma/client', version: '7.9.1' });

    const code = await sync({ acceptNew: true, acceptGovernance: true });

    expect(code).toBe(1);
    expect(printed()).toContain('orangerail sync --accept-new:');
    expect(printed()).toContain('no supported driver adapter is installed');
    expect(existsSync(join(cwd, 'ontology', 'Refund.mjs'))).toBe(false);
  });

  it('writes the adapter construction from --accept-new on Prisma 7 (ONT-049)', async () => {
    writeConfig({ actions: GATED_DELETE });
    withPrismaSource();
    installPackage({ pkg: '@prisma/client', version: '7.9.1' });
    installPackage({ pkg: '@prisma/adapter-pg', version: '7.9.1' });

    const code = await sync({ acceptNew: true, acceptGovernance: true });

    expect(code).toBe(0);
    expect(readFileSync(join(cwd, 'ontology', 'Refund.mjs'), 'utf8')).toContain(
      'new PrismaClient({ adapter: new PrismaPg(url) })',
    );
  });
});
