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
  exclude,
}: {
  acceptGovernance?: boolean;
  acceptNew?: boolean;
  exclude?: string[];
} = {}): Promise<number> =>
  runSync({
    acceptGovernance,
    acceptNew,
    ...(exclude === undefined ? {} : { exclude }),
    cwd,
    configPath,
  });

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

/**
 * ONT-050 — one contract, and every path follows it. `sync --help` promised
 * "exit 1 on drift" while an unregistered ontology file — a file the config
 * loader never imports, which can hold a whole set of governed actions the user
 * believes are live — printed its warning and then `ontology is in sync with
 * your sources`, exit 0.
 */
describe('runSync — the exit-code contract', () => {
  it('classifies the drift record in one place', () => {
    const clean = {
      proposals: 0,
      fieldDrift: 0,
      unregistered: 0,
      governance: 0,
      exposedExclusions: 0,
    };

    expect(isDrift({ findings: clean })).toBe(false);
    for (const key of [
      'proposals',
      'fieldDrift',
      'unregistered',
      'governance',
      'exposedExclusions',
    ] as const) {
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
    writeBaseline({ projectRoot: cwd, postures: GENERATED, recordedBy: 'init', excluded: [] });
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

/**
 * ONT-059 — the reported defect. A project that narrowed its surface on purpose
 * re-discovered the models it left out on every run, so `sync` exited 1 forever;
 * a check that can never pass is a check nobody reads, and this one is what makes
 * the ONT-056 un-gated default defensible. The remedy it printed was the unsafe
 * one: `--accept-new` would have generated exactly the table an operator had kept
 * away from the agent.
 */
describe('runSync — refused models (ONT-059)', () => {
  const PRISMA_SCHEMA = `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Order {
  id    String @id
  total Float
}

model Payment {
  id        String @id
  cardLast4 String
}
`;

  /** The same schema with a model that appeared AFTER the refusal was recorded. */
  const SCHEMA_WITH_NEW_MODEL = `${PRISMA_SCHEMA}
model Refund {
  id     String @id
  amount Float
}
`;

  /**
   * A registry carrying every action the Prisma scan derives for `Order`, so the
   * only thing standing between this project and exit 0 is the refused model.
   */
  const ORDER_CRUD = [
    "{ kind: 'action', name: 'createOrder' }",
    "{ kind: 'action', name: 'updateOrder', target: Order, targetIdFrom: 'id' }",
    "{ kind: 'action', name: 'deleteOrder', policy: { approval: 'required' }, target: Order, targetIdFrom: 'id' }",
  ].join(', ');

  const writeSchema = ({ source = PRISMA_SCHEMA }: { source?: string } = {}): void => {
    mkdirSync(join(cwd, 'prisma'), { recursive: true });
    writeFileSync(join(cwd, 'prisma', 'schema.prisma'), source, 'utf8');
  };

  const recordedExclusions = (): string[] =>
    (JSON.parse(readFileSync(join(cwd, GOVERNANCE_FILE), 'utf8')) as { excluded: string[] })
      .excluded;

  it('reproduces the defect: an unrecorded refusal is rediscovered forever', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    await sync({ acceptGovernance: true });
    out = [];

    // Nothing on disk says Payment was refused, so every run proposes it and its
    // three Prisma actions, and the only remedy named is the one that creates it.
    expect(await sync()).toBe(1);
    expect(printed()).toContain('proposal: new model Payment');
    expect(printed()).toContain('proposal: new action createPayment');
  });

  it('records a refusal and goes green, without touching the recorded provenance', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    await sync({ acceptGovernance: true });
    out = [];

    expect(await sync({ exclude: ['Payment'] })).toBe(0);
    expect(recordedExclusions()).toEqual(['Payment']);
    expect(printed()).toContain(`recorded 1 refused model(s) in ${GOVERNANCE_FILE}`);

    // The next run is quiet, loud about being quiet, and green.
    out = [];
    expect(await sync()).toBe(0);
    expect(printed()).toContain(`info: Payment is excluded, as recorded in ${GOVERNANCE_FILE}`);
    expect(printed()).toContain('3 action(s) not proposed');
    expect(printed()).not.toContain('proposal:');
  });

  it('records a refusal without laundering an unreviewed posture into a reviewed one', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    // The state `orangerail init` leaves behind: a baseline nobody has vouched for.
    const generated: ActionPosture[] = [
      { name: 'createOrder', approval: null, roles: [], where: null, target: null },
      { name: 'updateOrder', approval: null, roles: [], where: null, target: 'Order#id' },
      { name: 'deleteOrder', approval: 'required', roles: [], where: null, target: 'Order#id' },
    ];

    writeBaseline({ projectRoot: cwd, postures: generated, recordedBy: 'init', excluded: [] });

    expect(await sync({ exclude: ['Payment'] })).toBe(0);

    const recorded = JSON.parse(readFileSync(join(cwd, GOVERNANCE_FILE), 'utf8')) as {
      recordedBy: string;
      excluded: string[];
    };
    expect(recorded.recordedBy).toBe('init');
    expect(recorded.excluded).toEqual(['Payment']);
  });

  it('still reports a model that appears AFTER the refusal — a name list is not a snapshot', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    await sync({ acceptGovernance: true });
    await sync({ exclude: ['Payment'] });

    writeSchema({ source: SCHEMA_WITH_NEW_MODEL });
    out = [];

    expect(await sync()).toBe(1);
    expect(printed()).toContain('proposal: new model Refund');
    expect(printed()).not.toContain('proposal: new model Payment');
  });

  it('does not let --accept-new create a refused model, which was the only remedy it named', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema({ source: SCHEMA_WITH_NEW_MODEL });
    await sync({ acceptGovernance: true });
    await sync({ exclude: ['Payment'] });
    out = [];

    expect(await sync({ acceptNew: true })).toBe(0);
    expect(existsSync(join(cwd, 'ontology', 'Refund.mjs'))).toBe(true);
    expect(existsSync(join(cwd, 'ontology', 'Payment.mjs'))).toBe(false);
  });

  it('names the refusal door under the proposals, and suggests no name of its own', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();

    await sync({ acceptGovernance: true });

    expect(printed()).toContain('`orangerail sync --exclude <name>[,<name>]`');
    expect(printed()).toContain('nothing is pre-selected');
  });

  it('reports a recorded name that matches nothing, so it cannot silence a future model', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    await sync({ acceptGovernance: true });
    await sync({ exclude: ['Payment'] });

    // The table is dropped from the schema; the refusal now matches nothing.
    writeSchema({
      source: PRISMA_SCHEMA.replace(/model Payment \{[^}]*\}\n/, ''),
    });
    out = [];

    expect(await sync()).toBe(0);
    expect(printed()).toContain('recorded exclusion "Payment" matches nothing in your sources');
  });

  it('fails when the ontology exposes a model the file records as refused', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    await sync({ acceptGovernance: true });

    // `Order` IS in the registry, so recording it as refused makes the file and
    // the ontology contradict each other. Only a hand-edit can reach this state,
    // which is why it has to be reported rather than prevented.
    writeBaseline({
      projectRoot: cwd,
      postures: [],
      recordedBy: 'sync',
      excluded: ['Order'],
    });
    out = [];

    const code = await sync();

    expect(printed()).toContain('excluded: Order is recorded as excluded');
    expect(code).toBe(1);

    // No flag on this command resolves it: re-recording the posture does not
    // stop a table from being reachable.
    out = [];
    expect(await sync({ acceptGovernance: true })).toBe(1);
  });

  it('refuses an --exclude the run cannot honestly record, printing no report and writing nothing', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();

    // No baseline yet: there is no honest `recordedBy` to stamp.
    expect(await sync({ exclude: ['Payment'] })).toBe(2);
    expect(printed()).toContain('--accept-governance');
    expect(existsSync(join(cwd, GOVERNANCE_FILE))).toBe(false);

    await sync({ acceptGovernance: true });
    out = [];

    // A typo would sit in a committed file matching nothing while the operator
    // believed a table had been refused.
    expect(await sync({ exclude: ['Paymnet'] })).toBe(2);
    expect(printed()).toContain('which your sources do not have');
    expect(printed()).not.toContain('proposal:');
    expect(recordedExclusions()).toEqual([]);

    out = [];

    // A model the ontology already serves would manufacture the contradiction
    // the check above reports.
    expect(await sync({ exclude: ['Order'] })).toBe(2);
    expect(printed()).toContain('which your ontology already exposes');
    expect(recordedExclusions()).toEqual([]);
  });

  it('records a refusal and a reviewed posture in one run when both are asked for', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();

    expect(await sync({ exclude: ['Payment'], acceptGovernance: true })).toBe(0);

    const recorded = JSON.parse(readFileSync(join(cwd, GOVERNANCE_FILE), 'utf8')) as {
      recordedBy: string;
      excluded: string[];
    };
    expect(recorded.recordedBy).toBe('sync');
    expect(recorded.excluded).toEqual(['Payment']);
  });

  it('preserves the deny-list across a later --accept-governance', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    await sync({ acceptGovernance: true });
    await sync({ exclude: ['Payment'] });

    writeConfig({ actions: ORDER_CRUD.replace(", policy: { approval: 'required' }", '') });
    expect(await sync({ acceptGovernance: true })).toBe(0);

    // Re-recording the posture is an assertion about gates, not about which
    // tables were refused. Dropping the deny-list here would resurrect Payment
    // as a proposal on the next run.
    expect(recordedExclusions()).toEqual(['Payment']);
  });

  /**
   * ONT-063. This command's own report tells the operator to run
   * `orangerail sync --exclude <name>`, and the name they retype comes from
   * whichever surface they were last looking at — `psql`, where the table is
   * `payment`, as readily as the schema file, where the model is `Payment`.
   * What gets WRITTEN has to be the scanned name either way: `splitExclusions`
   * compares the recorded list exactly, so a file holding `payment` would be a
   * deny-list matching nothing.
   */
  it('records the scanned name whatever casing --exclude was typed in (ONT-063)', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    await sync({ acceptGovernance: true });
    out = [];

    expect(await sync({ exclude: ['payment'] })).toBe(0);
    expect(recordedExclusions()).toEqual(['Payment']);
    expect(printed()).toContain(`info: Payment is excluded, as recorded in ${GOVERNANCE_FILE}`);

    // The proof that the recorded name is the one the next run compares: a
    // fresh run reading only the file is green and quiet.
    out = [];
    expect(await sync()).toBe(0);
    expect(printed()).not.toContain('proposal:');
    expect(printed()).not.toContain('matches nothing in your sources');
  });

  it('counts refused models, not typed strings, when the same one is named twice (ONT-063)', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    await sync({ acceptGovernance: true });
    out = [];

    expect(await sync({ exclude: ['PAYMENT', 'payment'] })).toBe(0);
    expect(recordedExclusions()).toEqual(['Payment']);
    expect(printed()).toContain('recorded 1 refused model(s)');
  });

  it('still refuses a name that matches nothing even ignoring case (ONT-063)', async () => {
    writeConfig({ actions: ORDER_CRUD });
    writeSchema();
    await sync({ acceptGovernance: true });
    out = [];

    // One keystroke from `payment`, and not `payment`. No prefix or plural rule
    // rescues it: this flag decides which tables an agent can reach.
    for (const near of ['paymnet', 'payments', 'pay']) {
      expect(await sync({ exclude: [near] })).toBe(2);
    }

    expect(printed()).toContain('which your sources do not have');
    expect(recordedExclusions()).toEqual([]);
  });

  it('refuses rather than picks when two model names differ only in case (ONT-063)', async () => {
    writeConfig({ actions: ORDER_CRUD });
    // Both are declared, so the allocator renames the second to `payment_2` —
    // and a rule folding only the emitted names would see no collision at all.
    writeSchema({
      source: `${PRISMA_SCHEMA}
model payment {
  id String @id
}
`,
    });
    await sync({ acceptGovernance: true });
    out = [];

    expect(await sync({ exclude: ['Payment'] })).toBe(2);
    expect(printed()).toContain(
      'which could mean Payment or payment_2 — those source names differ only in case',
    );
    expect(recordedExclusions()).toEqual([]);

    // The de-collided name resolves, because it names exactly one model.
    out = [];
    expect(await sync({ exclude: ['payment_2'] })).toBe(1);
    expect(recordedExclusions()).toEqual(['payment_2']);
  });
});
