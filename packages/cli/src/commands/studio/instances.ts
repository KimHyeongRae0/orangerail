import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Registry } from 'orangerail-core';
import {
  buildInstanceSnapshot,
  type InstanceEmployee,
  type InstanceIncident,
  type InstanceService,
  type InstanceSnapshot,
  type InstanceTeam,
} from 'orangerail-studio/snapshot';

/** The empty instance snapshot — the natural degrade for a type-only config. */
const emptyInstanceSnapshot = (): InstanceSnapshot => ({
  employees: [],
  services: [],
  teams: [],
  incidents: [],
  edges: { helps: [], works_on: [], member_of: [] },
});

/**
 * List an object type's instances through its declared read contract. This is
 * the honest instance source — the studio renders exactly what the ontology
 * exposes for reading. A missing object, a missing `list`, or a throwing/hanging
 * resolver degrades to `[]` rather than killing the gather (plan Risks): the
 * `list` call is raced against a short timeout so a hanging resolver can never
 * stall server startup (reviewer note 2).
 */
const listInstances = async <T>({
  registry,
  name,
}: {
  registry: Registry;
  name: string;
}): Promise<T[]> => {
  const object = registry.getObject({ name });

  if (!object?.resolve?.list) {
    return [];
  }

  const list = object.resolve.list;

  try {
    const result = await Promise.race([
      list({}),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`resolve.list('${name}') timed out`)), 5_000),
      ),
    ]);

    return (result.items ?? []) as T[];
  } catch {
    return [];
  }
};

/**
 * Read an emitted edge file from the config's sibling `data/` directory. Instance
 * edges (`helps`/`works_on`/`member_of`) are reachable no other way in v0 — core
 * links carry no instance resolver (plan Decision 1). A missing/unparseable file
 * degrades to an empty edge set, never a crash.
 */
const readEdgeFile = ({ dataDir, file }: { dataDir: string; file: string }): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * Gather the instance snapshot for the studio human view (plan Decision 1,
 * hybrid source): instances via each object's `resolve.list()` read contract,
 * collaboration edges via the emitted `data/*.json` files that sit beside the
 * resolved config. The result is built through the pure `buildInstanceSnapshot`
 * so ordering/determinism live in one place. Fully defensive — any failure
 * degrades to an empty snapshot; the server never dies on a bad config.
 */
export const gatherInstances = async ({
  registry,
  configPath,
}: {
  registry: Registry;
  configPath: string;
}): Promise<InstanceSnapshot> => {
  try {
    const [employees, services, teams, incidents] = await Promise.all([
      listInstances<InstanceEmployee>({ registry, name: 'employee' }),
      listInstances<InstanceService>({ registry, name: 'service' }),
      listInstances<InstanceTeam>({ registry, name: 'team' }),
      listInstances<InstanceIncident>({ registry, name: 'incident' }),
    ]);

    const dataDir = join(dirname(configPath), 'data');

    return buildInstanceSnapshot({
      employees,
      services,
      teams,
      incidents,
      helps: readEdgeFile({ dataDir, file: 'helps.json' }),
      worksOn: readEdgeFile({ dataDir, file: 'works_on.json' }),
      memberOf: readEdgeFile({ dataDir, file: 'member_of.json' }),
    });
  } catch {
    return emptyInstanceSnapshot();
  }
};
