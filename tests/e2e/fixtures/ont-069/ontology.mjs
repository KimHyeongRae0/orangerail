/**
 * ONT-069 e2e ontology — values JSON refuses, for reasons that are not `BigInt`.
 *
 * One readable object whose rows point back at themselves, plus three actions:
 *   - record_reading  an AUTO action returning a circular structure — drives the
 *                     terminal-record half (a write that lands with nothing in
 *                     the chain).
 *   - apply_reading   a GATED action over a target whose row is circular, so the
 *                     `execution_started` record carries a prior the old hash
 *                     refused — the half that orphaned a consumed approval.
 *   - apply_plain     a GATED action over a plain target, used with an
 *                     unwritable audit log to prove an approval survives an
 *                     append that fails.
 *
 * Backend state and the side-effect ledger live under ORANGERAIL_E2E_DATA so the
 * driver can count executions. Pure Node stdlib + orangerail-core + zod.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRegistry } from 'orangerail-core';
import { z } from 'zod';

/** A row that refers to itself — unserializable, and nothing to do with BigInt. */
const circular = ({ id }) => {
  const row = { id, label: `reading ${id}`, takenAt: '2026-08-02T00:00:00.000Z' };
  row.self = row;

  return row;
};

/** Build a registry bound to the given backend data directory. */
export const buildRegistry = ({ dataDir }) => {
  const registry = createRegistry();

  const ledger = join(dataDir, 'side-effects.jsonl');

  const record = ({ what }) => {
    appendFileSync(ledger, `${JSON.stringify(what)}\n`);
  };

  const reading = registry.defineObject({
    name: 'reading',
    schema: z.object({ id: z.string(), label: z.string(), takenAt: z.string() }),
    resolve: {
      get: async ({ id }) => circular({ id }),
      list: async () => ({ items: [] }),
    },
  });

  const plain = registry.defineObject({
    name: 'plain',
    schema: z.object({ id: z.string(), label: z.string() }),
    resolve: {
      get: async ({ id }) => ({ id, label: readFileSync(join(dataDir, 'label.txt'), 'utf8') }),
    },
  });

  registry.defineAction({
    name: 'record_reading',
    input: z.object({ id: z.string() }),
    execute: async ({ input }) => {
      record({ what: { action: 'record_reading', id: input.id } });

      return circular({ id: input.id });
    },
  });

  registry.defineAction({
    name: 'apply_reading',
    target: reading,
    targetIdFrom: 'id',
    input: z.object({ id: z.string() }),
    policy: { approval: 'required', roles: ['editor'] },
    execute: async ({ input }) => {
      record({ what: { action: 'apply_reading', id: input.id } });

      return { applied: input.id };
    },
  });

  registry.defineAction({
    name: 'apply_plain',
    target: plain,
    targetIdFrom: 'id',
    input: z.object({ id: z.string() }),
    policy: { approval: 'required', roles: ['editor'] },
    execute: async ({ input }) => {
      record({ what: { action: 'apply_plain', id: input.id } });

      return { applied: input.id };
    },
  });

  return registry;
};
