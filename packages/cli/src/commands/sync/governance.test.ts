import { createRegistry, type WhereClause } from 'orangerail-core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  actionPostures,
  diffGovernance,
  parseBaseline,
  serializeBaseline,
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
    });

    expect(recorded.endsWith('\n')).toBe(true);
    expect(serializeBaseline({ postures: parseBaseline({ source: recorded }) })).toBe(recorded);
  });

  it('sorts rows and roles on read so an unchanged posture never reads as a change', () => {
    const parsed = parseBaseline({
      source: serializeBaseline({ postures }),
    });

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
  });
});
