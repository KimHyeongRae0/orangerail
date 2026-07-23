import type { InstanceEdge as WireEdge, InstanceSnapshot } from '../snapshot/instances';
import { computeEgoSet, egoEdgeKey } from './ego';
import {
  edgeWidth,
  personNodeId,
  personRadius,
  serviceNodeId,
  teamNodeId,
  type InstanceEdge,
  type InstanceNode,
  type Relationship,
} from './instanceModel';

/** Fixed place-node box (services + team) — matches the ServiceNode CSS min-width. */
const PLACE_WIDTH = 160;
const PLACE_HEIGHT = 64;

/**
 * Drop edges whose weight is below the threshold (plan section 3.2d, AC-2).
 * Pure: an edge is kept iff `weight >= threshold`, so `weight === threshold` is
 * kept and `weight < threshold` is dropped (the unit-tested boundary). Raising
 * the threshold hides weak ties and lowers the rendered edge count.
 */
export const filterByWeight = ({
  edges,
  threshold,
}: {
  edges: WireEdge[];
  threshold: number;
}): WireEdge[] => edges.filter((edge) => edge.weight >= threshold);

/**
 * Build React Flow nodes and edges for the Network view from the instance
 * snapshot, the computed positions, the active `relationship`, the edge-weight
 * threshold, and the current person selection (plan section 3.2). People become
 * circular nodes sized by `storyPointsTotal` (capped); services and the team
 * become distinct place nodes. Only ONE relationship family is emitted at a time
 * (default `helps`), after the weight-threshold filter — switching the family or
 * raising the threshold changes the rendered edge count.
 *
 * When a person is selected (`activeAccountId`), focus mode engages: the ego set
 * for the active relationship (plus, in `helps` mode, the ego's `works_on`
 * services) stays undimmed and everything else is marked `dim: true`. In `helps`
 * focus the ego's `works_on` edges are additionally overlaid so the person's
 * service ownership is visible even though the collaboration family is active.
 *
 * The build is wholly instance-scoped: it emits only `person`/`service` node
 * types and `helps`/`worksOn`/`memberOf` edge types, never a db type (plan
 * Risks — no type-family leakage). Every string is passed to React as text
 * only; nothing is interpreted as markup (AC-5).
 */
export const buildInstanceGraph = ({
  snapshot,
  positions,
  relationship,
  weightThreshold,
  activeAccountId,
}: {
  snapshot: InstanceSnapshot;
  positions: Map<string, { x: number; y: number }>;
  relationship: Relationship;
  weightThreshold: number;
  activeAccountId: string | null;
}): { nodes: InstanceNode[]; edges: InstanceEdge[] } => {
  const ego =
    activeAccountId !== null
      ? computeEgoSet({ snapshot, accountId: activeAccountId, relationship })
      : null;

  // Focus is only "active" once the selected person actually resolves to a node
  // (an unknown account id yields an empty ego set and dims nothing).
  const focusActive =
    ego !== null &&
    activeAccountId !== null &&
    ego.nodeIds.has(personNodeId({ accountId: activeAccountId }));

  const isNodeDim = ({ id }: { id: string }): boolean => focusActive && !ego!.nodeIds.has(id);

  const isEdgeDim = ({ key }: { key: string }): boolean => focusActive && !ego!.edgeIds.has(key);

  const nodes: InstanceNode[] = [];

  for (const employee of snapshot.employees) {
    const id = personNodeId({ accountId: employee.accountId });
    const radius = personRadius({ storyPointsTotal: employee.storyPointsTotal });

    nodes.push({
      id,
      type: 'person',
      position: positions.get(id) ?? { x: 0, y: 0 },
      // Explicit dimensions so React Flow can position edge endpoints on the
      // first render, without waiting on an async ResizeObserver measurement
      // (a missing measurement dropped the edges on some loads).
      width: radius * 2,
      height: radius * 2,
      data: {
        employee,
        radius,
        active: employee.accountId === activeAccountId,
        dim: isNodeDim({ id }),
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
      data: { kind: 'service', label: service.name, service, dim: isNodeDim({ id }) },
    });
  }

  for (const team of snapshot.teams) {
    const id = teamNodeId({ id: team.id });

    nodes.push({
      id,
      type: 'service',
      position: positions.get(id) ?? { x: 0, y: 0 },
      width: PLACE_WIDTH,
      height: PLACE_HEIGHT,
      data: { kind: 'team', label: team.name, team, dim: isNodeDim({ id }) },
    });
  }

  const edges: InstanceEdge[] = [];

  const active = filterByWeight({
    edges: snapshot.edges[relationship],
    threshold: weightThreshold,
  });

  if (relationship === 'helps') {
    active.forEach((edge, index) => {
      const key = egoEdgeKey({ relationship: 'helps', from: edge.from, to: edge.to });

      edges.push({
        id: `helps:${index}:${edge.from}->${edge.to}`,
        type: 'helps',
        source: personNodeId({ accountId: edge.from }),
        target: personNodeId({ accountId: edge.to }),
        data: { weight: edge.weight, dim: isEdgeDim({ key }) },
      });
    });
  }

  if (relationship === 'works_on') {
    active.forEach((edge, index) => {
      const key = egoEdgeKey({ relationship: 'works_on', from: edge.from, to: edge.to });

      edges.push({
        id: `works_on:${index}:${edge.from}->${edge.to}`,
        type: 'worksOn',
        source: personNodeId({ accountId: edge.from }),
        target: serviceNodeId({ id: edge.to }),
        data: { weight: edge.weight, variant: 'worksOn', dim: isEdgeDim({ key }) },
      });
    });
  }

  if (relationship === 'member_of') {
    active.forEach((edge, index) => {
      const key = egoEdgeKey({ relationship: 'member_of', from: edge.from, to: edge.to });

      edges.push({
        id: `member_of:${index}:${edge.from}->${edge.to}`,
        type: 'memberOf',
        source: personNodeId({ accountId: edge.from }),
        target: teamNodeId({ id: edge.to }),
        data: { weight: edge.weight, variant: 'memberOf', dim: isEdgeDim({ key }) },
      });
    });
  }

  // Focus service-context overlay: in `helps` focus the ego's `works_on` edges
  // are emitted (undimmed) even though `helps` is the active family, so the
  // selected person's service ownership shows during focus (plan section 3.2e).
  if (focusActive && relationship === 'helps') {
    snapshot.edges.works_on.forEach((edge, index) => {
      if (edge.from !== activeAccountId) {
        return;
      }

      edges.push({
        id: `ego-works_on:${index}:${edge.from}->${edge.to}`,
        type: 'worksOn',
        source: personNodeId({ accountId: edge.from }),
        target: serviceNodeId({ id: edge.to }),
        data: { weight: edge.weight, variant: 'worksOn', dim: false },
      });
    });
  }

  return { nodes, edges };
};

export { edgeWidth };
