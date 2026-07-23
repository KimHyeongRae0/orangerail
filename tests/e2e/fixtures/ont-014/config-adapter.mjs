/**
 * ONT-014 e2e fixture - config WITH a static resolveIdentity adapter.
 *
 * The identity is selected via ORANGERAIL_E2E_IDENTITY so the driver can act as
 * distinct real subjects across processes:
 *   - alice / carol  role 'editor' (distinct subjects - separation of duty)
 *   - bob            role 'viewer' (wrong role)
 *   - anon           adapter returns null (anonymous / deny-first)
 *
 * Used by the phases that need real subjects: self-approval rejection (AC-5),
 * anonymous check_approval (AC-6), and the governed/auto loops (AC-1..AC-3).
 */
import { join } from 'node:path';

import { createFileStore } from 'orangerail-core';

import { buildRegistry } from './ontology.mjs';

const storeDir = process.env.ORANGERAIL_E2E_STORE;
const dataDir = process.env.ORANGERAIL_E2E_DATA;

if (!storeDir || !dataDir) {
  throw new Error('ORANGERAIL_E2E_STORE and ORANGERAIL_E2E_DATA must be set');
}

const IDENTITIES = {
  alice: { subject: 'alice', roles: ['editor'] },
  carol: { subject: 'carol', roles: ['editor'] },
  bob: { subject: 'bob', roles: ['viewer'] },
};

export default {
  registry: buildRegistry({ dataDir: join(dataDir) }),
  store: createFileStore({ dir: storeDir }),
  resolveIdentity: () => {
    const who = process.env.ORANGERAIL_E2E_IDENTITY;
    return IDENTITIES[who] ?? null;
  },
};
