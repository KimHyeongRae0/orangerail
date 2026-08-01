/**
 * ONT-071 e2e fixture config. The identity is selected via
 * ORANGERAIL_E2E_IDENTITY so the driver can stage as one real subject and
 * approve as another (separation of duty, §3.4).
 */
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
};

export default {
  registry: buildRegistry({ storeDir, dataDir }),
  store: createFileStore({ dir: storeDir }),
  resolveIdentity: () => IDENTITIES[process.env.ORANGERAIL_E2E_IDENTITY] ?? null,
};
