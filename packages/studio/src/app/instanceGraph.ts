import type { InstanceSnapshot } from '../snapshot/instances';
import {
  edgeWidth,
  personNodeId,
  personRadius,
  serviceNodeId,
  teamNodeId,
  type InstanceEdge,
  type InstanceNode,
} from './instanceModel';

/** Fixed place-node box (services + team) — matches the ServiceNode CSS min-width. */
const PLACE_WIDTH = 160;
const PLACE_HEIGHT = 64;

/**
 * Build React Flow nodes and edges from the instance snapshot, the computed
 * positions, the `works_on` toggle, and the current person selection (plan
 * section 3.3). People become circular nodes sized by `storyPointsTotal`;
 * services and the team become distinct place nodes; `helps` become directed
 * weight-scaled edges (always on); `member_of` renders as a light structural
 * edge (always on); `works_on` renders only when `showWorksOn` is set — the
 * toolbar toggle adds/removes exactly that edge set, changing the edge count.
 *
 * The build is wholly instance-scoped: it emits only `person`/`service` node
 * types and `helps`/`worksOn`/`memberOf` edge types, never a db type (plan
 * Risks — no type-family leakage). Every string is passed to React as text
 * only; nothing is interpreted as markup (AC-6).
 */
export const buildInstanceGraph = ({
  snapshot,
  positions,
  showWorksOn,
  activeAccountId,
}: {
  snapshot: InstanceSnapshot;
  positions: Map<string, { x: number; y: number }>;
  showWorksOn: boolean;
  activeAccountId: string | null;
}): { nodes: InstanceNode[]; edges: InstanceEdge[] } => {
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
      data: { kind: 'service', label: service.name, service },
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
      data: { kind: 'team', label: team.name, team },
    });
  }

  const edges: InstanceEdge[] = [];

  snapshot.edges.helps.forEach((edge, index) => {
    edges.push({
      id: `helps:${index}:${edge.from}->${edge.to}`,
      type: 'helps',
      source: personNodeId({ accountId: edge.from }),
      target: personNodeId({ accountId: edge.to }),
      data: { weight: edge.weight },
    });
  });

  snapshot.edges.member_of.forEach((edge, index) => {
    edges.push({
      id: `member_of:${index}:${edge.from}->${edge.to}`,
      type: 'memberOf',
      source: personNodeId({ accountId: edge.from }),
      target: teamNodeId({ id: edge.to }),
      data: { weight: edge.weight, variant: 'memberOf' },
    });
  });

  if (showWorksOn) {
    snapshot.edges.works_on.forEach((edge, index) => {
      edges.push({
        id: `works_on:${index}:${edge.from}->${edge.to}`,
        type: 'worksOn',
        source: personNodeId({ accountId: edge.from }),
        target: serviceNodeId({ id: edge.to }),
        data: { weight: edge.weight, variant: 'worksOn' },
      });
    });
  }

  return { nodes, edges };
};

export { edgeWidth };
