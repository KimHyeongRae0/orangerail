import type { InstanceSnapshot } from '../snapshot/instances';

/** The pure, degree-ordered person x person `helps` adjacency model (AC-3). */
export interface HelpMatrixModel {
  /** Row/column order: accountIds, total help degree desc, accountId asc tiebreak. */
  order: string[];
  /** accountId -> displayName, for the labels/headers (rendered as React text). */
  labels: Map<string, string>;
  /** `${from}->${to}` -> summed help weight (missing pair = no help). */
  weights: Map<string, number>;
  /** accountId -> summed out-degree weight (helper). */
  rowTotals: Map<string, number>;
  /** accountId -> summed in-degree weight (help magnet). */
  colTotals: Map<string, number>;
  /** The largest single cell weight, for the intensity scale (0 when empty). */
  maxWeight: number;
}

/** Canonical cell key for a (from, to) help pair. */
export const cellKey = ({ from, to }: { from: string; to: string }): string => `${from}->${to}`;

/**
 * Build the person x person `helps` adjacency matrix model (plan Decision 3,
 * AC-3). Pure: from `snapshot.employees` and `snapshot.edges.helps` it sums the
 * weight of every (from, to) help pair, the per-person out-degree (row) and
 * in-degree (column) weight totals, and the max single-cell weight. The row and
 * column order is by **total help degree (out + in) descending, with accountId
 * ascending as the tiebreak** — a total order because accountIds are unique, so
 * the result is byte-stable for a fixed snapshot (the same determinism posture
 * as `buildInstanceSnapshot`). It surfaces hubs: a high-degree helper/magnet
 * clusters toward the top-left, reading as a dense row/column. No composite
 * score and no ranking number are computed — raw weights and their row/column
 * sums only (honesty).
 */
export const buildHelpMatrix = ({ snapshot }: { snapshot: InstanceSnapshot }): HelpMatrixModel => {
  const labels = new Map<string, string>();

  for (const employee of snapshot.employees) {
    labels.set(employee.accountId, employee.displayName);
  }

  const weights = new Map<string, number>();
  const rowTotals = new Map<string, number>();
  const colTotals = new Map<string, number>();
  let maxWeight = 0;

  for (const employee of snapshot.employees) {
    rowTotals.set(employee.accountId, 0);
    colTotals.set(employee.accountId, 0);
  }

  for (const edge of snapshot.edges.helps) {
    // Only person-to-person help pairs (both endpoints are known employees).
    if (!labels.has(edge.from) || !labels.has(edge.to)) {
      continue;
    }

    const key = cellKey({ from: edge.from, to: edge.to });
    const next = (weights.get(key) ?? 0) + edge.weight;

    weights.set(key, next);
    maxWeight = Math.max(maxWeight, next);
    rowTotals.set(edge.from, (rowTotals.get(edge.from) ?? 0) + edge.weight);
    colTotals.set(edge.to, (colTotals.get(edge.to) ?? 0) + edge.weight);
  }

  const degreeOf = ({ accountId }: { accountId: string }): number =>
    (rowTotals.get(accountId) ?? 0) + (colTotals.get(accountId) ?? 0);

  const order = [...labels.keys()].sort((a, b) => {
    const byDegree = degreeOf({ accountId: b }) - degreeOf({ accountId: a });

    return byDegree !== 0 ? byDegree : a.localeCompare(b);
  });

  return { order, labels, weights, rowTotals, colTotals, maxWeight };
};
