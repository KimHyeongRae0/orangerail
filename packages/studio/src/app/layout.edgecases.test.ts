import { describe, expect, it } from 'vitest';

import type {
  GraphSnapshot,
  SnapshotAction,
  SnapshotField,
  SnapshotObject,
} from '../snapshot/types';
import { actionNodeId, cardHeight, cardWidth, objectId } from './graph';
import { computeLayout } from './layout';

/**
 * Adversarial layout QA harness. Confirms geometric invariants against many
 * edge-case snapshots to surface rendering overlaps of the same class as the
 * targeted-action self-loop-pill-over-next-card bug that was just fixed.
 *
 * Pill-band geometry (from ActionEdge.tsx + Pill.module.css, worst case):
 *   handles `src`/`loop` are Position.Right → anchored at card RIGHT edge,
 *   vertical CENTER of the card. So for a target card at (x, y):
 *     cardRight = x + cardWidth   (TRUE content width, NOT the ELK-inflated one)
 *     centreY   = y + cardHeight / 2
 *   bulgeX = cardRight + 96 ; labelX = cardRight + 106 ; pill max-width 260,
 *   translate(-50%) → pill right ≈ cardRight + 236, left ≈ cardRight - 24.
 *   N self-loops stagger vertically: offset_i = (i - (N-1)/2) * 78, so the
 *   stack spans centreY ± ((N-1)/2 * 78 + 28)  (pill height ≈ 56 → ±28).
 */

const PILL_LEFT_FROM_RIGHT = -24;
const PILL_RIGHT_FROM_RIGHT = 236;
const PILL_STAGGER = 78;
const PILL_HALF_HEIGHT = 28;
const CARD_MARGIN = 2; // tolerance for INV-1 card/card overlap

const obj = ({ name, fields = [] }: { name: string; fields?: string[] }): SnapshotObject => ({
  name,
  fields: fields.map((f): SnapshotField => ({
    name: f,
    type: 'string',
    optional: false,
    inLink: false,
  })),
  readAccess: 'authenticated',
  hasResolve: false,
});

const act = ({ name, target }: { name: string; target?: string }): SnapshotAction => ({
  name,
  ...(target === undefined ? {} : { target }),
  approval: 'required',
  roles: [],
  where: 'none',
  notImplemented: false,
});

