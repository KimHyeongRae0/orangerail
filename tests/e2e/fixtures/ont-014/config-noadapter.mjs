/**
 * ONT-014 e2e fixture - config with NO resolveIdentity adapter and NO dev-mode
 * opt-in (AC-4 secure default).
 *
 * Under the secure default an MCP server built from this config must treat
 * every caller as unauthenticated: authenticated reads are denied and staging
 * a governed action is denied (deny-first). Today the MCP server hardcodes
 * allowDevMode:true, so a no-adapter server instead treats callers as the
 * all-roles 'local-dev' identity - the gap this phase pins as RED.
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
};
