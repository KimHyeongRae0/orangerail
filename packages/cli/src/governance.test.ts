import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistry, type Registry, type WhereClause } from 'orangerail-core';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  actionPostures,
  diffGovernance,
  exposedExclusionDetail,
  GOVERNANCE_FILE,
  isUnreviewed,
  parseBaseline,
  reviewGovernance,
  serializeBaseline,
  withholdActions,
  writeBaseline,
  type ActionPosture,
} from './governance';

const posture = (over: Partial<ActionPosture> & { name: string }): ActionPosture => ({
  approval: 'required',
  roles: [],
  where: null,
  target: null,
  ...over,
});

/**
 * A registry holding one action whose policy is exactly what the caller passes —
 * the runtime stand-in for a hand-edited `ontology/<action>.mjs`.
 */
const registryWith = ({
  approval,
  roles,
  where,
  targeted,
}: {
  approval?: 'required' | undefined;
  roles?: string[] | undefined;
  where?: WhereClause | undefined;
  targeted?: boolean;
}) => {
  const registry = createRegistry();

  const customer = registry.defineObject({
    name: 'Customer',
    schema: z.object({ id: z.string() }),
    resolve: { get: async () => ({ id: 'c1' }) },
  });

  registry.defineAction({
    name: 'deleteCustomer',
    input: z.object({ customerId: z.string() }),
    ...(targeted === false ? {} : { target: customer, targetIdFrom: 'customerId' }),
    policy: {
      ...(approval === undefined ? {} : { approval }),
      ...(roles === undefined ? {} : { roles }),
      ...(where === undefined ? {} : { where }),
    },
    execute: async () => undefined,
  });

  return registry;
};

describe('actionPostures', () => {
  it('reads the gate, roles, guard and target off the live registry', () => {
    const registry = registryWith({
      approval: 'required',
      roles: ['ops', 'admin'],
      where: { field: 'status', op: 'eq', value: 'draft' },
    });

    expect(actionPostures({ registry })).toEqual([
      {
        name: 'deleteCustomer',
        approval: 'required',
        // Sorted, so a reordered `roles` array is never reported as a change.
        roles: ['admin', 'ops'],
        where: 'status eq "draft"',
        target: 'Customer#customerId',
      },
    ]);
  });

  it('records an un-gated action as approval null and a functional guard as opaque', () => {
    const registry = registryWith({ where: () => true });

    expect(actionPostures({ registry })[0]).toMatchObject({
      approval: null,
      where: 'functional',
    });
  });
});

describe('diffGovernance — the reported defect', () => {
  /**
   * THE regression. `ontology/deleteCustomer.mjs` had its
   * `policy: { approval: 'required' }` line deleted; sync used to call that
   * "in sync with your sources" and exit 0.
   */
  it('reports a removed approval gate as WEAKENED', () => {
    const baseline = [posture({ name: 'deleteCustomer', target: 'Customer#customerId' })];
    const current = actionPostures({ registry: registryWith({}) });

    const changes = diffGovernance({ baseline, current });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.direction).toBe('weakened');
    expect(changes[0]?.action).toBe('deleteCustomer');
    expect(changes[0]?.detail).toContain('approval gate removed');
  });

  it('stays completely silent when the posture is unchanged', () => {
    const current = actionPostures({ registry: registryWith({ approval: 'required' }) });

    expect(diffGovernance({ baseline: current, current })).toEqual([]);
  });
});

describe('diffGovernance — direction table', () => {
  const before = posture({
    name: 'act',
    approval: 'required',
    roles: ['admin', 'ops'],
    where: 'status eq "draft"',
    target: 'Order#orderId',
  });

  const cases: { label: string; after: ActionPosture; direction: 'weakened' | 'strengthened' }[] = [
    {
      label: 'gate removed',
      after: { ...before, approval: null },
      direction: 'weakened',
    },
    {
      label: 'guard removed',
      after: { ...before, where: null },
      direction: 'weakened',
    },
    {
      label: 'guard rewritten (not orderable)',
      after: { ...before, where: 'status eq "shipped"' },
      direction: 'weakened',
    },
    {
      label: 'roles removed — anyone may approve',
      after: { ...before, roles: [] },
      direction: 'weakened',
    },
    {
      label: 'roles widened with an unrelated role',
      after: { ...before, roles: ['admin', 'intern', 'ops'] },
      direction: 'weakened',
    },
    {
      label: 'target removed',
      after: { ...before, target: null },
      direction: 'weakened',
    },
    {
      label: 'target repointed at another row',
      after: { ...before, target: 'Order#customerId' },
      direction: 'weakened',
    },
    {
      label: 'roles narrowed',
      after: { ...before, roles: ['admin'] },
      direction: 'strengthened',
    },
  ];

  for (const { label, after, direction } of cases) {
    it(`classifies ${label} as ${direction}`, () => {
      const changes = diffGovernance({ baseline: [before], current: [after] });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.direction).toBe(direction);
    });
  }

  it('classifies a gate added and a guard added as strengthened', () => {
    const bare = posture({ name: 'act', approval: null });
    const hardened = posture({ name: 'act', approval: 'required', where: 'status eq "draft"' });

    const directions = diffGovernance({ baseline: [bare], current: [hardened] }).map(
      (change) => change.direction,
    );

    expect(directions).toEqual(['strengthened', 'strengthened']);
  });

  it('treats an empty roles list as the widest set, so adding roles narrows it', () => {
    const anyone = posture({ name: 'act', roles: [] });
    const restricted = posture({ name: 'act', roles: ['admin'] });

    expect(diffGovernance({ baseline: [anyone], current: [restricted] })[0]?.direction).toBe(
      'strengthened',
    );
  });
});

