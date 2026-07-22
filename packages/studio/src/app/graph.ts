import type { GraphSnapshot, SnapshotObject } from '../snapshot/types';
import type { HighlightResult } from './highlight';
import type { ShowMode, StudioEdge, StudioNode } from './model';

/** React Flow node id for an object card. */
export const objectId = ({ name }: { name: string }): string => `obj:${name}`;

/** React Flow node id for a target-less action pill. */
export const actionNodeId = ({ name }: { name: string }): string => `act:${name}`;

/** React Flow edge id for a targeted action's self-loop. */
export const actionEdgeId = ({ name }: { name: string }): string => `actedge:${name}`;

const HEADER_HEIGHT = 40;
const ROW_HEIGHT = 33;

/** Approximate card width for layout (content-driven at render time). */
export const cardWidth = ({ object }: { object: SnapshotObject }): number => {
  const longest = Math.max(object.name.length, ...object.fields.map((f) => f.name.length + 8), 12);
  return Math.min(320, Math.max(180, longest * 8));
};

/** Card height for layout, sized for All Fields so spacing never overlaps. */
export const cardHeight = ({ object }: { object: SnapshotObject }): number =>
  HEADER_HEIGHT + object.fields.length * ROW_HEIGHT + 2;

/**
 * Build React Flow nodes and edges from the snapshot, the computed positions,
 * the current show mode, and the highlight result (plan section 3.4 / 3.5).
 * Objects become card nodes; target-less actions become free-standing pill
 * nodes; links become bezier edges; targeted actions become self-loop edges on
 * their target (staggered when several share a target).
 */
export const buildGraph = ({
  snapshot,
  positions,
  showMode,
  highlights,
}: {
  snapshot: GraphSnapshot;
  positions: Map<string, { x: number; y: number }>;
  showMode: ShowMode;
  highlights: HighlightResult;
}): { nodes: StudioNode[]; edges: StudioEdge[] } => {
  const nodes: StudioNode[] = [];

  for (const object of snapshot.objects) {
    const id = objectId({ name: object.name });
    const state = highlights.objects[object.name] ?? {
      active: false,
      highlighted: false,
      dim: false,
    };

    nodes.push({
      id,
      type: 'object',
      position: positions.get(id) ?? { x: 0, y: 0 },
      data: { object, showMode, ...state },
    });
  }

  for (const action of snapshot.actions) {
    if (action.target) {
      continue;
    }

    const id = actionNodeId({ name: action.name });
    const state = highlights.actions[action.name] ?? {
      active: false,
      highlighted: false,
      dim: false,
    };

    nodes.push({
      id,
      type: 'action',
      position: positions.get(id) ?? { x: 0, y: 0 },
      data: { action, ...state },
    });
  }

  const edges: StudioEdge[] = [];

  for (const link of snapshot.links) {
    const highlighted = highlights.links[link.id]?.highlighted ?? false;

    // No per-highlight zIndex: React Flow v12 groups edges into a separate
    // <svg> wrapper per zIndex, so flipping zIndex on hover REMOUNTS the edge
    // (resetting its SMIL particle clock and perturbing the hover target). Edge
    // group membership must stay constant; highlight is attribute-only.
    edges.push({
      id: link.id,
      type: 'link',
      source: objectId({ name: link.from }),
      target: objectId({ name: link.to }),
      sourceHandle: 'src',
      targetHandle: 'tgt',
      data: { link, highlighted },
    });
  }

  const targeted = snapshot.actions.filter((a) => a.target);
  const perTarget = new Map<string, number>();
  for (const action of targeted) {
    perTarget.set(action.target ?? '', (perTarget.get(action.target ?? '') ?? 0) + 1);
  }
  const seen = new Map<string, number>();

  for (const action of targeted) {
    const targetName = action.target ?? '';
    const loopIndex = seen.get(targetName) ?? 0;
    seen.set(targetName, loopIndex + 1);
    const state = highlights.actions[action.name] ?? {
      active: false,
      highlighted: false,
      dim: false,
    };

    // No per-highlight zIndex here either — same reason as link edges above:
    // a zIndex flip on hover remounts the self-loop edge (and resets its SMIL
    // particle clock). Constant group membership keeps highlight attribute-only.
    edges.push({
      id: actionEdgeId({ name: action.name }),
      type: 'action',
      source: objectId({ name: targetName }),
      target: objectId({ name: targetName }),
      sourceHandle: 'src',
      targetHandle: 'loop',
      data: { action, ...state, loopIndex, loopCount: perTarget.get(targetName) ?? 1 },
    });
  }

  return { nodes, edges };
};
