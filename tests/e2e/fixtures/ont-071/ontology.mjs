/**
 * ONT-071 e2e ontology — the two surfaces that still rendered a stored value
 * unguarded.
 *
 * Actions (the MCP half). Each lands its side effect in the ledger and THEN
 * makes the audit log unwritable, so the terminal record and the minimal marker
 * that stands in for it both refuse to append while `execution_started` already
 * landed. That is exactly the shape of `audit_unrecorded`: the write happened
 * and the chain holds nothing about how it ended.
 *   - mark_widget   UNGOVERNED, so the outcome reaches the agent through `stage`.
 *   - apply_widget  GATED, so it reaches the agent through `check_approval`,
 *                   with the approval already consumed.
 *
 * Object (the studio half). `employee` is the type `orangerail studio` lists for
 * its human view, and its rows carry three things `JSON.stringify` will not
 * print: a `BigInt` column, a row that points at itself, and a `BigInt` in the
 * very field the snapshot builder SORTS on.
 *
 * Pure Node stdlib + orangerail-core + zod.
 */
import { appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { createRegistry } from 'orangerail-core';
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
  helpGiven: 0,
  helpReceived: 0,
  weekendOffHoursShare: 0,
});

/**
 * The rows the studio lists. Every ordinary field must survive verbatim beside
 * the ones that cannot be printed — a marker that takes its siblings with it
 * would be a different defect wearing the same name.
 */
const employees = () => {
  const cyclic = { accountId: 'acc_b', displayName: 'Bea', ...metrics() };
  cyclic.self = cyclic;

  return [
    // A BigInt in a field the person scorecard puts on screen, so the marker is
    // read by an operator and not only by the wire.
    { accountId: 'acc_a', displayName: 'Ann', ...metrics(), storyPointsTotal: 42n },
    cyclic,
    // The sort key itself. `buildInstanceSnapshot` orders employees by
    // `accountId.localeCompare(...)`, which a BigInt has no answer for — before
    // this ticket that threw inside the comparator and emptied the WHOLE
    // snapshot into the gather's catch, so one column silently blanked the page.
    { accountId: 7n, displayName: 'Cy', ...metrics(), active: false },
  ];
};

/** Build a registry bound to the given store and backend data directories. */
export const buildRegistry = ({ storeDir, dataDir }) => {
  const registry = createRegistry();

  const ledger = join(dataDir, 'side-effects.jsonl');

  /**
   * The side effect, followed by the store failure that leaves it unrecorded.
   * The order is the whole point: the ledger line is durable BEFORE the audit
   * log stops accepting writes, so a retry would append a second one.
   */
  const writeThenBreakTheLog = ({ what }) => {
    appendFileSync(ledger, `${JSON.stringify(what)}\n`);
    chmodSync(join(storeDir, 'audit.jsonl'), 0o444);
  };

  registry.defineObject({
    name: 'employee',
    schema: z.object({ accountId: z.string(), displayName: z.string() }),
    resolve: {
      get: async ({ id }) => employees().find((row) => row.accountId === id) ?? null,
      list: async () => ({ items: employees() }),
    },
  });

  registry.defineAction({
    name: 'mark_widget',
    input: z.object({ widgetId: z.string() }),
    execute: async ({ input }) => {
      writeThenBreakTheLog({ what: { action: 'mark_widget', id: input.widgetId } });

      return { marked: input.widgetId };
    },
  });

  registry.defineAction({
    name: 'apply_widget',
    input: z.object({ widgetId: z.string() }),
    policy: { approval: 'required', roles: ['editor'] },
    execute: async ({ input }) => {
      writeThenBreakTheLog({ what: { action: 'apply_widget', id: input.widgetId } });

      return { applied: input.widgetId };
    },
  });

  return registry;
};