describe('diffGovernance — the action set', () => {
  it('flags a new un-gated action as weakened', () => {
    const changes = diffGovernance({
      baseline: [],
      current: [posture({ name: 'wipeDatabase', approval: null })],
    });

    expect(changes[0]?.direction).toBe('weakened');
    expect(changes[0]?.detail).toContain('NOT approval-gated');
  });

  it('reports a new approval-gated action as information only', () => {
    const changes = diffGovernance({
      baseline: [],
      current: [posture({ name: 'refundOrder' })],
    });

    expect(changes[0]?.direction).toBe('strengthened');
  });

  it('reports a deleted action as information only — less exposure is never weaker', () => {
    const changes = diffGovernance({ baseline: [posture({ name: 'refundOrder' })], current: [] });

    expect(changes[0]?.direction).toBe('strengthened');
    expect(changes[0]?.detail).toContain('removed from the ontology');
  });
});

describe('the recorded baseline file', () => {
  const postures = [
    posture({ name: 'b', roles: ['ops', 'admin'] }),
    posture({ name: 'a', approval: null }),
  ];

  it('round-trips and is byte-stable regardless of input order', () => {
    const recorded = serializeBaseline({
      postures: actionPostures({ registry: registryWith({}) }),
      recordedBy: 'sync',
      excluded: [],
    });

    expect(recorded.endsWith('\n')).toBe(true);
    expect(
      serializeBaseline({
        postures: parseBaseline({ source: recorded }).actions,
        recordedBy: 'sync',
        excluded: [],
      }),
    ).toBe(recorded);
  });

  it('sorts rows and roles on read so an unchanged posture never reads as a change', () => {
    const parsed = parseBaseline({
      source: serializeBaseline({ postures, recordedBy: 'sync', excluded: [] }),
    }).actions;

    expect(parsed.map((row) => row.name)).toEqual(['a', 'b']);
    expect(parsed[1]?.roles).toEqual(['admin', 'ops']);
    expect(diffGovernance({ baseline: parsed, current: parsed })).toEqual([]);
  });

  it('throws on malformed content rather than degrading to "no baseline"', () => {
    expect(() => parseBaseline({ source: 'not json' })).toThrow(/not valid JSON/);
    expect(() => parseBaseline({ source: '{"version":99,"actions":[]}' })).toThrow(/version/);
    expect(() => parseBaseline({ source: '{"version":1}' })).toThrow(/`actions`/);
    expect(() => parseBaseline({ source: '{"version":1,"actions":[{}]}' })).toThrow(/`name`/);
    expect(() =>
      parseBaseline({ source: '{"version":1,"actions":[{"name":"a","approval":"maybe"}]}' }),
    ).toThrow(/approval/);
    expect(() =>
      parseBaseline({ source: '{"version":1,"recordedBy":"someone","actions":[]}' }),
    ).toThrow(/recordedBy/);
  });

  /**
   * ONT-050 — the file now records WHO wrote it, because `init` writes one too
   * and a baseline that cannot tell "generated" from "reviewed" would be
   * claiming an approval nobody gave. That is the objection ONT-043 raised
   * against writing it at `init` at all, and this field is the answer to it.
   */
  it('records the provenance and reads it back', () => {
    const byInit = parseBaseline({
      source: serializeBaseline({ postures, recordedBy: 'init', excluded: [] }),
    });
    const bySync = parseBaseline({
      source: serializeBaseline({ postures, recordedBy: 'sync', excluded: [] }),
    });

    expect(byInit.recordedBy).toBe('init');
    expect(bySync.recordedBy).toBe('sync');
    // The note is what someone who opens the file reads, so it must say which
    // of the two this is, not a single sentence that covers both.
    expect(serializeBaseline({ postures, recordedBy: 'init', excluded: [] })).toContain(
      'before anyone reviewed',
    );
    expect(serializeBaseline({ postures, recordedBy: 'sync', excluded: [] })).toContain(
      'a human reviewed',
    );
  });

  it('reads a pre-ONT-050 baseline (no `recordedBy`) as reviewed — only sync could have written it', () => {
    const legacy = JSON.stringify({
      version: 1,
      note: 'Governance baseline recorded by orangerail.',
      actions: [posture({ name: 'deleteCustomer' })],
    });

    const parsed = parseBaseline({ source: legacy });

    expect(parsed.recordedBy).toBe('sync');
    expect(parsed.actions).toHaveLength(1);
  });
});