interface Box {
  name: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PillBand {
  target: string;
  loopCount: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  cardHeight: number;
  stackHeight: number;
}

interface Violation {
  snapshot: string;
  inv: 'INV-1' | 'INV-2' | 'INV-3';
  detail: string;
  /** For INV-2: the target's self-loop count, used to separate the scan-reachable
   * contract (≤2 targeted actions/object) from the tall-stack
   * backlog item (≥3 custom actions on one object, vertical pill-stack reserve). */
  loopCount?: number;
}

const overlaps1D = (aLo: number, aHi: number, bLo: number, bHi: number, margin: number) =>
  aLo < bHi - margin && bLo < aHi - margin;

const analyze = ({
  name,
  snapshot,
  positions,
}: {
  name: string;
  snapshot: GraphSnapshot;
  positions: Map<string, { x: number; y: number }>;
}): { violations: Violation[]; tallStacks: string[] } => {
  const violations: Violation[] = [];
  const tallStacks: string[] = [];

  const byName = new Map(snapshot.objects.map((o) => [o.name, o]));

  // INV-3: every object + every target-less pill has a position.
  for (const o of snapshot.objects) {
    if (!positions.has(objectId({ name: o.name }))) {
      violations.push({
        snapshot: name,
        inv: 'INV-3',
        detail: `object "${o.name}" has no position`,
      });
    }
  }
  for (const a of snapshot.actions) {
    if (!a.target && !positions.has(actionNodeId({ name: a.name }))) {
      violations.push({
        snapshot: name,
        inv: 'INV-3',
        detail: `target-less pill "${a.name}" has no position`,
      });
    }
  }

  const boxes: Box[] = [];
  for (const o of snapshot.objects) {
    const p = positions.get(objectId({ name: o.name }));
    if (!p) continue;
    const w = cardWidth({ object: o });
    const h = cardHeight({ object: o });
    boxes.push({ name: o.name, left: p.x, right: p.x + w, top: p.y, bottom: p.y + h });
  }

  // INV-1: no two object card boxes overlap.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a || !b) continue;
      if (
        overlaps1D(a.left, a.right, b.left, b.right, CARD_MARGIN) &&
        overlaps1D(a.top, a.bottom, b.top, b.bottom, CARD_MARGIN)
      ) {
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        violations.push({
          snapshot: name,
          inv: 'INV-1',
          detail: `cards "${a.name}" [${a.left.toFixed(0)},${a.right.toFixed(0)}]x[${a.top.toFixed(0)},${a.bottom.toFixed(0)}] & "${b.name}" [${b.left.toFixed(0)},${b.right.toFixed(0)}]x[${b.top.toFixed(0)},${b.bottom.toFixed(0)}] overlap ${ox.toFixed(0)}x${oy.toFixed(0)}px`,
        });
      }
    }
  }

  // Build pill bands per action target.
  const perTarget = new Map<string, number>();
  for (const a of snapshot.actions) {
    if (a.target) perTarget.set(a.target, (perTarget.get(a.target) ?? 0) + 1);
  }
  const bands: PillBand[] = [];
  for (const [target, loopCount] of perTarget) {
    const o = byName.get(target);
    const p = positions.get(objectId({ name: target }));
    if (!o || !p) continue;
    const cw = cardWidth({ object: o });
    const ch = cardHeight({ object: o });
    const cardRight = p.x + cw;
    const centreY = p.y + ch / 2;
    const half = ((loopCount - 1) / 2) * PILL_STAGGER + PILL_HALF_HEIGHT;
    bands.push({
      target,
      loopCount,
      left: cardRight + PILL_LEFT_FROM_RIGHT,
      right: cardRight + PILL_RIGHT_FROM_RIGHT,
      top: centreY - half,
      bottom: centreY + half,
      cardHeight: ch,
      stackHeight: half * 2,
    });
  }

  // INV-2: a target's pill band must not intersect any OTHER object card box.
  for (const band of bands) {
    for (const b of boxes) {
      if (b.name === band.target) continue; // pill legitimately overlaps its own card
      if (
        overlaps1D(band.left, band.right, b.left, b.right, CARD_MARGIN) &&
        overlaps1D(band.top, band.bottom, b.top, b.bottom, CARD_MARGIN)
      ) {
        const ox = Math.min(band.right, b.right) - Math.max(band.left, b.left);
        const oy = Math.min(band.bottom, b.bottom) - Math.max(band.top, b.top);
        violations.push({
          snapshot: name,
          inv: 'INV-2',
          loopCount: band.loopCount,
          detail: `pill band of "${band.target}" (N=${band.loopCount}) [${band.left.toFixed(0)},${band.right.toFixed(0)}]x[${band.top.toFixed(0)},${band.bottom.toFixed(0)}] overlaps card "${b.name}" [${b.left.toFixed(0)},${b.right.toFixed(0)}]x[${b.top.toFixed(0)},${b.bottom.toFixed(0)}] by ${ox.toFixed(0)}x${oy.toFixed(0)}px`,
        });
      }
    }
    // INV-4 (report only): tall stack spilling past card height.
    if (band.stackHeight > band.cardHeight * 2 && band.loopCount >= 3) {
      tallStacks.push(
        `"${band.target}" N=${band.loopCount}: pill stack ${band.stackHeight.toFixed(0)}px vs card ${band.cardHeight.toFixed(0)}px (spill ${(band.stackHeight - band.cardHeight).toFixed(0)}px)`,
      );
    }
  }

  return { violations, tallStacks };
};

// ---- Adversarial snapshots ------------------------------------------------

const longName = 'ThisIsAnExtremelyLongObjectNameThatForcesMaxCardWidth';
const longField = 'anExtremelyLongFieldNameThatAlsoPushesTheCardToItsMaxWidth';

