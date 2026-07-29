import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isDrift, runSync } from './index';
import { GOVERNANCE_FILE, writeBaseline, type ActionPosture } from '../../governance';

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
  });
});

/**
 * ONT-050 — one contract, and every path follows it. `sync --help` promised
 * "exit 1 on drift" while an unregistered ontology file — a file the config
 * loader never imports, which can hold a whole set of governed actions the user
 * believes are live — printed its warning and then `ontology is in sync with
 * your sources`, exit 0.
 */
describe('runSync — the exit-code contract', () => {
  it('classifies the drift record in one place', () => {
    const clean = { proposals: 0, fieldDrift: 0, unregistered: 0, governance: 0 };

    expect(isDrift({ findings: clean })).toBe(false);
    for (const key of ['proposals', 'fieldDrift', 'unregistered', 'governance'] as const) {
      expect(isDrift({ findings: { ...clean, [key]: 1 } })).toBe(true);
    }
  });

  it('exits 1 on an unregistered ontology file and stops calling the ontology in sync', async () => {
    writeConfig({ actions: GATED_DELETE });
    await sync({ acceptGovernance: true });
    writeFileSync(join(cwd, 'ontology', 'stray.ts'), 'export const stray = true;\n', 'utf8');
    out = [];

    const code = await sync();

    expect(printed()).toContain('unregistered ontology file: ontology/stray.ts');
    // Pre-fix: this exact run printed the warning, then "ontology is in sync
    // with your sources; governance matches the recorded baseline.", exit 0.
    expect(printed()).not.toContain('in sync with your sources');
    expect(code).toBe(1);
  });

  it('exits 2 — never 1 — when it could not answer the question at all', async () => {
    writeConfig({ actions: GATED_DELETE });
    writeFileSync(join(cwd, GOVERNANCE_FILE), '{"version":42,"actions":[]}', 'utf8');

    expect(await sync()).toBe(2);
  });

  it('never claims "in sync" from a run that just wrote files', async () => {
    writeConfig({ actions: GATED_DELETE });
    await sync({ acceptGovernance: true });
    out = [];

    expect(await sync({ acceptNew: true })).toBe(0);
    // The registry it compared against was loaded before `--accept-new` ran, so
    // it is in no position to call the result in sync.
    expect(printed()).not.toContain('in sync with your sources');
  });
});

describe('runSync — a baseline recorded by init is a starting point, not an approval', () => {
  /** The posture of {@link GATED_DELETE}, as `orangerail init` would have recorded it. */
  const GENERATED: ActionPosture[] = [
    { name: 'deleteOrder', approval: 'required', roles: [], where: null, target: 'Order#id' },
  ];

  const recordAsInit = (): void => {
    writeBaseline({ projectRoot: cwd, postures: GENERATED, recordedBy: 'init' });
  };

  it('detects drift against it from the first run — the whole point of writing it', async () => {
    recordAsInit();
    // The tester's edit, in a project that never ran `--accept-governance`.
    writeConfig({ actions: UNGATED_DELETE });

    expect(await sync()).toBe(1);
    // Pre-fix, with no baseline at all, this run could only say it could not tell.
    expect(printed()).toContain('governance: deleteOrder — approval gate removed');
    expect(printed()).not.toContain('no recorded baseline');
  });

  it('says so on every run, and exits 0 — an unreviewed baseline is not drift', async () => {
    recordAsInit();
    writeConfig({ actions: GATED_DELETE });

    expect(await sync()).toBe(0);
    expect(printed()).toContain('recorded by `orangerail init`');
    expect(printed()).toContain('nobody has reviewed');

    out = [];
    expect(await sync({ acceptGovernance: true })).toBe(0);

    out = [];
    expect(await sync()).toBe(0);
    expect(printed()).not.toContain('nobody has reviewed');
    expect(printed()).toContain('governance matches the recorded baseline');
  });
});
