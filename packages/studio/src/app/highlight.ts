import type { GraphSnapshot } from '../snapshot/types';

/** A selection/hover focus: an object card or an action pill. */
export type Focus = { type: 'object' | 'action'; name: string } | null;

interface NodeState {
  active: boolean;
  highlighted: boolean;
  dim: boolean;
}

export interface HighlightResult {
  objects: Record<string, NodeState>;
  actions: Record<string, NodeState>;
  links: Record<string, { highlighted: boolean }>;
}

/**
 * The one pure highlight pass (plan section 3.5 — Liam's semantics). Builds an
 * adjacency view of the graph once (a link relates its two objects; an action
 * relates to its target object), then classifies every object, action and link
 * in a single pass from the effective focus (an active selection, else a
 * hover). Focus is additive: nothing is removed, non-focused nodes are dimmed
 * only. Clicking an object highlights its linked neighbours and the actions
 * that touch it; clicking an action highlights the object it targets; a null
 * focus restores the neutral state everywhere.
 */
export const computeHighlights = ({
  snapshot,
  active,
  hover,
}: {
  snapshot: GraphSnapshot;
  active: Focus;
  hover: Focus;
}): HighlightResult => {
  const focus = active ?? hover;

  const relatedObjects = new Set<string>();
  const highlightedActions = new Set<string>();
  const highlightedLinks = new Set<string>();

  if (focus?.type === 'object') {
    for (const link of snapshot.links) {
      if (link.from === focus.name) {
        relatedObjects.add(link.to);
        highlightedLinks.add(link.id);
      }
      if (link.to === focus.name) {
        relatedObjects.add(link.from);
        highlightedLinks.add(link.id);
      }
    }

    for (const action of snapshot.actions) {
      if (action.target === focus.name) {
        highlightedActions.add(action.name);
      }
    }
  }

  if (focus?.type === 'action') {
    const action = snapshot.actions.find((a) => a.name === focus.name);
    if (action?.target) {
      relatedObjects.add(action.target);
    }
  }

  const objects: Record<string, NodeState> = {};
  for (const object of snapshot.objects) {
    const isActive = focus?.type === 'object' && focus.name === object.name;
    const isHighlighted = relatedObjects.has(object.name);
    objects[object.name] = {
      active: isActive,
      highlighted: !isActive && isHighlighted,
      dim: focus !== null && !isActive && !isHighlighted,
    };
  }

  const actions: Record<string, NodeState> = {};
  for (const action of snapshot.actions) {
    const isActive = focus?.type === 'action' && focus.name === action.name;
    const isHighlighted = highlightedActions.has(action.name);
    actions[action.name] = {
      active: isActive,
      highlighted: !isActive && isHighlighted,
      dim: focus !== null && !isActive && !isHighlighted,
    };
  }

  const links: Record<string, { highlighted: boolean }> = {};
  for (const link of snapshot.links) {
    links[link.id] = { highlighted: highlightedLinks.has(link.id) };
  }

  return { objects, actions, links };
};
