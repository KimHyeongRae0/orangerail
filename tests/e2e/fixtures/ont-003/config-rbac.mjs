/**
 * ONT-003 e2e fixture — RBAC config with a static resolveIdentity adapter
 * (DESIGN.md §4.5 static-adapter e2e cases).
 *
 * The identity is selected via ORANGERAIL_E2E_IDENTITY so the driver can run
 * the same commands as different subjects: 'editor' (staging subject, editor
 * role), 'editor2' (a DISTINCT editor-role approver for genuine separation of
 * duty — ONT-014 AC-5), 'viewer' (wrong role), 'anon' (adapter returns null →
 * deny-first).
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

const IDENTITIES = {
  editor: { subject: 'alice', roles: ['editor'] },
  editor2: { subject: 'carol', roles: ['editor'] },
  viewer: { subject: 'bob', roles: ['viewer'] },
};

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
    writeFileSync(join(dataDir, 'side-effect-rbac.json'), JSON.stringify(input));
    return { published: input.documentId };
  },
});

export default {
  registry,
  store: createFileStore({ dir: storeDir }),
  resolveIdentity: () => {
    const who = process.env.ORANGERAIL_E2E_IDENTITY;
    return IDENTITIES[who] ?? null;
  },
};
