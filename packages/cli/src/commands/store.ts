import { isFileStore, type FileStore } from 'orangerail-core';

import type { OrangerailConfig } from '../config';

/**
 * `orangerail store unlock` (§3.1 recovery). Clears the store lock ONLY when the
 * owner pid is provably dead; refuses a live owner, an `EPERM`/ambiguous owner,
 * and a missing/unreadable `owner.json`. Requires a file store.
 */
export const storeUnlock = async ({ config }: { config: OrangerailConfig }): Promise<number> => {
  if (!isFileStore({ store: config.store })) {
    process.stderr.write('store unlock requires a file store (createFileStore).\n');
    return 1;
  }

  const result = (config.store as FileStore).unlock();

  if (result.ok) {
    process.stdout.write(`${result.reason}\n`);
    return 0;
  }

  process.stderr.write(`store unlock refused: ${result.reason}\n`);

  return 1;
};