describe('reviewGovernance — the one verdict sync, status and mcp share', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orangerail-gov-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const record = ({
    registry,
    recordedBy,
    excluded = [],
  }: {
    registry: Registry;
    recordedBy: 'init' | 'sync';
    excluded?: string[];
  }) =>
    writeBaseline({
      projectRoot: root,
      postures: actionPostures({ registry }),
      recordedBy,
      excluded,
    });

  it('reports `unrecorded` when there are actions and no file, and `no-actions` when there is nothing to vouch for', () => {
    expect(reviewGovernance({ projectRoot: root, registry: registryWith({}) }).state).toBe(
      'unrecorded',
    );
    expect(reviewGovernance({ projectRoot: root, registry: createRegistry() }).state).toBe(
      'no-actions',
    );
  });

  it('reports `verified` and carries the provenance through', () => {
    record({ registry: registryWith({ approval: 'required' }), recordedBy: 'init', excluded: [] });

    const review = reviewGovernance({
      projectRoot: root,
      registry: registryWith({ approval: 'required' }),
    });

    expect(review.state).toBe('verified');
    expect(review.weakenedActions).toEqual([]);
    expect(isUnreviewed({ review })).toBe(true);
  });

  it('names exactly the weakened actions, and a strengthened one never lands in that set', () => {
    record({ registry: registryWith({ approval: 'required' }), recordedBy: 'sync', excluded: [] });

    const weakened = reviewGovernance({ projectRoot: root, registry: registryWith({}) });
    expect(weakened.state).toBe('weakened');
    expect(weakened.weakenedActions).toEqual(['deleteCustomer']);

    record({ registry: registryWith({}), recordedBy: 'sync', excluded: [] });

    const strengthened = reviewGovernance({
      projectRoot: root,
      registry: registryWith({ approval: 'required' }),
    });
    expect(strengthened.state).toBe('verified');
    expect(strengthened.weakenedActions).toEqual([]);
    expect(strengthened.changes.map((change) => change.direction)).toEqual(['strengthened']);
  });

  /**
   * A corrupt baseline must never read as "nothing to compare against" — that
   * silent downgrade is the whole failure mode the baseline exists to remove.
   * It is a distinct state, so each caller can choose: `sync` exits 2, the
   * server reports it and serves rather than locking the operator out.
   */
  it('reports `unreadable` with the reason instead of degrading to "no baseline"', () => {
    writeFileSync(join(root, GOVERNANCE_FILE), '{ this is not json', 'utf8');

    const review = reviewGovernance({ projectRoot: root, registry: registryWith({}) });

    expect(review.state).toBe('unreadable');
    expect(review.detail).toMatch(/not valid JSON/);
    expect(review.weakenedActions).toEqual([]);
  });
});

