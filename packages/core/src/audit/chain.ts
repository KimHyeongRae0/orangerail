import { createHash } from 'node:crypto';

import { canonicalJson } from '../introspect';
import type { AuditRecord } from '../store/contract';

/**
 * Genesis previous-hash: the defined `prevHash` of the first record so an empty
 * store verifies and the chain has a fixed anchor (§4.7 / AC-7).
 */
export const GENESIS_HASH = '0'.repeat(64);

/** The rendering of a value `JSON.stringify` refuses, when nothing better survives. */
const UNSERIALIZABLE = '[unserializable]';

/**
 * Render one value that `JSON.stringify` threw on, stating what was replaced
 * instead of dropping it.
 *
 * `ancestors` holds the objects currently open ABOVE this one, so only a true
 * cycle is called a cycle: the same object referenced twice side by side is a
 * DAG, it serializes fine, and calling it circular would be a false statement in
 * an audit record. Everything else follows `JSON.stringify`'s own rules — a
 * `toJSON` is honored, a function/symbol/`undefined` is dropped from an object
 * and becomes `null` in an array — so a value with one unserializable field
 * keeps every other field exactly as it would have been persisted.
 */
const renderRefused = ({ value, ancestors }: { value: unknown; ancestors: object[] }): unknown => {
  if (typeof value === 'bigint') {
    // Keep the digits. A record that says a write returned an id and cannot say
    // which id is barely worth appending (ONT-069).
    return `[unserializable: bigint ${value.toString()}]`;
  }

  if (typeof value !== 'object' || value === null) {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }

  if (ancestors.includes(value)) {
    return '[unserializable: circular reference]';
  }

  const toJson = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson === 'function') {
    return renderRefused({ value: (toJson as () => unknown).call(value), ancestors });
  }

  const nested = [...ancestors, value];

  if (Array.isArray(value)) {
    return value.map((item) => renderRefused({ value: item, ancestors: nested }) ?? null);
  }

  const rendered: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const child = renderRefused({ value: item, ancestors: nested });

    if (child !== undefined) {
      rendered[key] = child;
    }
  }

  return rendered;
};

/**
 * A value's PERSISTED form: what a JSON store writes and later reads back.
 *
 * Total by construction (§3.5 / ONT-069). The plain round-trip is tried first
 * and is what every ordinary value takes, so a chain written before this
 * function existed hashes bit-for-bit identically. Only a value
 * `JSON.stringify` THROWS on — a circular reference, a `BigInt`, an object
 * whose `toJSON` explodes — reaches the fallback, and the fallback always
 * returns something.
 *
 * The `?? 'null'` fallback this replaced covered values JSON DROPS
 * (`undefined`, a function). It did not cover values JSON throws on, and that
 * gap was not a hashing curiosity: it threw from inside `appendAudit`, so a
 * governed write landed in the database while the chain recorded nothing about
 * it, and the approval behind it was already spent (ONT-069).
 */
export const persistedForm = ({ value }: { value: unknown }): unknown => {
  try {
    return JSON.parse(JSON.stringify(value) ?? 'null') as unknown;
  } catch {
    try {
      const rendered = renderRefused({ value, ancestors: [] });

      // Round-trip the rendering too: it is the only proof the result is data a
      // store can write, and a getter that throws lands here rather than inside
      // the store.
      return JSON.parse(JSON.stringify(rendered) ?? 'null') as unknown;
    } catch {
      return UNSERIALIZABLE;
    }
  }
};

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
 * Hashing returns for every input, including one JSON drops entirely
 * (`undefined`, a function — hashed as `null`) and one JSON refuses to
 * serialize at all (see {@link persistedForm}). Hashing is never the thing that
 * fails.
 */
const hashPersisted = ({ value }: { value: unknown }): string => {
  const canonical = canonicalJson({ value: persistedForm({ value }) });

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
