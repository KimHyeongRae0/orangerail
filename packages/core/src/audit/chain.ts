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
  const canonical = canonicalJson({ value: record });

  return createHash('sha256').update(canonical).digest('hex');
};
