import ELK from 'elkjs/lib/elk.bundled.js';

import type { InstanceSnapshot } from '../snapshot/instances';
import { personNodeId, personRadius, serviceNodeId, teamNodeId } from './instanceModel';

const elk = new ELK();

/**
 * elkjs stress-layout tuning for the people/ONA network (plan Decision 2b). The
 * stress algorithm ships in the installed elkjs 0.12.0 (no new dependency); it
 * places a weighted, non-hierarchical network with even edge lengths. The
 * desired edge length and node spacing are widened relative to ONT-011 so the
 * initial placement is already well spread; the deterministic `separateNodes`
 * post-pass then guarantees a collision-free result independent of ELK.
 */
export const INSTANCE_ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'org.eclipse.elk.stress',
  'org.eclipse.elk.stress.desiredEdgeLength': '260',
  'org.eclipse.elk.stress.epsilon': '0.0001',
  'elk.spacing.nodeNode': '110',
};

/**
 * The layout box for a place node (service / team). Deliberately larger than the
 * rendered `ServiceNode` DOM upper bound (min-width 120 / max-width 200) so the
 * de-overlap pass over-separates and the on-screen boxes cannot touch, even
 * though the layout box and the measured DOM box differ slightly.
 */
const PLACE_LAYOUT_WIDTH = 200;
const PLACE_LAYOUT_HEIGHT = 80;

/** Extra spacing enforced between every pair of node boxes by `separateNodes`. */
const SEPARATION_GUTTER = 16;

/** Bound on the de-overlap passes (converges far sooner at fixture scale). */
const SEPARATION_MAX_PASSES = 300;

/**
 * A deterministic pure de-overlap pass (plan Decision 2b, AC-2). Given
 * top-left `positions` and per-id box `sizes`, it pushes every overlapping pair
 * apart along its minimum-translation axis (half the penetration each) until a
 * pass finds no overlap or the pass bound is hit. Pairs are visited in
 * id-sorted order and ties (coincident centres) break by id compare, so the
 * result is a pure function of the inputs — no timestamps, no RNG. The
 * invariant it establishes: no two boxes overlap (their gap is at least
 * `SEPARATION_GUTTER`), which is asserted by the e2e bounding-box check.
 */
export const separateNodes = ({
  positions,
  sizes,
}: {
  positions: Map<string, { x: number; y: number }>;
  sizes: Map<string, { width: number; height: number }>;
}): Map<string, { x: number; y: number }> => {
  const ids = [...positions.keys()].sort();
  const pos = new Map(
    ids.map((id) => [id, { ...(positions.get(id) as { x: number; y: number }) }]),
  );

  const sizeOf = ({ id }: { id: string }) => sizes.get(id) ?? { width: 0, height: 0 };

  for (let pass = 0; pass < SEPARATION_MAX_PASSES; pass += 1) {
    let moved = false;

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i] as string;
        const b = ids[j] as string;
        const pa = pos.get(a) as { x: number; y: number };
        const pb = pos.get(b) as { x: number; y: number };
        const sa = sizeOf({ id: a });
        const sb = sizeOf({ id: b });

        const dx = pa.x + sa.width / 2 - (pb.x + sb.width / 2);
        const dy = pa.y + sa.height / 2 - (pb.y + sb.height / 2);
        const overlapX = sa.width / 2 + sb.width / 2 + SEPARATION_GUTTER - Math.abs(dx);
        const overlapY = sa.height / 2 + sb.height / 2 + SEPARATION_GUTTER - Math.abs(dy);

        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }

        moved = true;

        if (overlapX <= overlapY) {
          const dir = dx === 0 ? (a < b ? 1 : -1) : Math.sign(dx);
          const shift = overlapX / 2;

          pa.x += dir * shift;
          pb.x -= dir * shift;
        } else {
          const dir = dy === 0 ? (a < b ? 1 : -1) : Math.sign(dy);
          const shift = overlapY / 2;

          pa.y += dir * shift;
          pb.y -= dir * shift;
        }
      }
    }

    if (!moved) {
      break;
    }
  }

  return pos;
};

