import { createHash } from 'node:crypto';

import { canonicalJson } from '../introspect';
import type { AuditRecord } from '../store/contract';

/**
 * Genesis previous-hash: the defined `prevHash` of the first record so an empty
 * store verifies and the chain has a fixed anchor (§4.7 / AC-7).
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * sha256 over a value's canonical PERSISTED form — the one hashing primitive
 * both the audit chain and the approval `inputHash` are built on.
 *
 * Hash the persisted form, not the in-memory form. A `result`/`input` can carry
 * values that JSON serialization normalizes — most commonly a `Date` (e.g. a
 * `createdAt` returned from a write): in memory `canonicalJson` reduces it to
 * `{}` (a Date has no own enumerable keys), while the store persists it as an
 * ISO string. Hashing the in-memory value would then never match a
 * recomputation over the reloaded value, so `verifyAudit` would flag every
 * timestamped write as tampered (ONT-023). A JSON round-trip pins the hashed
 * bytes to exactly what is written and later read.
 *
 * A value JSON drops entirely (`undefined`, a function) hashes as `null` rather
 * than throwing — hashing is never the thing that fails.
 */
const hashPersisted = ({ value }: { value: unknown }): string => {
  const persisted = JSON.parse(JSON.stringify(value) ?? 'null') as unknown;
  const canonical = canonicalJson({ value: persisted });

  return createHash('sha256').update(canonical).digest('hex');
};

/**
 * Compute the sha256 hash of an audit record over its full content (including
 * `seq` and `prevHash`, excluding `hash` itself). Any mutation of any hashed
 * field changes the digest — this is the tamper-evidence primitive `appendAudit`
 * uses to chain records and `verifyAudit` uses to detect tampering.
 */
export const hashAuditRecord = ({ record }: { record: Omit<AuditRecord, 'hash'> }): string =>
  hashPersisted({ value: record });

/**
 * Compute the sha256 hash of an approval's input — the `inputHash` stamped at
 * `createApproval` and re-checked before execution (§3.4 / ONT-040).
 *
 * `execute` re-reads the input from the store and runs it, and the action
 * signature only covers the action's DECLARED shape. Without this hash a
 * payload edited in the store between approval and execution runs unchallenged:
 * the operator approves `{"widgetId":"harmless-test-widget"}` and the engine
 * executes `{"widgetId":"PRODUCTION-CUSTOMER-TABLE"}`. Same canonicalization as
 * the chain, so the digest is stable across the store's JSON round-trip.
 */
export const hashApprovalInput = ({ input }: { input: unknown }): string =>
  hashPersisted({ value: input });