describe('withholdActions — the server refuses the weakened action, not the ontology', () => {
  it('removes it from listActions AND from getAction, leaving objects untouched', () => {
    const registry = registryWith({ approval: 'required' });
    registry.defineAction({
      name: 'archiveCustomer',
      input: z.object({ customerId: z.string() }),
      policy: { approval: 'required' },
      execute: async () => undefined,
    });

    const served = withholdActions({ registry, names: new Set(['deleteCustomer']) });

    expect(served.listActions().map((action) => action.name)).toEqual(['archiveCustomer']);
    // Hiding the tool alone would still execute for a client that knows the
    // name: core's engine resolves the action by name on stage and on complete.
    expect(served.getAction({ name: 'deleteCustomer' })).toBeUndefined();
    expect(served.getAction({ name: 'archiveCustomer' })?.name).toBe('archiveCustomer');
    expect(served.listObjects().map((object) => object.name)).toEqual(['Customer']);
    // The declared registry is a view source, never mutated.
    expect(registry.getAction({ name: 'deleteCustomer' })?.name).toBe('deleteCustomer');
  });

  it('carries every OTHER registry member through, `listLinks` included (ONT-053)', () => {
    // The view is a spread, so it forwards members it has never heard of. That
    // is load-bearing rather than incidental: `orangerail mcp` now calls
    // `listLinks()` to describe its read tools, and this view is the registry it
    // is handed on any project with governance drift. Rebuilt as a fresh object
    // literal, the server would throw on start — on the drift path only, which
    // is exactly the path a green CI run does not exercise.
    const registry = registryWith({ approval: 'required' });
    const order = registry.defineObject({
      name: 'Order',
      schema: z.object({ id: z.string() }),
      resolve: { get: async () => ({ id: 'o1' }) },
    });

    registry.defineLink({
      name: 'Customer_orders',
      from: registry.getObject({ name: 'Customer' })!,
      to: order,
      cardinality: 'many',
    });

    const served = withholdActions({ registry, names: new Set(['deleteCustomer']) });

    expect(typeof served.listLinks).toBe('function');
    expect(served.listLinks().map((link) => link.name)).toEqual(['Customer_orders']);
    expect(served.getObject({ name: 'Order' })?.name).toBe('Order');
  });
});

/**
 * The deny-list (ONT-059). It lives in the same file as the postures because
 * both are clauses of one committed intention about the agent's surface — and
 * because two files could disagree about it.
 */
describe('the recorded deny-list', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orangerail-excl-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips sorted and de-duplicated, and explains itself in the note', () => {
    const recorded = serializeBaseline({
      postures: [],
      recordedBy: 'init',
      excluded: ['payment', 'api_credential', 'payment'],
    });

    expect(parseBaseline({ source: recorded }).excluded).toEqual(['api_credential', 'payment']);
    // Someone who opens the file has to learn the one property that decides
    // whether they can trust it: it is a list of names, not a snapshot.
    expect(recorded).toContain('list of NAMES, not a snapshot');
    expect(serializeBaseline({ postures: [], recordedBy: 'init', excluded: [] })).not.toContain(
      'list of NAMES',
    );
  });

  it('reads a pre-ONT-059 baseline as an empty deny-list, with no version bump', () => {
    const legacy = JSON.stringify({ version: 1, recordedBy: 'sync', actions: [] });

    expect(parseBaseline({ source: legacy }).excluded).toEqual([]);
  });

  it('throws on a malformed deny-list rather than reading it as "nothing was refused"', () => {
    expect(() =>
      parseBaseline({ source: '{"version":1,"excluded":"payment","actions":[]}' }),
    ).toThrow(/`excluded`/);
    expect(() => parseBaseline({ source: '{"version":1,"excluded":[7],"actions":[]}' })).toThrow(
      /`excluded`/,
    );
  });

  it('carries the deny-list onto the review and names an exclusion the registry exposes', () => {
    const registry = registryWith({ approval: 'required' });

    writeBaseline({
      projectRoot: root,
      postures: actionPostures({ registry }),
      recordedBy: 'sync',
      excluded: ['Customer', 'Payment'],
    });

    const review = reviewGovernance({ projectRoot: root, registry });

    expect(review.excluded).toEqual(['Customer', 'Payment']);
    // `Customer` is a live registry object, so the file and the ontology
    // contradict each other; `Payment` is refused and absent, as recorded.
    expect(review.exposedExclusions).toEqual(['Customer']);
    // The contradiction is its own field, not a state, because the posture can
    // be weakened at the same time and one state cannot say both.
    expect(review.state).toBe('verified');
    expect(exposedExclusionDetail({ name: 'Customer' })).toContain(GOVERNANCE_FILE);
  });

  it('reports no exposure when nothing refused is in the registry', () => {
    const registry = registryWith({ approval: 'required' });

    writeBaseline({
      projectRoot: root,
      postures: actionPostures({ registry }),
      recordedBy: 'sync',
      excluded: ['Payment'],
    });

    expect(reviewGovernance({ projectRoot: root, registry }).exposedExclusions).toEqual([]);
  });

  it('reports an empty deny-list when there is no baseline and when one cannot be read', () => {
    const registry = registryWith({ approval: 'required' });

    expect(reviewGovernance({ projectRoot: root, registry }).excluded).toEqual([]);

    writeFileSync(join(root, GOVERNANCE_FILE), '{ not json', 'utf8');

    const unreadable = reviewGovernance({ projectRoot: root, registry });
    expect(unreadable.state).toBe('unreadable');
    expect(unreadable.excluded).toEqual([]);
  });
});