const CASES: { name: string; snapshot: GraphSnapshot }[] = [
  // (a) long chain, every object has update+delete actions
  {
    name: 'a:chain-A-B-C-D each with update+delete',
    snapshot: {
      objects: ['A', 'B', 'C', 'D'].map((n) => obj({ name: n, fields: ['id', 'val'] })),
      links: [
        { id: 'ab', from: 'A', to: 'B', cardinality: 'many' },
        { id: 'bc', from: 'B', to: 'C', cardinality: 'many' },
        { id: 'cd', from: 'C', to: 'D', cardinality: 'many' },
      ],
      actions: ['A', 'B', 'C', 'D'].flatMap((n) => [
        act({ name: `update${n}`, target: n }),
        act({ name: `delete${n}`, target: n }),
      ]),
    },
  },
  // (b) MANY targeted actions on one target (linked hub)
  {
    name: 'b:6 self-loops on hub (linked)',
    snapshot: {
      objects: [obj({ name: 'hub', fields: ['id'] }), obj({ name: 'leaf', fields: ['id'] })],
      links: [{ id: 'hl', from: 'hub', to: 'leaf', cardinality: 'many' }],
      actions: Array.from({ length: 6 }, (_, i) => act({ name: `a${i}`, target: 'hub' })),
    },
  },
  // (b') 8 self-loops on one target with a sibling directly below it
  {
    name: "b':8 self-loops on top target, sibling below in same component",
    snapshot: {
      objects: [
        obj({ name: 'top', fields: ['id'] }),
        obj({ name: 'bottom', fields: ['id'] }),
        obj({ name: 'sink', fields: ['id'] }),
      ],
      links: [
        { id: 't_sink', from: 'top', to: 'sink', cardinality: 'many' },
        { id: 'b_sink', from: 'bottom', to: 'sink', cardinality: 'many' },
      ],
      actions: Array.from({ length: 8 }, (_, i) => act({ name: `x${i}`, target: 'top' })),
    },
  },
  // (c) self-referential link (from === to) with actions
  {
    name: 'c:self-referential link from===to + actions',
    snapshot: {
      objects: [
        obj({ name: 'node', fields: ['id', 'parent'] }),
        obj({ name: 'other', fields: ['id'] }),
      ],
      links: [
        { id: 'self', from: 'node', to: 'node', cardinality: 'one' },
        { id: 'no', from: 'node', to: 'other', cardinality: 'many' },
      ],
      actions: [act({ name: 'promote', target: 'node' }), act({ name: 'archive', target: 'node' })],
    },
  },
  // (d) 2-cycle A->B->A with actions on both
  {
    name: 'd:cycle A<->B with actions on both',
    snapshot: {
      objects: [obj({ name: 'A', fields: ['id'] }), obj({ name: 'B', fields: ['id'] })],
      links: [
        { id: 'ab', from: 'A', to: 'B', cardinality: 'many' },
        { id: 'ba', from: 'B', to: 'A', cardinality: 'many' },
      ],
      actions: [
        act({ name: 'updateA', target: 'A' }),
        act({ name: 'updateB', target: 'B' }),
        act({ name: 'deleteB', target: 'B' }),
      ],
    },
  },
  // (e) many-to-one fan-in to a hub that has actions
  {
    name: 'e:5->1 fan-in hub with 3 actions',
    snapshot: {
      objects: [
        ...['s1', 's2', 's3', 's4', 's5'].map((n) => obj({ name: n, fields: ['id'] })),
        obj({ name: 'hub', fields: ['id', 'total'] }),
      ],
      links: ['s1', 's2', 's3', 's4', 's5'].map((n) => ({
        id: `${n}_hub`,
        from: n,
        to: 'hub',
        cardinality: 'many' as const,
      })),
      actions: [
        act({ name: 'settle', target: 'hub' }),
        act({ name: 'void', target: 'hub' }),
        act({ name: 'refund', target: 'hub' }),
      ],
    },
  },
  // (f) very long names → max width 320, with actions and a downstream card
  {
    name: 'f:max-width card (long name+field) with actions -> downstream',
    snapshot: {
      objects: [
        obj({ name: longName, fields: [longField, 'id'] }),
        obj({ name: 'downstream', fields: ['id'] }),
      ],
      links: [{ id: 'ld', from: longName, to: 'downstream', cardinality: 'many' }],
      actions: [
        act({ name: 'mutate', target: longName }),
        act({ name: 'destroy', target: longName }),
      ],
    },
  },
  // (g) 20-object graph, a spine chain + branches, several action targets
  {
    name: 'g:20-object graph with scattered action targets',
    snapshot: (() => {
      const names = Array.from({ length: 20 }, (_, i) => `o${i}`);
      return {
        objects: names.map((n) => obj({ name: n, fields: ['id', 'x'] })),
        links: [
          ...names.slice(0, 9).map((n, i) => ({
            id: `spine${i}`,
            from: n,
            to: names[i + 1] as string,
            cardinality: 'many' as const,
          })),
          ...names.slice(10).map((n, i) => ({
            id: `branch${i}`,
            from: names[i % 10] as string,
            to: n,
            cardinality: 'one' as const,
          })),
        ],
        actions: ['o1', 'o3', 'o5', 'o12'].flatMap((n) => [
          act({ name: `u_${n}`, target: n }),
          act({ name: `d_${n}`, target: n }),
        ]),
      };
    })(),
  },
  // (h) ISOLATED object that is an action target (no links) alongside a linked graph
  {
    name: 'h:isolated action-target beside a linked graph',
    snapshot: {
      objects: [
        obj({ name: longName, fields: ['id'] }), // isolated, action target, max width
        obj({ name: 'linkedA', fields: ['id', 'a', 'b'] }),
        obj({ name: 'linkedB', fields: ['id'] }),
      ],
      links: [{ id: 'lab', from: 'linkedA', to: 'linkedB', cardinality: 'many' }],
      actions: [
        act({ name: 'revoke', target: longName }),
        act({ name: 'rotate', target: longName }),
      ],
    },
  },
  // (h') isolated action-target, short name, with several loops
  {
    name: "h':isolated action-target 4 loops beside linked graph",
    snapshot: {
      objects: [
        obj({ name: 'session', fields: ['id', 'token', 'user'] }),
        obj({ name: 'accountX', fields: ['id'] }),
        obj({ name: 'profileX', fields: ['id'] }),
      ],
      links: [{ id: 'ap', from: 'accountX', to: 'profileX', cardinality: 'one' }],
      actions: Array.from({ length: 4 }, (_, i) => act({ name: `sess${i}`, target: 'session' })),
    },
  },
  // (i) 0-field object adjacent to a 16-field object, both action targets, linked
  {
    name: 'i:0-field & 16-field adjacent action targets',
    snapshot: {
      objects: [
        obj({ name: 'empty', fields: [] }),
        obj({ name: 'fat', fields: Array.from({ length: 16 }, (_, i) => `f${i}`) }),
      ],
      links: [{ id: 'ef', from: 'empty', to: 'fat', cardinality: 'many' }],
      actions: [
        act({ name: 'ping', target: 'empty' }),
        act({ name: 'bloat', target: 'fat' }),
        act({ name: 'trim', target: 'fat' }),
      ],
    },
  },
  // (j) two objects in the same ELK layer, both action targets, tall stacks
  {
    name: 'j:two same-layer action targets, tall stacks',
    snapshot: {
      objects: [
        obj({ name: 'srcA', fields: ['id'] }),
        obj({ name: 'srcB', fields: ['id'] }),
        obj({ name: 'sink', fields: ['id'] }),
      ],
      links: [
        { id: 'a_sink', from: 'srcA', to: 'sink', cardinality: 'many' },
        { id: 'b_sink', from: 'srcB', to: 'sink', cardinality: 'many' },
      ],
      actions: [
        ...Array.from({ length: 5 }, (_, i) => act({ name: `pa${i}`, target: 'srcA' })),
        ...Array.from({ length: 5 }, (_, i) => act({ name: `pb${i}`, target: 'srcB' })),
      ],
    },
  },
  // (k) target-less pills + isolated objects + a linked graph (docking column)
  {
    name: 'k:target-less pills + isolated + linked',
    snapshot: {
      objects: [
        obj({ name: 'orphan1', fields: ['id'] }),
        obj({ name: 'orphan2', fields: ['id'] }),
        obj({ name: 'linkedA', fields: ['id'] }),
        obj({ name: 'linkedB', fields: ['id'] }),
      ],
      links: [{ id: 'lab', from: 'linkedA', to: 'linkedB', cardinality: 'many' }],
      actions: [act({ name: 'globalSync' }), act({ name: 'reindex' })],
    },
  },
  // (l) hub targeted AND fanning out to many downstream cards (does reserve clear ALL?)
  {
    name: 'l:targeted hub fanning out to 5 downstream cards',
    snapshot: {
      objects: [
        obj({ name: 'hub', fields: ['id'] }),
        ...['d1', 'd2', 'd3', 'd4', 'd5'].map((n) => obj({ name: n, fields: ['id', 'y'] })),
      ],
      links: ['d1', 'd2', 'd3', 'd4', 'd5'].map((n) => ({
        id: `hub_${n}`,
        from: 'hub',
        to: n,
        cardinality: 'many' as const,
      })),
      actions: Array.from({ length: 5 }, (_, i) => act({ name: `h${i}`, target: 'hub' })),
    },
  },
  // (m) chain where a MIDDLE node has many loops (stack collides up/down neighbours?)
  {
    name: 'm:chain with heavy-loop middle node',
    snapshot: {
      objects: ['A', 'B', 'C'].map((n) => obj({ name: n, fields: ['id'] })),
      links: [
        { id: 'ab', from: 'A', to: 'B', cardinality: 'many' },
        { id: 'bc', from: 'B', to: 'C', cardinality: 'many' },
      ],
      actions: Array.from({ length: 7 }, (_, i) => act({ name: `b${i}`, target: 'B' })),
    },
  },
];

