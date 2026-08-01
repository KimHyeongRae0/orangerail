import { admits } from './introspect';

/**
 * How a `BigInt` crosses a JSON boundary in orangerail: as a DECIMAL STRING,
 * everywhere and in both directions (ONT-068).
 *
 * JSON has no integer type wide enough for a 64-bit key, and a JSON number is
 * not a narrower-but-correct approximation of one — it is a wrong-row bug.
 * Measured: a `_get` for id `9007199254740993` reached the resolver as
 * `9007199254740992`, because `JSON.parse` rounds at the door, and came back as
 * an ordinary `not_found` for a row that exists. Nothing downstream can detect
 * that, which is why no layer here is allowed to see a number.
 *
 * A decimal string keeps every digit at any width, survives `JSON.stringify`,
 * and is what Prisma accepts back as a `BigInt` key — verified against MySQL
 * 9.7.1 through `@prisma/adapter-mariadb` 7.9.1, above and below 2^53.
 *
 * The blast radius this exists for is not an edge case: `$table->id()` — the
 * first line of every default Laravel migration since 5.8 — is
 * `BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY`, and Rails has defaulted to
 * bigint primary keys since 5.1.
 *
 * One range this does NOT widen: Prisma's `BigInt` scalar is SIGNED 64-bit,
 * while MySQL's `BIGINT UNSIGNED` runs to 2^64-1. A row past 2^63-1 is read back
 * here with every digit intact, and Prisma refuses it as a KEY argument before
 * any query is built. That boundary belongs to the datasource client; the wire
 * form is correct on both sides of it either way.
 */

/**
 * The one spelling of a decimal integer this project accepts, as a regex SOURCE
 * so the emitter can render the identical pattern into generated code (there is
 * no import path from a user's `ontology/*.mjs` back to this package).
 *
 * Decided explicitly, because an id string arrives from an agent rather than
 * from a keyboard:
 *   - leading zeros are ACCEPTED (`"007"`) — the datasource resolves them to the
 *     same row, and refusing a value the database handles would be this layer
 *     inventing a rule of its own;
 *   - surrounding whitespace is REFUSED (`" 1"`), even though `BigInt(" 1")` is
 *     `1n`. A padded id is a bug in the caller far more often than an intent,
 *     and refusing it at the gate costs one clear `invalid_input` instead of a
 *     silent success on a row nobody named;
 *   - a fraction, a hex literal and an empty string are refused, so
 *     `"1.5"` / `"0x10"` / `""` never reach a driver that would answer with
 *     `Cannot convert 0x10 to a BigInt` under a `resolve_error`.
 */
export const DECIMAL_INTEGER_SOURCE = '^-?\\d+$';

const DECIMAL_INTEGER = new RegExp(DECIMAL_INTEGER_SOURCE);

/** Whether a value is a decimal-integer string — the wire form of a `BigInt`. */
export const isDecimalInteger = ({ value }: { value: unknown }): boolean =>
  typeof value === 'string' && DECIMAL_INTEGER.test(value);

/**
 * Whether a field-level zod node is a `BigInt` column carried as a decimal
 * string, i.e. the node {@link DECIMAL_INTEGER_SOURCE} is emitted into.
 *
 * Asked through `safeParse` rather than by reading zod's check list, for the
 * reason the rest of `introspect.ts` does: `_def.checks` moved between zod v3
 * and v4, and a probe answers for any spelling of the chain.
 *
 * What this buys is the difference between an ordering filter and a substring
 * one. Once a `BigInt` column is emitted as a string, the transport cannot tell
 * it from a `String` column by type name alone — and handing it the string
 * operator set would advertise `contains` / `startsWith`, which Prisma's
 * `BigIntFilter` does not have, so the datasource would reject a filter the gate
 * had already accepted (the `Bytes` defect).
 *
 * A hand-written `z.string().regex(/^\d+$/)` over a numeric VARCHAR matches
 * these probes and is classified the same way. That costs it `contains` and is
 * the direction to be wrong in: every operator it keeps still means what it
 * says, and a filter this module accepts is one the datasource can answer.
 */
export const isDecimalIntegerField = ({ node }: { node: unknown }): boolean =>
  admits({ node, value: '9007199254740993' }) &&
  !admits({ node, value: '9007199254740993.5' }) &&
  !admits({ node, value: 'not-a-number' });

/** Recursive half of {@link renderBigInts}; `seen` is the path, not a cache. */
const renderInto = ({ value, seen }: { value: unknown; seen: Set<object> }): unknown => {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Only a plain object and an array are descended into. A `Date`, a Prisma
  // `Decimal`, a `Buffer` — anything carrying its own class — is handed back by
  // reference, because rebuilding it as a plain object is how a `createdAt`
  // becomes `{}` and every timestamped write starts failing `verifyAudit`
  // (ONT-023).
  const proto: unknown = Object.getPrototypeOf(value);
  const descend = Array.isArray(value) || proto === Object.prototype || proto === null;

  if (!descend || seen.has(value)) {
    return value;
  }

  seen.add(value);

  const rendered: unknown = Array.isArray(value)
    ? value.map((item) => renderInto({ value: item, seen }))
    : Object.fromEntries(
        Object.keys(value as Record<string, unknown>).map((key) => [
          key,
          renderInto({ value: (value as Record<string, unknown>)[key], seen }),
        ]),
      );

  seen.delete(value);

  return rendered;
};

/**
 * Return `value` with every `BigInt` in it replaced by its decimal string —
 * nested in an object, inside an array, and inside a JSON column's contents.
 *
 * `JSON.stringify` throws `Do not know how to serialize a BigInt`, and the audit
 * chain hashes the PERSISTED form (`chain.ts`), so one BigInt anywhere in a
 * result costs the terminal audit record for a write that already happened: the
 * row exists, the chain says only that execution started, and the agent is told
 * `internal_error`. Rendering removes the throw rather than catching it.
 *
 * A value that points at itself is handed back untouched at the second visit,
 * so this cannot spin — `JSON.stringify` then reports the cycle exactly as it
 * does today, which is the pre-existing behavior for a cyclic result.
 */
export const renderBigInts = ({ value }: { value: unknown }): unknown =>
  renderInto({ value, seen: new Set<object>() });
