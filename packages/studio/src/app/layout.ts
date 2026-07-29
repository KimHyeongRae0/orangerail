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
 * Horizontal band reserved to the RIGHT of a card that is the target of one or
 * more actions. Targeted actions render as self-loop pills bulging right of
 * their target card (ActionEdge: `bulgeX = cardRight + 96`, pill centred at
 * `+106`, pill `max-width: 260` → half-width 130 → pill right edge ≈
 * `cardRight + 236`). ELK lays out only the card boxes and is blind to that
 * band, so a card in the next layer (reached by an outgoing link) gets placed
 * straight through the pills — the deleteOrder/updateOrder-over-Refund overlap.
 * Inflating ONLY the ELK width of an action-target card pushes the next layer
 * clear of the band; the card still renders at its true (content-driven) width,
 * leaving the reserved span as the empty channel the pills occupy. A target with
 * nothing to its right just gains harmless empty space.
 */
const SELF_LOOP_PILL_RESERVE = 260;

/**
 * Vertical stagger between two self-loop pills sharing a target, and the pill's
 * own height (ActionEdge: `offset_i = (i - (N-1)/2) * 78`; the Pill renders
 * ≈56px tall). The `src`/`loop` handles are `Position.Right`, i.e. anchored at
 * the card's vertical middle, so N pills stack symmetrically around that middle.
 */
const PILL_STAGGER = 78;
const PILL_HEIGHT = 56;

/**
 * Vertical span of a target's self-loop pill stack: `(N - 1) * 78 + 56`, centred
 * on the target card's middle. Two targeted actions (the CRUD-scan default) fit
 * beside all but the shortest cards, but from three actions up the stack grows
 * taller than the card it hangs off and spills into whatever ELK placed above or
 * below — a neighbour card, the next layer's card, or another card's pills.
 */
const pillStackHeight = ({ loopCount }: { loopCount: number }): number =>
  loopCount > 0 ? (loopCount - 1) * PILL_STAGGER + PILL_HEIGHT : 0;

/**
 * The layout box a card occupies once its pill stack is reserved: as tall as the
 * card, or as tall as the stack when the stack is taller. The card is then drawn
 * vertically CENTRED in that box (`cardOffsetY`), which puts the box's middle on
 * the card's middle — the exact point the stack is centred on. So the band a
 * target's pills sweep is always contained in its own reserved box, both
 * horizontally (SELF_LOOP_PILL_RESERVE) and vertically, and non-overlapping
 * boxes are enough to keep pills off every other card, layer, and pill.
 */
const reservedBox = ({
  cardH,
  loopCount,
}: {
  cardH: number;
  loopCount: number;
}): { height: number; cardOffsetY: number } => {
  const height = Math.max(cardH, pillStackHeight({ loopCount }));

  return { height, cardOffsetY: (height - cardH) / 2 };
};

/**
 * Compute node positions with elkjs layered layout using Liam's constants
 * (plan section 3.4). Objects that participate in at least one link are laid
 * out by ELK; objects with no links and target-less action pills are collected
 * into a single left-docked isolated column (Liam's non-related-table-group
 * pattern). Self-loop action edges do not participate in layering — their loop
 * geometry is computed in the edge component, so the pill band they sweep is
 * folded into the layout as a reserve on the owning card's box. Returns a
 * position per node id.
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

  // Cards that carry self-loop action pills on their right edge, and how many —
  // the count drives both the reserved band's width (SELF_LOOP_PILL_RESERVE, a
  // constant: the pills stack, they never widen) and its height (pillStackHeight,
  // which grows with every extra action).
  const loopCounts = new Map<string, number>();
  for (const action of snapshot.actions) {
    if (action.target) {
      loopCounts.set(action.target, (loopCounts.get(action.target) ?? 0) + 1);
    }
  }

  // Isolated cards dock in a fixed left column. One that is ALSO an action target
  // carries self-loop pills bulging RIGHT toward the ELK graph (same geometry as a
  // connected target), but the isolated branch reserved no channel — a standalone
  // model with update/delete (e.g. Session, AuditLog, FeatureFlag) had its pills
  // overrun the first ELK layer. Offset the column far enough left that the widest
  // isolated target's pill band (cardRight + PILL band ≈ +236, covered by the 260
  // reserve) stays clear of the graph's left edge (~0). Only ever move the column
  // further LEFT than its default, never right.
  const isolatedTargetWidths = isolated
    .filter((object) => (loopCounts.get(object.name) ?? 0) > 0)
    .map((object) => cardWidth({ object }));
  const isolatedColumnX =
    isolatedTargetWidths.length > 0
      ? Math.min(ISOLATED_COLUMN_X, -(Math.max(...isolatedTargetWidths) + SELF_LOOP_PILL_RESERVE))
      : ISOLATED_COLUMN_X;

  const positions = new Map<string, { x: number; y: number }>();

  if (connected.length > 0) {
    // ELK lays out the RESERVED boxes; each card is then re-centred inside its own
    // box so its pill stack stays within the space ELK kept clear for it.
    const cardOffsets = new Map<string, number>();
    const children = connected.map((object) => {
      const id = objectId({ name: object.name });
      const loopCount = loopCounts.get(object.name) ?? 0;
      const { height, cardOffsetY } = reservedBox({
        cardH: cardHeight({ object }),
        loopCount,
      });

      cardOffsets.set(id, cardOffsetY);

      return {
        id,
        width: cardWidth({ object }) + (loopCount > 0 ? SELF_LOOP_PILL_RESERVE : 0),
        height,
      };
    });

    const result = await elk.layout({
      id: 'root',
      layoutOptions: ELK_OPTIONS,
      children,
      edges: snapshot.links.map((link) => ({
        id: link.id,
        sources: [objectId({ name: link.from })],
        targets: [objectId({ name: link.to })],
      })),
    });

    for (const child of result.children ?? []) {
      positions.set(child.id, {
        x: child.x ?? 0,
        y: (child.y ?? 0) + (cardOffsets.get(child.id) ?? 0),
      });
    }
  }

  let y = 0;
  for (const object of isolated) {
    // The isolated column stacks cards by hand, so it reserves the pill stack the
    // same way ELK now does: advance by the reserved box, centre the card in it.
    const { height, cardOffsetY } = reservedBox({
      cardH: cardHeight({ object }),
      loopCount: loopCounts.get(object.name) ?? 0,
    });

    positions.set(objectId({ name: object.name }), { x: isolatedColumnX, y: y + cardOffsetY });
    y += height + ISOLATED_GAP;
  }
  for (const action of targetless) {
    positions.set(actionNodeId({ name: action.name }), { x: isolatedColumnX, y });
    y += ISOLATED_PILL_HEIGHT;
  }

  return positions;
};
