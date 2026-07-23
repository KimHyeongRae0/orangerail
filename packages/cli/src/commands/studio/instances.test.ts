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
  });
});
