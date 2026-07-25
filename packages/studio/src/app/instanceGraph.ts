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
  activeServiceId = null,
}: {
  snapshot: InstanceSnapshot;
  positions: Map<string, { x: number; y: number }>;
  relationship: Relationship;
  weightThreshold: number;
  activeAccountId: string | null;
  /**
   * The focused service (click or hover) in the Network view. A person focus
   * always wins over a service focus; when only a service is focused, its
   * `works_on` people light up and the rest dims — the Network-view mirror of
   * the Ownership view's service selection.
   */
  activeServiceId?: string | null;
}): { nodes: InstanceNode[]; edges: InstanceEdge[] } => {
  const personFocus =
    activeAccountId !== null &&
    snapshot.employees.some((employee) => employee.accountId === activeAccountId);

  const ego = personFocus
    ? computeEgoSet({ snapshot, accountId: activeAccountId as string, relationship })
    : null;

  // A service focus only engages when there is no person focus and the id
  // resolves to a real service.
  const serviceFocus =
    !personFocus &&
    activeServiceId !== null &&
    snapshot.services.some((service) => service.id === activeServiceId);

  // The service ego: the service node plus every person who works on it, and the
  // `works_on` edge keys that connect them (overlaid even outside `works_on`).
  const serviceEgoNodeIds = new Set<string>();
  const serviceEgoEdgeKeys = new Set<string>();

  if (serviceFocus) {
    serviceEgoNodeIds.add(serviceNodeId({ id: activeServiceId as string }));

    for (const edge of snapshot.edges.works_on) {
      if (edge.to === activeServiceId) {
        serviceEgoNodeIds.add(personNodeId({ accountId: edge.from }));
        serviceEgoEdgeKeys.add(
          egoEdgeKey({ relationship: 'works_on', from: edge.from, to: edge.to }),
        );
      }
    }
  }

  // Focus is only "active" once the selection resolves to a node (an unknown
  // account/service id dims nothing).
  const focusActive =
    (personFocus && ego!.nodeIds.has(personNodeId({ accountId: activeAccountId as string }))) ||
    serviceFocus;

  const focusNodeIds = personFocus ? ego!.nodeIds : serviceEgoNodeIds;
  const focusEdgeKeys = personFocus ? ego!.edgeIds : serviceEgoEdgeKeys;

  const isNodeDim = ({ id }: { id: string }): boolean => focusActive && !focusNodeIds.has(id);
  const isNodeFocused = ({ id }: { id: string }): boolean => focusActive && focusNodeIds.has(id);
  const isEdgeDim = ({ key }: { key: string }): boolean => focusActive && !focusEdgeKeys.has(key);
  const isEdgeFocused = ({ key }: { key: string }): boolean =>
    focusActive && focusEdgeKeys.has(key);

  const active = filterByWeight({
    edges: snapshot.edges[relationship],
    threshold: weightThreshold,
  });

  // Per-person connectivity in the active relationship — a `helps` edge counts
  // both endpoints, a `works_on`/`member_of` edge counts its person source.
  const degreeByAccount = new Map<string, number>();
  const bumpDegree = ({ accountId }: { accountId: string }) =>
    degreeByAccount.set(accountId, (degreeByAccount.get(accountId) ?? 0) + 1);

  for (const edge of active) {
    bumpDegree({ accountId: edge.from });

    if (relationship === 'helps') {
      bumpDegree({ accountId: edge.to });
    }
  }

  // Place ids that carry an edge in the active relationship — a place outside
  // this set is structural context (muted) unless the focus pulls it in.
  const connectedPlaceIds = new Set<string>();

  if (relationship === 'works_on') {
    for (const edge of active) {
      connectedPlaceIds.add(serviceNodeId({ id: edge.to }));
    }
  }

  if (relationship === 'member_of') {
    for (const edge of active) {
      connectedPlaceIds.add(teamNodeId({ id: edge.to }));
    }
  }

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
        active: personFocus && employee.accountId === activeAccountId,
        degree: degreeByAccount.get(employee.accountId) ?? 0,
        dim: isNodeDim({ id }),
      },
    });
  }

  for (const service of snapshot.services) {
    const id = serviceNodeId({ id: service.id });
    const muted = !connectedPlaceIds.has(id) && !isNodeFocused({ id });

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
        active: serviceFocus && service.id === activeServiceId,
        muted,
        dim: isNodeDim({ id }),
      },
    });
  }

  for (const team of snapshot.teams) {
    const id = teamNodeId({ id: team.id });
    const muted = !connectedPlaceIds.has(id) && !isNodeFocused({ id });

    nodes.push({
      id,
      type: 'service',
      position: positions.get(id) ?? { x: 0, y: 0 },
      width: PLACE_WIDTH,
      height: PLACE_HEIGHT,
      data: { kind: 'team', label: team.name, team, muted, dim: isNodeDim({ id }) },
    });
  }

  const edges: InstanceEdge[] = [];

  if (relationship === 'helps') {
    active.forEach((edge, index) => {
      const key = egoEdgeKey({ relationship: 'helps', from: edge.from, to: edge.to });

      edges.push({
        id: `helps:${index}:${edge.from}->${edge.to}`,
        type: 'helps',
        source: personNodeId({ accountId: edge.from }),
        target: personNodeId({ accountId: edge.to }),
        data: { weight: edge.weight, dim: isEdgeDim({ key }), focused: isEdgeFocused({ key }) },
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
        data: {
          weight: edge.weight,
          variant: 'worksOn',
          dim: isEdgeDim({ key }),
          focused: isEdgeFocused({ key }),
        },
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
        data: {
          weight: edge.weight,
          variant: 'memberOf',
          dim: isEdgeDim({ key }),
          focused: isEdgeFocused({ key }),
        },
      });
    });
  }

  // Person `helps` focus overlays the ego's own `works_on` edges (focused) so
  // the selected person's service ownership shows even while `helps` is active.
  if (focusActive && personFocus && relationship === 'helps') {
    snapshot.edges.works_on.forEach((edge, index) => {
      if (edge.from !== activeAccountId) {
        return;
      }

      edges.push({
        id: `ego-works_on:${index}:${edge.from}->${edge.to}`,
        type: 'worksOn',
        source: personNodeId({ accountId: edge.from }),
        target: serviceNodeId({ id: edge.to }),
        data: { weight: edge.weight, variant: 'worksOn', dim: false, focused: true },
      });
    });
  }

  // Service focus overlays that service's `works_on` edges (focused) when the
  // active relationship isn't already drawing them, so hovering a service in the
  // `helps`/`member_of` view still lights the people who own it.
  if (serviceFocus && relationship !== 'works_on') {
    snapshot.edges.works_on.forEach((edge, index) => {
      if (edge.to !== activeServiceId) {
        return;
      }

      edges.push({
        id: `svc-works_on:${index}:${edge.from}->${edge.to}`,
        type: 'worksOn',
        source: personNodeId({ accountId: edge.from }),
        target: serviceNodeId({ id: edge.to }),
        data: { weight: edge.weight, variant: 'worksOn', dim: false, focused: true },
      });
    });
  }

  return { nodes, edges };
};

export { edgeWidth };
