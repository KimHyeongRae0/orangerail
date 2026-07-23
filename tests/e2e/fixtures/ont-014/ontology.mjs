/**
 * ONT-014 e2e shared ontology (ticket AC-1..AC-7).
 *
 * One authenticated-read object plus four actions exercised by the governance
 * -security battery:
 *   - document          a readable object (default readAccess 'authenticated')
 *   - publish_document  a governed (approval-required) action, role 'editor'
 *   - touch_counter     an auto action (no approval) - drives the auto-action
 *                       execution_started -> terminal cross-check (AC-2)
 *   - risky_action      a governed action with a FUNCTIONAL where that throws
 *                       at execute-time (a boom-flag file appears between stage
 *                       and execute) - drives the fail-closed where wrap (AC-6)
 *
 * Backend state and the boom flag live under ORANGERAIL_E2E_DATA so the driver
 * controls them per phase. Pure Node stdlib + orangerail-core + zod.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRegistry } from 'orangerail-core';
import { z } from 'zod';

/** Build a fresh registry bound to the given backend data directory. */
export const buildRegistry = ({ dataDir }) => {
  const registry = createRegistry();

  const readBackend = () => JSON.parse(readFileSync(join(dataDir, 'backend.json'), 'utf8'));

  const document = registry.defineObject({
    name: 'document',
    schema: z.object({ id: z.string(), title: z.string(), status: z.string() }),
    resolve: {
      get: async ({ id }) => readBackend().find((doc) => doc.id === id) ?? null,
      list: async () => ({ items: readBackend() }),
    },
  });

  registry.defineAction({
    name: 'publish_document',
    target: document,
    input: z.object({ documentId: z.string(), note: z.string() }),
    policy: {
      approval: 'required',
      roles: ['editor'],
      where: { field: 'status', op: 'eq', value: 'draft' },
    },
    execute: async ({ input }) => {
      writeFileSync(join(dataDir, 'side-effect.json'), JSON.stringify(input));
      return { published: input.documentId };
    },
  });

  registry.defineAction({
    name: 'touch_counter',
    input: z.object({ label: z.string() }),
    execute: async ({ input }) => ({ touched: input.label }),
  });

  // A governed action whose FUNCTIONAL where passes at stage time (no boom
  // flag yet) but THROWS at execute time once the driver drops a boom flag.
  // Today that throw escapes uncaught after the approval is consumed; the AC-6
  // fix maps it to a fail-closed resolve_error with an audit record.
  registry.defineAction({
    name: 'risky_action',
    input: z.object({ note: z.string() }),
    policy: {
      approval: 'required',
      roles: ['editor'],
      where: () => {
        if (existsSync(join(dataDir, 'boom.flag'))) {
          throw new Error('where predicate exploded at execute time');
        }
        return true;
      },
    },
    execute: async ({ input }) => ({ done: input.note }),
  });

  return registry;
};