describe('layout edge-case invariants (adversarial QA)', () => {
  it('holds INV-1/2/3 within the CRUD-scan contract (≤2 targeted actions/object)', async () => {
    const allViolations: Violation[] = [];
    const allTall: string[] = [];

    for (const { name, snapshot } of CASES) {
      const positions = await computeLayout({ snapshot });
      const { violations, tallStacks } = analyze({ name, snapshot, positions });
      allViolations.push(...violations);
      allTall.push(...tallStacks.map((t) => `${name} :: ${t}`));
    }

    // A CRUD scan yields at most 2 targeted actions per object (update + delete;
    // create is target-less). Within that contract the map must never overlap:
    // hard-assert every INV-1/INV-3 and every INV-2 whose target has ≤2 loops —
    // this covers the isolated-action-target reserve fixed in this ticket. Pill
    // bands from ≥3 hand-authored actions on ONE object can still overlap a
    // neighbour or spill past the card vertically; that vertical-stack reserve is
    // a separate backlog item and reported (not asserted) below.
    const contractViolations = allViolations.filter(
      (v) => v.inv !== 'INV-2' || (v.loopCount ?? 0) <= 2,
    );
    const ont027 = allViolations.filter((v) => v.inv === 'INV-2' && (v.loopCount ?? 0) >= 3);

    /* eslint-disable no-console */
    console.log('\n===== Backlog: ≥3-action vertical pill-stack overlaps (report-only) =====');
    for (const v of ont027) console.log(`  [${v.snapshot}] ${v.detail}`);
    console.log('\n===== INV-4 tall pill stacks (report-only) =====');
    for (const t of allTall) console.log('  ' + t);
    console.log(`\n===== CONTRACT VIOLATIONS (must be 0): ${contractViolations.length} =====`);
    for (const v of contractViolations) console.log(`  [${v.inv}] [${v.snapshot}] ${v.detail}`);
    /* eslint-enable no-console */

    expect(contractViolations, JSON.stringify(contractViolations, null, 2)).toEqual([]);
  });
});
