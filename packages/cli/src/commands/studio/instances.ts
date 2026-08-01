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

import { toRenderableValue, type UnrenderableField } from '../../render';

/**
 * The instance snapshot as the studio serves it: the rows, plus the fields
 * inside them that are markers rather than values (ONT-071).
 *
 * It extends {@link InstanceSnapshot} rather than wrapping it so every existing
 * reader keeps reading exactly what it read before, and the one new fact rides
 * alongside instead of behind a shape change.
 */
export interface GatheredInstances extends InstanceSnapshot {
  /**
   * Every field the walk could not print as it is, named by where it sat
   * (`employee[3].salary`) and why.
   *
   * Derived from the walk, never from the rendered rows — the ONT-070 marker
   * contract. A row that CARRIES the literal marker text therefore shows up in
   * the rows and not in this list, and the two disagree, which is the only way a
   * reader can tell a refusal from a forgery.
   */
  unrenderable: UnrenderableField[];
}

/** The empty instance snapshot — the natural degrade for a type-only config. */
const emptyInstanceSnapshot = (): GatheredInstances => ({
  employees: [],
  services: [],
  teams: [],
  incidents: [],
  edges: { helps: [], works_on: [], member_of: [] },
  unrenderable: [],
});

/**
 * How many unrenderable fields the payload NAMES before it stops listing and
 * says how many it stopped at.
 *
 * One bad column across a thousand rows is a thousand entries, and past the
 * first handful the list stops telling a reader anything new — it only buries
 * the rest of the payload. The markers themselves are never capped: every field
 * that could not be shown still carries its own marker in the row it sat in, so
 * nothing is dropped from the page and only the summary is bounded.
 */
const MAX_LISTED_UNRENDERABLE = 50;

/** Cap the marker list, stating the count it withheld rather than trailing off. */
const capFields = ({ fields }: { fields: UnrenderableField[] }): UnrenderableField[] =>
  fields.length <= MAX_LISTED_UNRENDERABLE
    ? fields
    : [
        ...fields.slice(0, MAX_LISTED_UNRENDERABLE),
        {
          path: '$',
          reason:
            `${fields.length - MAX_LISTED_UNRENDERABLE} further field(s) could not be shown ` +
            'as they are; each still carries its own marker in the row it sits in',
        },
      ];

/**
 * What a marker names the row it sat in.
 *
 * NOT the index the resolver returned it at: the snapshot is sorted after this,
 * so an index would send a reader to a different row than the one the marker is
 * about. A row's own key survives that sort. The index is the fallback for a row
 * with no usable key — including the case where the key is itself the thing that
 * could not be printed, which is why it is spelled `#2` and not `2`.
 *
 * The read is guarded because reading a property is arbitrary user code: a
 * throwing getter on the id field would otherwise take the whole gather down.
 */
const rowPath = ({ name, row, index }: { name: string; row: unknown; index: number }): string => {
  try {
    const fields = row as { accountId?: unknown; id?: unknown } | null;
    const key = typeof fields?.accountId === 'string' ? fields.accountId : fields?.id;

    if (typeof key === 'string' && key !== '') {
      return `${name}[${key}]`;
    }
  } catch {
    // Falls through to the positional form below.
  }

  return `${name}[#${index}]`;
};

/**
 * List an object type's instances through its declared read contract. This is
 * the honest instance source — the studio renders exactly what the ontology
 * exposes for reading. A missing object, a missing `list`, or a throwing/hanging
 * resolver degrades to `[]` rather than killing the gather (plan Risks): the
 * `list` call is raced against a short timeout so a hanging resolver can never
 * stall server startup (reviewer note 2).
 *
 * The rows are walked by the total renderer on the way in (ONT-071). This is the
 * boundary where untrusted values enter the CLI and where a cast into a typed
 * struct claims they are ordinary JSON, and the walk is what makes that cast
 * survivable. It has to happen HERE rather than at the response: past this point
 * the rows are sorted by `accountId`/`id`, and a comparator that throws on one
 * exotic key would empty the entire snapshot into the gather's catch — the whole
 * page silently gone because of one column.
 */
const listInstances = async <T>({
  registry,
  name,
}: {
  registry: Registry;
  name: string;
}): Promise<{ items: T[]; fields: UnrenderableField[] }> => {
  const object = registry.getObject({ name });

  if (!object?.resolve?.list) {
    return { items: [], fields: [] };
  }

  const list = object.resolve.list;

  try {
    const result = await Promise.race([
      list({}),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`resolve.list('${name}') timed out`)), 5_000),
      ),
    ]);

    const rendered = (result.items ?? []).map((row, index) =>
      toRenderableValue({ value: row, path: rowPath({ name, row, index }) }),
    );

    return {
      items: rendered.map((walk) => walk.value) as T[],
      fields: rendered.flatMap((walk) => walk.fields),
    };
  } catch {
    return { items: [], fields: [] };
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
}): Promise<GatheredInstances> => {
  try {
    const [employees, services, teams, incidents] = await Promise.all([
      listInstances<InstanceEmployee>({ registry, name: 'employee' }),
      listInstances<InstanceService>({ registry, name: 'service' }),
      listInstances<InstanceTeam>({ registry, name: 'team' }),
      listInstances<InstanceIncident>({ registry, name: 'incident' }),
    ]);

    const dataDir = join(dirname(configPath), 'data');

    return {
      ...buildInstanceSnapshot({
        employees: employees.items,
        services: services.items,
        teams: teams.items,
        incidents: incidents.items,
        helps: readEdgeFile({ dataDir, file: 'helps.json' }),
        worksOn: readEdgeFile({ dataDir, file: 'works_on.json' }),
        memberOf: readEdgeFile({ dataDir, file: 'member_of.json' }),
      }),
      unrenderable: capFields({
        fields: [...employees.fields, ...services.fields, ...teams.fields, ...incidents.fields],
      }),
    };
  } catch {
    return emptyInstanceSnapshot();
  }
};
