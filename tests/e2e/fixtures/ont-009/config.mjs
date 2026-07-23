/**
 * ONT-009 e2e fixture — ontology config for the real Mastra MCP client seam.
 *
 * Mirrors the proven ont-003 dev-mode config: one readable object backed by a
 * JSON file, one approval-required action whose execute writes a side-effect
 * file, and one auto action. The store directory and backend paths come from
 * environment variables so the e2e driver controls the sandbox. No
 * resolveIdentity adapter — this fixture drives the standalone governed loop.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFileStore, createRegistry } from 'orangerail-core';
import { z } from 'zod';

const storeDir = process.env.ORANGERAIL_E2E_STORE;
const dataDir = process.env.ORANGERAIL_E2E_DATA;

if (!storeDir || !dataDir) {
  throw new Error('ORANGERAIL_E2E_STORE and ORANGERAIL_E2E_DATA must be set');
}

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

export default {
  registry,
  store: createFileStore({ dir: storeDir }),
  // ONT-014 AC-4 secure default: no resolveIdentity adapter, so the no-adapter
  // embed loop opts in to dev mode explicitly to keep staging.
  allowDevMode: true,
};