/** A deterministic circular fallback so nodes never collapse to one point (AC-5). */
const circleFallback = ({ ids }: { ids: string[] }): Map<string, { x: number; y: number }> => {
  const positions = new Map<string, { x: number; y: number }>();
  const radius = Math.max(320, ids.length * 60);

  ids.forEach((id, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, ids.length);
    positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  });

  return positions;
};

/**
 * Compute Network-view node positions with the elkjs stress algorithm plus the
 * deterministic `separateNodes` de-overlap pass (plan Decision 2b). Person nodes
 * are sized by their story-point radius, place nodes (services + team) get a
 * fixed box; `helps`/`works_on`/`member_of` all feed the layout so the network
 * shape reflects the full collaboration graph. Isolated nodes are placed, never
 * dropped. If ELK throws the result degrades to a deterministic circle. Both the
 * ELK result and the fallback are run through `separateNodes`, so the
 * collision-free invariant holds on every path. Returns a position per node id,
 * awaited into a map exactly like `computeLayout`.
 */
export const computeInstanceLayout = async ({
  snapshot,
}: {
  snapshot: InstanceSnapshot;
}): Promise<Map<string, { x: number; y: number }>> => {
  const sizes = new Map<string, { width: number; height: number }>();

  const children = [
    ...snapshot.employees.map((employee) => {
      const diameter = personRadius({ storyPointsTotal: employee.storyPointsTotal }) * 2;
      const id = personNodeId({ accountId: employee.accountId });

      sizes.set(id, { width: diameter, height: diameter });

      return { id, width: diameter, height: diameter };
    }),
    ...snapshot.services.map((service) => {
      const id = serviceNodeId({ id: service.id });

      sizes.set(id, { width: PLACE_LAYOUT_WIDTH, height: PLACE_LAYOUT_HEIGHT });

      return { id, width: PLACE_LAYOUT_WIDTH, height: PLACE_LAYOUT_HEIGHT };
    }),
    ...snapshot.teams.map((team) => {
      const id = teamNodeId({ id: team.id });

      sizes.set(id, { width: PLACE_LAYOUT_WIDTH, height: PLACE_LAYOUT_HEIGHT });

      return { id, width: PLACE_LAYOUT_WIDTH, height: PLACE_LAYOUT_HEIGHT };
    }),
  ];

  const edges = [
    ...snapshot.edges.helps.map((edge, index) => ({
      id: `l-helps-${index}`,
      sources: [personNodeId({ accountId: edge.from })],
      targets: [personNodeId({ accountId: edge.to })],
    })),
    ...snapshot.edges.works_on.map((edge, index) => ({
      id: `l-works-${index}`,
      sources: [personNodeId({ accountId: edge.from })],
      targets: [serviceNodeId({ id: edge.to })],
    })),
    ...snapshot.edges.member_of.map((edge, index) => ({
      id: `l-member-${index}`,
      sources: [personNodeId({ accountId: edge.from })],
      targets: [teamNodeId({ id: edge.to })],
    })),
  ];

  const ids = children.map((child) => child.id);

  if (children.length === 0) {
    return new Map();
  }

  try {
    const result = await elk.layout({
      id: 'instances-root',
      layoutOptions: INSTANCE_ELK_OPTIONS,
      children,
      edges,
    });

    const positions = new Map<string, { x: number; y: number }>();

    for (const child of result.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }

    // Guard against a degenerate ELK result (all-zero / missing) by falling back.
    const distinct = new Set([...positions.values()].map((p) => `${p.x},${p.y}`));

    if (positions.size < ids.length || distinct.size <= 1) {
      return separateNodes({ positions: circleFallback({ ids }), sizes });
    }

    return separateNodes({ positions, sizes });
  } catch {
    return separateNodes({ positions: circleFallback({ ids }), sizes });
  }
};
