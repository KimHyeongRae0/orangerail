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
 * The Ownership view's current focus: a selected person (highlight the services
 * they work on) or a selected service (highlight the people who work on it), or
 * `null` for the neutral bipartite. Symmetric — a click on either side reveals
 * only the counterpart it connects to.
 */
export type OwnershipSelection =
  { type: 'person'; accountId: string } | { type: 'service'; id: string } | null;

const worksOnEdgeId = ({ index, from, to }: { index: number; from: string; to: string }): string =>
  `own-works_on:${index}:${from}->${to}`;

/**
 * Build the Ownership view: a people <-> services bipartite graph from
 * `works_on` only (plan Decision 4, AC-4). Every employee becomes a person node
 * and every service a service node (reusing the `PersonNode`/`ServiceNode`
 * components), and only `works_on` edges are emitted — no `helps`, no
 * `member_of`, no team. Isolated people and idle services are still emitted
 * (edge case). Pure over the snapshot; every string renders as inert React text
 * (AC-5).
 *
 * Focus is symmetric: with a `selection`, the selected node plus its direct
 * counterparts (a person's services, or a service's people) and the edges
 * between them stay lit while everything else dims — so clicking `storefront-web`
 * shows only its owners, and clicking a person shows only what they own.
 */
export const buildOwnershipGraph = ({
  snapshot,
  positions,
  selection = null,
}: {
  snapshot: InstanceSnapshot;
  positions: Map<string, { x: number; y: number }>;
  selection?: OwnershipSelection;
}): { nodes: InstanceNode[]; edges: InstanceEdge[] } => {
  // One pass over `works_on` derives the lit set: the selected node, its direct
  // counterparts, and the edges joining them. Empty when nothing is selected.
  const litNodeIds = new Set<string>();
  const litEdgeIds = new Set<string>();

  if (selection) {
    litNodeIds.add(
      selection.type === 'person'
        ? personNodeId({ accountId: selection.accountId })
        : serviceNodeId({ id: selection.id }),
    );

    snapshot.edges.works_on.forEach((edge, index) => {
      const touches =
        selection.type === 'person' ? edge.from === selection.accountId : edge.to === selection.id;

      if (touches) {
        litNodeIds.add(personNodeId({ accountId: edge.from }));
        litNodeIds.add(serviceNodeId({ id: edge.to }));
        litEdgeIds.add(worksOnEdgeId({ index, from: edge.from, to: edge.to }));
      }
    });
  }

  const focused = selection !== null;
  const isDimmed = (id: string): boolean => focused && !litNodeIds.has(id);

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
      data: {
        employee,
        radius,
        active: selection?.type === 'person' && selection.accountId === employee.accountId,
        dim: isDimmed(id),
      },
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
      data: {
        kind: 'service',
        label: service.name,
        service,
        active: selection?.type === 'service' && selection.id === service.id,
        dim: isDimmed(id),
      },
    });
  }

  const edges: InstanceEdge[] = [];

  snapshot.edges.works_on.forEach((edge, index) => {
    const id = worksOnEdgeId({ index, from: edge.from, to: edge.to });

    edges.push({
      id,
      type: 'worksOn',
      source: personNodeId({ accountId: edge.from }),
      target: serviceNodeId({ id: edge.to }),
      data: { weight: edge.weight, variant: 'worksOn', dim: focused && !litEdgeIds.has(id) },
    });
  });

  return { nodes, edges };
};
