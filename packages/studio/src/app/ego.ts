import type { InstanceSnapshot } from '../snapshot/instances';
import { personNodeId, serviceNodeId, teamNodeId, type Relationship } from './instanceModel';

/** The undimmed set for a focus: React Flow node ids + canonical edge keys. */
export interface EgoSet {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

/**
 * The canonical, direction-sensitive key an ego edge is recorded under (plan
 * section 3.2e). Prefixed with the relationship family so a `helps` a->b key can
 * never collide with a `works_on` a->b key. `buildInstanceGraph` reconstructs
 * the same key per emitted edge to decide whether it is dimmed.
 */
export const egoEdgeKey = ({
  relationship,
  from,
  to,
}: {
  relationship: Relationship;
  from: string;
  to: string;
}): string => `${relationship}:${from}->${to}`;

/**
 * Compute the ego (focus) set for a selected person (plan section 3.2e, AC-2).
 * The set is scoped to the currently-active `relationship`, with `helps` the one
 * special case that additionally overlays the ego's `works_on` services so a
 * people-to-people view still has an on-screen service anchor:
 * - `helps` → the ego, its in/out `helps` neighbours, and its `works_on` services;
 * - `works_on` → the ego and its `works_on` services;
 * - `member_of` → the ego and its team(s).
 * A person with no edges resolves to just itself; an unknown `accountId`
 * resolves to the empty set (the caller reads this as "no focus"). Pure and
 * deterministic — no timestamps, no RNG.
 */
export const computeEgoSet = ({
  snapshot,
  accountId,
  relationship,
}: {
  snapshot: InstanceSnapshot;
  accountId: string;
  relationship: Relationship;
}): EgoSet => {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  const exists = snapshot.employees.some((employee) => employee.accountId === accountId);

  if (!exists) {
    return { nodeIds, edgeIds };
  }

  nodeIds.add(personNodeId({ accountId }));

  const addHelps = () => {
    for (const edge of snapshot.edges.helps) {
      if (edge.from === accountId) {
        nodeIds.add(personNodeId({ accountId: edge.to }));
        edgeIds.add(egoEdgeKey({ relationship: 'helps', from: edge.from, to: edge.to }));
      }

      if (edge.to === accountId) {
        nodeIds.add(personNodeId({ accountId: edge.from }));
        edgeIds.add(egoEdgeKey({ relationship: 'helps', from: edge.from, to: edge.to }));
      }
    }
  };

  const addWorksOn = () => {
    for (const edge of snapshot.edges.works_on) {
      if (edge.from === accountId) {
        nodeIds.add(serviceNodeId({ id: edge.to }));
        edgeIds.add(egoEdgeKey({ relationship: 'works_on', from: edge.from, to: edge.to }));
      }
    }
  };

  const addMemberOf = () => {
    for (const edge of snapshot.edges.member_of) {
      if (edge.from === accountId) {
        nodeIds.add(teamNodeId({ id: edge.to }));
        edgeIds.add(egoEdgeKey({ relationship: 'member_of', from: edge.from, to: edge.to }));
      }
    }
  };

  if (relationship === 'helps') {
    addHelps();
    addWorksOn();
  } else if (relationship === 'works_on') {
    addWorksOn();
  } else {
    addMemberOf();
  }

  return { nodeIds, edgeIds };
};
