import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistry } from 'orangerail-core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { gatherInstances } from './instances';

const buildRegistry = ({
  employees,
  services,
  throwing = false,
}: {
  employees: unknown[];
  services: unknown[];
  throwing?: boolean;
}) => {
  const registry = createRegistry();

  registry.defineObject({
    name: 'employee',
    schema: z.object({ accountId: z.string(), displayName: z.string() }),
    resolve: {
      get: async () => null,
      list: async () => {
        if (throwing) {
          throw new Error('boom');
        }
        return { items: employees };
      },
    },
  });

  registry.defineObject({
    name: 'service',
    schema: z.object({ id: z.string(), name: z.string() }),
    resolve: { get: async () => null, list: async () => ({ items: services }) },
  });

  return registry;
};

describe('gatherInstances (plan Decision 1 — hybrid source)', () => {
  it('lists instances via resolvers and edges via sibling data/*.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-011-gather-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(
      join(dir, 'data', 'helps.json'),
      JSON.stringify([{ from: 'a', to: 'b', weight: 2 }]),
      'utf8',
    );
    writeFileSync(join(dir, 'data', 'works_on.json'), JSON.stringify([]), 'utf8');
    writeFileSync(join(dir, 'data', 'member_of.json'), JSON.stringify([]), 'utf8');

    const registry = buildRegistry({
      employees: [{ accountId: 'a', displayName: 'Ann' }],
      services: [{ id: 's1', name: 'Svc' }],
    });

    const snapshot = await gatherInstances({
      registry,
      configPath: join(dir, 'orangerail.config.mjs'),
    });

    expect(snapshot.employees.length).toBe(1);
    expect(snapshot.services.length).toBe(1);
    expect(snapshot.edges.helps).toEqual([{ from: 'a', to: 'b', weight: 2 }]);
  });

  it('degrades to empty edge sets when the data dir is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-011-gather-'));
    const registry = buildRegistry({ employees: [], services: [] });

    const snapshot = await gatherInstances({
      registry,
      configPath: join(dir, 'orangerail.config.mjs'),
    });

    expect(snapshot.edges).toEqual({ helps: [], works_on: [], member_of: [] });
  });

  it('tolerates a throwing resolver (skips to empty for that object)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-011-gather-'));
    const registry = buildRegistry({ employees: [], services: [], throwing: true });

    const snapshot = await gatherInstances({
      registry,
      configPath: join(dir, 'orangerail.config.mjs'),
    });

    expect(snapshot.employees).toEqual([]);
    // The pre-existing error path, unchanged: a resolver that throws is not a
    // row that could not be printed, and claiming an unrenderable field where
    // there was never a row would be the wrong diagnosis.
    expect(snapshot.unrenderable).toEqual([]);
  });
});

/**
 * ONT-071 — the studio serves rows read from a live datasource, and
 * `JSON.stringify` refuses several things a real row carries. Before this, one
 * such column killed `orangerail studio` outright: the throw landed inside a
 * node:http request handler, which is an uncaught exception, which ends the
 * process.
 *
 * The rows are walked by ONT-070's renderer as they enter, so each such field
 * becomes a NAMED marker and the row around it survives. The walk happens here
 * rather than at the response because what sits between is the snapshot builder,
 * which sorts by `accountId`/`id` — one exotic sort key would throw in the
 * comparator and empty the whole snapshot into the gather's catch.
 */
