import type { InstanceSnapshot } from '../snapshot/instances';
import {
  personNodeId,
  personRadius,
  serviceNodeId,
  type InstanceEdge,
  type InstanceNode,
} from './instanceModel';

/** Fixed service place-node box (matches the ServiceNode CSS bounds). */
const PLACE_WIDTH = 160;
const PLACE_HEIGHT = 64;

/**
 * Build the Ownership view: a people <-> services bipartite graph from
 * `works_on` only (plan Decision 4, AC-4). Every employee becomes a person node
 * and every service a service node (reusing the `PersonNode`/`ServiceNode`
 * components), and only `works_on` edges are emitted — no `helps`, no
 * `member_of`, no team. Isolated people and idle services are still emitted
 * (edge case). No focus/dim in this view. Pure over the snapshot; every string
 * renders as inert React text (AC-5).
 */
export const buildOwnershipGraph = ({
  snapshot,
  positions,
}: {
  snapshot: InstanceSnapshot;
  positions: Map<string, { x: number; y: number }>;
}): { nodes: InstanceNode[]; edges: InstanceEdge[] } => {
  const nodes: InstanceNode[] = [];

  for (const employee of snapshot.employees) {
    const id = personNodeId({ accountId: employee.accountId });
    const radius = personRadius({ storyPointsTotal: employee.storyPointsTotal });

    nodes.push({
      id,
      type: 'person',
      position: positions.get(id) ?? { x: 0, y: 0 },
      width: radius * 2,
      height: radius * 2,
      data: { employee, radius, active: false, dim: false },
    });
  }

  for (const service of snapshot.services) {
    const id = serviceNodeId({ id: service.id });

    nodes.push({
      id,
      type: 'service',
      position: positions.get(id) ?? { x: 0, y: 0 },
      width: PLACE_WIDTH,
      height: PLACE_HEIGHT,
      data: { kind: 'service', label: service.name, service, dim: false },
    });
  }

  const edges: InstanceEdge[] = [];

  snapshot.edges.works_on.forEach((edge, index) => {
    edges.push({
      id: `own-works_on:${index}:${edge.from}->${edge.to}`,
      type: 'worksOn',
      source: personNodeId({ accountId: edge.from }),
      target: serviceNodeId({ id: edge.to }),
      data: { weight: edge.weight, variant: 'worksOn', dim: false },
    });
  });

  return { nodes, edges };
};
