/**
 * ONT-072 e2e fixture config. `ORANGERAIL_E2E_MODE` picks which way the rows
 * break their declaration, so one config serves both studio instances the
 * driver boots (see `ontology.mjs`).
 */
import { buildRegistry, buildStore } from './ontology.mjs';

export default {
  registry: buildRegistry({ mode: process.env.ORANGERAIL_E2E_MODE ?? 'metrics' }),
  store: buildStore(),
};
