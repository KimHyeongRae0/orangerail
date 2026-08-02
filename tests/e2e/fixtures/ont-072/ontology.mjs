/**
 * ONT-072 e2e ontology — rows that do not match the shape they were declared to
 * have.
 *
 * `employee` declares `complexityMix` (and every other metric) as required, and
 * nothing on the read path checks that a row agrees: `defineObject` stores the
 * schema and never parses `resolve` output with it
 * (`packages/core/src/define/object.ts:31-38`). These rows are therefore not
 * hypotheticals — they are what a live datasource can hand the studio today.
 *
 * Two modes, selected by `ORANGERAIL_E2E_MODE`:
 *
 *   `metrics` (default) — one conforming row plus three that break the
 *   declaration in different ways. `Bea` is the reported defect exactly: the key
 *   is absent, so `JSON.stringify` never emitted it and the browser derefs
 *   `undefined`. `Cyd` carries the key with an `undefined` value, which the
 *   ONT-071 walk NAMES on the wire — that row is the anchor for the claim that
 *   both surfaces spell an unshowable field the same way.
 *
 *   `boundary` — one row whose `displayName` is an object. `PersonNode` renders
 *   it as a React child, React refuses, and the component throws for a reason
 *   that has nothing to do with the metric guards. That is the case the error
 *   boundary exists for.
 *
 * Pure Node stdlib + orangerail-core + zod.
 */
import { createMemoryStore, createRegistry } from 'orangerail-core';
import { z } from 'zod';

/** The metric fields the studio's human view expects on every person row. */
const metrics = () => ({
  active: true,
  ticketCount: 4,
  storyPointsTotal: 12,
  complexityMix: { hi: 1, med: 1, lo: 2 },
  medianCycleDaysFirstHalf: 2,
  medianCycleDaysSecondHalf: 1,
  reopenRate: 'unavailable',
  reassignmentsGiven: 0,
  reassignmentsReceived: 0,
  helpGiven: 3,
  helpReceived: 5,
  weekendOffHoursShare: 0,
});

/** The rows for the `metrics` mode, in the order the snapshot will sort them. */
const metricRows = () => {
  // The reported defect: the key is not on the row at all, so the wire carries
  // no trace of it and the panel reads a property off `undefined`.
  const bea = { accountId: 'acc_bea', displayName: 'Bea', ...metrics() };
  delete bea.complexityMix;

  return [
    { accountId: 'acc_ann', displayName: 'Ann', ...metrics() },
    bea,
    // Present but `undefined`: the ONT-071 walk reports this one, so the reason
    // it serves and the marker the panel prints can be compared byte for byte.
    { accountId: 'acc_cyd', displayName: 'Cyd', ...metrics(), complexityMix: undefined },
    // Not one metric's problem: a mix that is not an object, a missing count,
    // and a null where a number was declared, all on one row.
    {
      accountId: 'acc_dov',
      displayName: 'Dov',
      ...metrics(),
      complexityMix: 'lots',
      ticketCount: undefined,
      storyPointsTotal: null,
    },
    // The identity field itself: a BigInt the wire cannot carry, so this row
    // reaches the browser keyed by a marker instead of by an id. It must still
    // be selectable and it must still be nameable.
    { accountId: 7n, displayName: 'Eze', ...metrics() },
  ];
};

/** The row for the `boundary` mode: a name React cannot render as a child. */
const boundaryRows = () => [{ accountId: 'acc_eve', displayName: { first: 'Eve' }, ...metrics() }];

/** Build a registry whose `employee` rows break the declaration in `mode`. */
export const buildRegistry = ({ mode }) => {
  const registry = createRegistry();
  const rows = mode === 'boundary' ? boundaryRows : metricRows;

  registry.defineObject({
    name: 'employee',
    schema: z.object({ accountId: z.string(), displayName: z.string() }),
    resolve: {
      get: async ({ id }) => rows().find((row) => row.accountId === id) ?? null,
      list: async () => ({ items: rows() }),
    },
  });

  return registry;
};

/** The store the studio config needs; nothing in this scenario writes to it. */
export const buildStore = () => createMemoryStore();
