import ELK from 'elkjs/lib/elk.bundled.js';

import type { InstanceSnapshot } from '../snapshot/instances';
import { personNodeId, personRadius, serviceNodeId } from './instanceModel';

const elk = new ELK();

/** Service place-node layout box. */
const PLACE_WIDTH = 160;
const PLACE_HEIGHT = 64;

/**
 * elkjs `layered` tuning for the bipartite ownership layout (plan Decision 4).
 * Fixed partitions pin people to the left column (partition 0) and services to
 * the right (partition 1) while `layered`'s built-in layer-sweep crossing
 * minimization orders each column — the standard "bipartite via a 2-layer
 * layered layout" recipe, using the engine the repo already ships.
 */
const OWNERSHIP_ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'org.eclipse.elk.layered',
  'elk.direction': 'RIGHT',
  'elk.partitioning.activate': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '160',
  'elk.spacing.nodeNode': '40',
};

/**
 * A deterministic two-column fallback so the bipartite split always holds even
 * if ELK throws: people at x=0, services at x=520, each stacked vertically in a
 * stable order. The columns are disjoint on x by construction (AC-4).
 */
const columnFallback = ({
  personIds,
  serviceIds,
}: {
  personIds: string[];
  serviceIds: string[];
}): Map<string, { x: number; y: number }> => {
  const positions = new Map<string, { x: number; y: number }>();

  personIds.forEach((id, index) => {
    positions.set(id, { x: 0, y: index * 120 });
  });

  serviceIds.forEach((id, index) => {
    positions.set(id, { x: 520, y: index * 120 });
  });

  return positions;
};

/**
 * Compute the people <-> services bipartite ownership positions (plan Decision
 * 4, AC-4). Runs elkjs `layered` with fixed partitions (people = partition 0 on
 * the left, services = partition 1 on the right) and direction RIGHT so the two
 * node sets occupy two disjoint x-ranges with crossing minimization between
 * them. Degrades to the deterministic two-column fallback if ELK throws or
 * returns a degenerate result. Returns a position per node id, awaited into a
 * map exactly like `computeInstanceLayout`.
 */
export const computeOwnershipLayout = async ({
  snapshot,
}: {
  snapshot: InstanceSnapshot;
}): Promise<Map<string, { x: number; y: number }>> => {
  const personIds = snapshot.employees.map((employee) =>
    personNodeId({ accountId: employee.accountId }),
  );
  const serviceIds = snapshot.services.map((service) => serviceNodeId({ id: service.id }));

  if (personIds.length === 0 && serviceIds.length === 0) {
    return new Map();
  }

  const children = [
    ...snapshot.employees.map((employee) => {
      const diameter = personRadius({ storyPointsTotal: employee.storyPointsTotal }) * 2;

      return {
        id: personNodeId({ accountId: employee.accountId }),
        width: diameter,
        height: diameter,
        layoutOptions: { 'elk.partitioning.partition': '0' },
      };
    }),
    ...snapshot.services.map((service) => ({
      id: serviceNodeId({ id: service.id }),
      width: PLACE_WIDTH,
      height: PLACE_HEIGHT,
      layoutOptions: { 'elk.partitioning.partition': '1' },
    })),
  ];

  const edges = snapshot.edges.works_on.map((edge, index) => ({
    id: `o-works-${index}`,
    sources: [personNodeId({ accountId: edge.from })],
    targets: [serviceNodeId({ id: edge.to })],
  }));

  try {
    const result = await elk.layout({
      id: 'ownership-root',
      layoutOptions: OWNERSHIP_ELK_OPTIONS,
      children,
      edges,
    });

    const positions = new Map<string, { x: number; y: number }>();
    const widths = new Map(children.map((child) => [child.id, child.width]));

    for (const child of result.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }

    // Verify the bipartite invariant actually holds (every person centre left of
    // every service centre, mirroring the e2e), else fall back to fixed columns.
    const centreX = ({ id }: { id: string }): number =>
      (positions.get(id)?.x ?? 0) + (widths.get(id) ?? 0) / 2;

    const personMaxX = Math.max(
      ...personIds.map((id) => centreX({ id })),
      Number.NEGATIVE_INFINITY,
    );
    const serviceMinX = Math.min(
      ...serviceIds.map((id) => centreX({ id })),
      Number.POSITIVE_INFINITY,
    );

    const complete = positions.size === children.length;
    const disjoint = serviceIds.length === 0 || personIds.length === 0 || personMaxX < serviceMinX;

    if (!complete || !disjoint) {
      return columnFallback({ personIds, serviceIds });
    }

    return positions;
  } catch {
    return columnFallback({ personIds, serviceIds });
  }
};
