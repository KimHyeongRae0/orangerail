/**
 * ONT-014 e2e fixture - no adapter but an EXPLICIT dev-mode opt-in (AC-4).
 *
 * With the secure default in place, dev mode must remain available when the
 * operator explicitly asks for it: `allowDevMode: true` restores the local-dev
 * all-roles identity so staging works without an adapter. (Pre-fix this field
 * is ignored because the server hardcodes dev mode; post-fix it is the only
 * way a no-adapter server stages at all.)
 */
import { createFileStore } from 'orangerail-core';

import { buildRegistry } from './ontology.mjs';

const storeDir = process.env.ORANGERAIL_E2E_STORE;
const dataDir = process.env.ORANGERAIL_E2E_DATA;

if (!storeDir || !dataDir) {
  throw new Error('ORANGERAIL_E2E_STORE and ORANGERAIL_E2E_DATA must be set');
}

export default {
  registry: buildRegistry({ dataDir }),
  store: createFileStore({ dir: storeDir }),
  allowDevMode: true,
};
