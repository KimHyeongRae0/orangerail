import { createHash } from 'node:crypto';

import { canonicalJson } from '../introspect';
import type { AuditRecord } from '../store/contract';

/**
 * Genesis previous-hash: the defined `prevHash` of the first record so an empty
 * store verifies and the chain has a fixed anchor (§4.7 / AC-7).
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Compute the sha256 hash of an audit record over its full content (including
 * `seq` and `prevHash`, excluding `hash` itself). Any mutation of any hashed
 * field changes the digest — this is the tamper-evidence primitive `appendAudit`
 * uses to chain records and `verifyAudit` uses to detect tampering.
 */
export const hashAuditRecord = ({ record }: { record: Omit<AuditRecord, 'hash'> }): string => {
  // Hash over the record's PERSISTED form, not its in-memory form. A record's
  // `result`/`input` can carry values that JSON serialization normalizes — most
  // commonly a `Date` (e.g. a `createdAt` returned from a write): in memory
  // `canonicalJson` reduces it to `{}` (a Date has no own enumerable keys),
  // while the store persists it as an ISO string. Hashing the in-memory value
  // would then never match a recomputation over the reloaded record, so
  // `verifyAudit` would flag every timestamped write as tampered. A JSON
  // round-trip pins the hashed bytes to exactly what is written and later read.
  const persisted = JSON.parse(JSON.stringify(record)) as unknown;
  const canonical = canonicalJson({ value: persisted });

  return createHash('sha256').update(canonical).digest('hex');
};
