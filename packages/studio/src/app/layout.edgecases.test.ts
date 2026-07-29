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
 * targeted-action self-loop-pill-over-next-card bug ONT-025 fixed.
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
  inv: 'INV-1' | 'INV-2' | 'INV-3' | 'INV-4';
  detail: string;
  /** For INV-2/INV-4: the target's self-loop count. A stack of ≥3 pills is taller
   * than the card it hangs off, so it is the case the vertical reserve exists for. */
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
}): { violations: Violation[]; stacks: string[] } => {
  const violations: Violation[] = [];
  const stacks: string[] = [];

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
    if (band.stackHeight > band.cardHeight) {
      stacks.push(
        `"${band.target}" N=${band.loopCount}: pill stack ${band.stackHeight.toFixed(0)}px vs card ${band.cardHeight.toFixed(0)}px (overhang ${((band.stackHeight - band.cardHeight) / 2).toFixed(0)}px each side)`,
      );
    }
  }

  // INV-4: two pill bands must not intersect either — a stacked pill overlapping a
  // neighbouring card's pill is as unreadable as one overlapping the card itself.
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i];
      const b = bands[j];
      if (!a || !b) continue;
      if (
        overlaps1D(a.left, a.right, b.left, b.right, CARD_MARGIN) &&
        overlaps1D(a.top, a.bottom, b.top, b.bottom, CARD_MARGIN)
      ) {
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        violations.push({
          snapshot: name,
          inv: 'INV-4',
          loopCount: Math.max(a.loopCount, b.loopCount),
          detail: `pill bands of "${a.target}" (N=${a.loopCount}) and "${b.target}" (N=${b.loopCount}) overlap ${ox.toFixed(0)}x${oy.toFixed(0)}px`,
        });
      }
    }
  }

  return { violations, stacks };
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
  // (n) isolated action-target with a tall stack docked ABOVE another isolated card.
  // The isolated column advances its cursor by hand, so it needs the same vertical
  // reserve ELK boxes now carry — at 3 and at 5 actions, so the reserve is a formula
  // and not a number tuned to one count.
  ...[3, 5].map((count) => ({
    name: `n${count}:isolated target with ${count} actions above another isolated card`,
    snapshot: {
      objects: [
        obj({ name: 'settingX', fields: ['id', 'key'] }),
        obj({ name: 'belowX', fields: ['id'] }),
        obj({ name: 'linkedA', fields: ['id'] }),
        obj({ name: 'linkedB', fields: ['id'] }),
      ],
      links: [{ id: 'lab', from: 'linkedA', to: 'linkedB', cardinality: 'many' as const }],
      actions: Array.from({ length: count }, (_, i) =>
        act({ name: `set${i}`, target: 'settingX' }),
      ),
    },
  })),
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

/** A target with `count` self-loops, a same-layer sibling, and a next-layer card. */
const stackCase = ({ count }: { count: number }): GraphSnapshot => ({
  objects: [
    obj({ name: 'ledger', fields: ['id', 'balance'] }),
    obj({ name: 'sibling', fields: ['id'] }),
    obj({ name: 'sink', fields: ['id'] }),
  ],
  links: [
    { id: 'l_sink', from: 'ledger', to: 'sink', cardinality: 'many' },
    { id: 's_sink', from: 'sibling', to: 'sink', cardinality: 'many' },
  ],
  actions: Array.from({ length: count }, (_, i) => act({ name: `post${i}`, target: 'ledger' })),
});

describe('layout edge-case invariants (adversarial QA)', () => {
  it('holds INV-1/2/3/4 across every snapshot, at any targeted-action count', async () => {
    const allViolations: Violation[] = [];
    const allStacks: string[] = [];

    for (const { name, snapshot } of CASES) {
      const positions = await computeLayout({ snapshot });
      const { violations, stacks } = analyze({ name, snapshot, positions });
      allViolations.push(...violations);
      allStacks.push(...stacks.map((s) => `${name} :: ${s}`));
    }

    console.log('\n===== pill stacks taller than their card (the reserved case) =====');
    for (const s of allStacks) console.log('  ' + s);
    console.log(`\n===== VIOLATIONS (must be 0): ${allViolations.length} =====`);
    for (const v of allViolations) console.log(`  [${v.inv}] [${v.snapshot}] ${v.detail}`);

    // The assertion is unconditional. It used to be filtered down to the CRUD-scan
    // contract (≤2 targeted actions/object) because a taller stack had nowhere to go:
    // three pills span 212px against a 75px card, so the overhang landed on whatever
    // ELK placed above or below, and the ≥3 case could only be REPORTED. Now every
    // card's layout box is at least as tall as its own stack, so no count is exempt.
    expect(
      allStacks.length,
      'expected snapshots whose stack overhangs its card, so the ≥3 case is exercised',
    ).toBeGreaterThan(0);
    expect(allViolations, JSON.stringify(allViolations, null, 2)).toEqual([]);
  });

  it('stacks ≥3 targeted actions vertically and grows the reserve with the count', async () => {
    const clearances: number[] = [];

    // 3 and 5, not just 3 — the reserve has to be the stack formula, not a constant
    // that happens to fit three pills.
    for (const count of [3, 5]) {
      const snapshot = stackCase({ count });
      const positions = await computeLayout({ snapshot });
      const { violations } = analyze({ name: `stack-${count}`, snapshot, positions });

      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

      const target = snapshot.objects[0] as SnapshotObject;
      const neighbour = snapshot.objects[1] as SnapshotObject;
      const ledger = positions.get(objectId({ name: 'ledger' }));
      const sibling = positions.get(objectId({ name: 'sibling' }));
      const sink = positions.get(objectId({ name: 'sink' }));

      const centreY = (ledger?.y ?? 0) + cardHeight({ object: target }) / 2;
      const stackHalf = ((count - 1) / 2) * PILL_STAGGER + PILL_HALF_HEIGHT;

      // The stack really is taller than the card it hangs off — that is the case.
      expect(stackHalf * 2).toBeGreaterThan(cardHeight({ object: target }));

      // The next layer clears the band horizontally (the ONT-025 reserve, unchanged).
      expect(sink?.x ?? 0).toBeGreaterThanOrEqual(
        (ledger?.x ?? 0) + cardWidth({ object: target }) + PILL_RIGHT_FROM_RIGHT,
      );

      // `sibling` shares ledger's ELK layer, so only the vertical reserve can keep it
      // off the stack: it must sit wholly above or wholly below the pills.
      const siblingTop = sibling?.y ?? 0;
      const siblingBottom = siblingTop + cardHeight({ object: neighbour });
      const clearance = Math.max(
        siblingTop - (centreY + stackHalf),
        centreY - stackHalf - siblingBottom,
      );

      expect(clearance).toBeGreaterThanOrEqual(0);
      clearances.push(siblingTop + (siblingBottom - siblingTop) / 2 - centreY);
    }

    // Five pills push the neighbour further away than three do — the reserve scales.
    expect(Math.abs(clearances[1] ?? 0)).toBeGreaterThan(Math.abs(clearances[0] ?? 0));
  });
});