describe('gatherInstances — a row it cannot print is named, not fatal (ONT-071)', () => {
  const gather = async ({ employees }: { employees: unknown[] }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-071-gather-'));

    return gatherInstances({
      registry: buildRegistry({ employees, services: [] }),
      configPath: join(dir, 'orangerail.config.mjs'),
    });
  };

  const reasonAt = ({
    snapshot,
    path,
  }: {
    snapshot: Awaited<ReturnType<typeof gather>>;
    path: string;
  }): string => snapshot.unrenderable.find((field) => field.path === path)?.reason ?? '';

  it('names a circular reference, a function, a symbol key and a bigint', async () => {
    const cyclic: Record<string, unknown> = { accountId: 'a', displayName: 'Ann' };
    cyclic['self'] = cyclic;

    const badge = Symbol('badge');
    const snapshot = await gather({
      employees: [
        cyclic,
        { accountId: 'b', displayName: 'Bob', toString: () => 'Bob' },
        { accountId: 'c', displayName: 'Cy', [badge]: 'gold' },
        { accountId: 'd', displayName: 'Di', headcount: 9007199254740993n },
      ],
    });

    expect(snapshot.employees).toHaveLength(4);
    expect(reasonAt({ snapshot, path: 'employee[a].self' })).toContain('circular reference');
    expect(reasonAt({ snapshot, path: 'employee[b].toString' })).toContain('a function');
    expect(reasonAt({ snapshot, path: 'employee[c].[symbol key] Symbol(badge)' })).toContain(
      'symbol-keyed',
    );
    expect(reasonAt({ snapshot, path: 'employee[d].headcount' })).toContain('a bigint');

    // Named in the rows too, not only in the list — the page shows the marker
    // where the value would have been, and every sibling field survives.
    expect(JSON.stringify(snapshot)).toContain('UNRENDERABLE');
    expect(snapshot.employees.map((employee) => employee.displayName)).toEqual([
      'Ann',
      'Bob',
      'Cy',
      'Di',
    ]);
  });

  it('serializes a snapshot that JSON.stringify would have thrown on', async () => {
    const cyclic: Record<string, unknown> = { accountId: 'a', displayName: 'Ann' };
    cyclic['self'] = cyclic;

    const snapshot = await gather({ employees: [cyclic] });

    expect(() => JSON.stringify([cyclic])).toThrow();
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it('keeps every row when the SORT KEY itself is the unrenderable value', async () => {
    // The comparator reads `accountId` directly. A bigint there used to throw
    // inside `sort`, and the gather's catch turned that into an empty snapshot —
    // the whole page gone, silently, because of one column.
    const snapshot = await gather({
      employees: [
        { accountId: 1n, displayName: 'Ann' },
        { accountId: 2n, displayName: 'Bob' },
      ],
    });

    expect(snapshot.employees).toHaveLength(2);
    // Positional, because the key is what could not be printed. The `#` says so:
    // every other path in this list is a row key, and one that reads like an
    // index must not be mistaken for one.
    expect(reasonAt({ snapshot, path: 'employee[#0].accountId' })).toContain('a bigint');
  });

  it('names a row by its key, so the list survives the sort the snapshot applies', async () => {
    const snapshot = await gather({
      employees: [
        { accountId: 'zz', displayName: 'Zed', headcount: 1n },
        { accountId: 'aa', displayName: 'Abe' },
      ],
    });

    // The rows come back sorted, so the marker's row is no longer where the
    // resolver returned it. Naming the row by index would point a reader at Abe.
    expect(snapshot.employees.map((employee) => employee.displayName)).toEqual(['Abe', 'Zed']);
    expect(snapshot.unrenderable[0]?.path).toBe('employee[zz].headcount');
  });

  it('caps the marker list without dropping a single marker from the rows', async () => {
    const employees = Array.from({ length: 60 }, (_, index) => ({
      accountId: `a${String(index).padStart(2, '0')}`,
      displayName: 'Ann',
      headcount: BigInt(index),
    }));

    const snapshot = await gather({ employees });
    const listed = snapshot.unrenderable;

    expect(listed).toHaveLength(51);
    expect(listed[50]?.reason).toContain('10 further field(s)');
    // The cap is on the LIST. Every one of the 60 fields still carries its own
    // marker in the row it sat in, so nothing is hidden from the page.
    expect(
      snapshot.employees.filter((employee) =>
        String((employee as unknown as { headcount: string }).headcount).includes('UNRENDERABLE'),
      ),
    ).toHaveLength(60);
  });

  it('leaves an ordinary row byte-identical, with an empty marker list', async () => {
    const employees = [{ accountId: 'a', displayName: 'Ann', ticketCount: 3, active: true }];
    const snapshot = await gather({ employees });

    expect(snapshot.unrenderable).toEqual([]);
    expect(JSON.stringify(snapshot.employees)).toBe(JSON.stringify(employees));
  });
});
