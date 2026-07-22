import ELK from 'elkjs/lib/elk.bundled.js';

import type { GraphSnapshot } from '../snapshot/types';
import { actionNodeId, cardHeight, cardWidth, objectId } from './graph';

const elk = new ELK();

/** Liam's extracted layered-layout tuning constants (plan section 3.4). */
export const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.baseValue': '40',
  'elk.spacing.componentComponent': '80',
  'elk.layered.spacing.edgeNodeBetweenLayers': '120',
  'elk.layered.considerModelOrder.strategy': 'PREFER_EDGES',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  'elk.layered.mergeEdges': 'true',
  'elk.layered.nodePlacement.strategy': 'INTERACTIVE',
  'elk.layered.layering.strategy': 'INTERACTIVE',
};

const ISOLATED_COLUMN_X = -360;
const ISOLATED_GAP = 40;
const ISOLATED_PILL_HEIGHT = 80;

/**
 * Compute node positions with elkjs layered layout using Liam's constants
 * (plan section 3.4). Objects that participate in at least one link are laid
 * out by ELK; objects with no links and target-less action pills are collected
 * into a single left-docked isolated column (Liam's non-related-table-group
 * pattern). Self-loop action edges do not participate in layering — their loop
 * geometry is computed in the edge component. Returns a position per node id.
 */
export const computeLayout = async ({
  snapshot,
}: {
  snapshot: GraphSnapshot;
}): Promise<Map<string, { x: number; y: number }>> => {
  const linked = new Set<string>();
  for (const link of snapshot.links) {
    linked.add(link.from);
    linked.add(link.to);
  }

  const connected = snapshot.objects.filter((o) => linked.has(o.name));
  const isolated = snapshot.objects.filter((o) => !linked.has(o.name));
  const targetless = snapshot.actions.filter((a) => !a.target);

  const positions = new Map<string, { x: number; y: number }>();

  if (connected.length > 0) {
    const result = await elk.layout({
      id: 'root',
      layoutOptions: ELK_OPTIONS,
      children: connected.map((object) => ({
        id: objectId({ name: object.name }),
        width: cardWidth({ object }),
        height: cardHeight({ object }),
      })),
      edges: snapshot.links.map((link) => ({
        id: link.id,
        sources: [objectId({ name: link.from })],
        targets: [objectId({ name: link.to })],
      })),
    });

    for (const child of result.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }
  }

  let y = 0;
  for (const object of isolated) {
    positions.set(objectId({ name: object.name }), { x: ISOLATED_COLUMN_X, y });
    y += cardHeight({ object }) + ISOLATED_GAP;
  }
  for (const action of targetless) {
    positions.set(actionNodeId({ name: action.name }), { x: ISOLATED_COLUMN_X, y });
    y += ISOLATED_PILL_HEIGHT;
  }

  return positions;
};
