import ELK from 'elkjs/lib/elk.bundled.js';

import type { InstanceSnapshot } from '../snapshot/instances';
import { personNodeId, personRadius, serviceNodeId, teamNodeId } from './instanceModel';

const elk = new ELK();

/**
 * elkjs stress-layout tuning for the people/ONA network (plan Decision 4). The
 * stress algorithm ships in the installed elkjs 0.12.0 (no new dependency); it
 * places a weighted, non-hierarchical network with even edge lengths, which
 * reads as an ONA graph far better than the layered db layout. `force` is the
 * documented fallback if stress overlaps at a larger scale.
 */
export const INSTANCE_ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'org.eclipse.elk.stress',
  'org.eclipse.elk.stress.desiredEdgeLength': '180',
  'org.eclipse.elk.stress.epsilon': '0.0001',
  'elk.spacing.nodeNode': '60',
};

const PLACE_SIZE = 120;

/** A deterministic circular fallback so nodes never collapse to one point (AC-5). */
const circleFallback = ({ ids }: { ids: string[] }): Map<string, { x: number; y: number }> => {
  const positions = new Map<string, { x: number; y: number }>();
  const radius = Math.max(200, ids.length * 40);

  ids.forEach((id, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, ids.length);
    positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  });

  return positions;
};

/**
 * Compute instance-graph node positions with the elkjs stress algorithm (plan
 * Decision 4). Person nodes are sized by their story-point radius, place nodes
 * (services + team) get a fixed box; `helps`/`works_on`/`member_of` all feed the
 * layout so the network shape reflects the full collaboration graph. Isolated
 * nodes are placed by ELK, never dropped. If ELK throws for any reason the
 * result degrades to a deterministic circle so the view still renders with
 * distinct positions. Returns a position per node id, awaited into a map exactly
 * like `computeLayout`.
 */
export const computeInstanceLayout = async ({
  snapshot,
}: {
  snapshot: InstanceSnapshot;
}): Promise<Map<string, { x: number; y: number }>> => {
  const children = [
    ...snapshot.employees.map((employee) => {
      const diameter = personRadius({ storyPointsTotal: employee.storyPointsTotal }) * 2;

      return {
        id: personNodeId({ accountId: employee.accountId }),
        width: diameter,
        height: diameter,
      };
    }),
    ...snapshot.services.map((service) => ({
      id: serviceNodeId({ id: service.id }),
      width: PLACE_SIZE,
      height: PLACE_SIZE,
    })),
    ...snapshot.teams.map((team) => ({
      id: teamNodeId({ id: team.id }),
      width: PLACE_SIZE,
      height: PLACE_SIZE,
    })),
  ];

  const edges = [
    ...snapshot.edges.helps.map((edge, index) => ({
      id: `l-helps-${index}`,
      sources: [personNodeId({ accountId: edge.from })],
      targets: [personNodeId({ accountId: edge.to })],
    })),
    ...snapshot.edges.works_on.map((edge, index) => ({
      id: `l-works-${index}`,
      sources: [personNodeId({ accountId: edge.from })],
      targets: [serviceNodeId({ id: edge.to })],
    })),
    ...snapshot.edges.member_of.map((edge, index) => ({
      id: `l-member-${index}`,
      sources: [personNodeId({ accountId: edge.from })],
      targets: [teamNodeId({ id: edge.to })],
    })),
  ];

  const ids = children.map((child) => child.id);

  if (children.length === 0) {
    return new Map();
  }

  try {
    const result = await elk.layout({
      id: 'instances-root',
      layoutOptions: INSTANCE_ELK_OPTIONS,
      children,
      edges,
    });

    const positions = new Map<string, { x: number; y: number }>();

    for (const child of result.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }

    // Guard against a degenerate ELK result (all-zero / missing) by falling back.
    const distinct = new Set([...positions.values()].map((p) => `${p.x},${p.y}`));

    if (positions.size < ids.length || distinct.size <= 1) {
      return circleFallback({ ids });
    }

    return positions;
  } catch {
    return circleFallback({ ids });
  }
};
