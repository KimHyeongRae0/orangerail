/**
 * Public failure diagnostics — the ONE thing a failing datasource layer is
 * allowed to tell an untrusted agent beyond a correlation id (section 3.10).
 *
 * ONT-032 established the rule this module deliberately does NOT relax: a
 * driver/datasource error is never forwarded verbatim, because its text names
 * connection strings, credentials, hosts, table contents, query text, and
 * absolute paths. That rule cost something real, though — orangerail's OWN
 * first-run diagnostics ("the Prisma client is not generated", "DATABASE_URL is
 * unset") went out through the same funnel and vanished with it, so an agent
 * that could have said "run `npx prisma generate`" was told only that "the
 * datasource rejected the action".
 *
 * The resolution is a CLASSIFICATION channel, not a text channel. A layer that
 * can positively identify WHY it failed attaches a code from a closed enum; the
 * transport looks that code up in its own table and prints its own sentence.
 *
 * The safety property is structural rather than procedural:
 *
 *   - There is no string parameter. `PublicDiagnostic` carries a `code` from a
 *     closed set and, optionally, a `subject` that must match an identifier
 *     shape. A driver cannot smuggle a connection string through a field that
 *     rejects `:`, `/`, `@`, and whitespace, and cannot smuggle a row value
 *     through a field capped at 64 characters of `[A-Za-z0-9_]`.
 *   - The rendered text lives in the TRANSPORT, not here and not in the failing
 *     layer. The code selects a sentence orangerail wrote; it never supplies one.
 *   - Therefore a hostile datasource that somehow forged the brand gains
 *     nothing: the most it can achieve is making orangerail print one of
 *     orangerail's own sentences. There is no input that turns into output.
 *
 * The brand is a `Symbol.for` key rather than a class, so it survives two copies
 * of this package in one process (an `instanceof` check would silently stop
 * classifying and quietly degrade to full redaction).
 */

/**
 * The closed set of failure classes orangerail can positively identify.
 *
 * Every member is a CONFIGURATION fault — something wrong with how the project
 * is wired, which the operator or the agent can act on — never a data or query
 * fault, whose text is exactly what the redaction exists to withhold.
 */
export type PublicDiagnosticCode =
  /** `@prisma/client` did not resolve at all: not installed, or never generated. */
  | 'datasource_client_missing'
  /** The client loaded but carries no such model: generated from another schema. */
  | 'datasource_model_missing'
  /** The client could not initialize its datasource: URL/credentials/engine. */
  | 'datasource_not_configured';

const CODES: ReadonlySet<string> = new Set<PublicDiagnosticCode>([
  'datasource_client_missing',
  'datasource_model_missing',
  'datasource_not_configured',
]);

/**
 * The subject a diagnostic may name: an ontology object or datasource model
 * identifier, and nothing else. Anchored, charset-restricted and length-capped
 * so the field cannot become a text channel — a URL, a path, a stack frame, a
 * row value, or a sentence all fail it and are dropped.
 */
const SUBJECT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A classified failure: a code from the closed set, plus an optional subject. */
export interface PublicDiagnostic {
  code: PublicDiagnosticCode;
  subject?: string;
}

/**
 * The brand key. `Symbol.for` (the cross-realm global registry) so a generated
 * ontology file can mark an error with a one-line literal and no import, and so
 * duplicate copies of this package still agree on the key.
 */
export const PUBLIC_DIAGNOSTIC_KEY = Symbol.for('orangerail.publicDiagnostic');

/**
 * Attach a diagnostic to an error. Returns the same error so the caller can
 * `throw markPublicDiagnostic({ ... })`.
 *
 * The error's own `message` is untouched and stays operator-facing: the mark
 * changes what the TRANSPORT may say, never what is forwarded.
 */
export const markPublicDiagnostic = <T extends object>({
  error,
  code,
  subject,
}: {
  error: T;
  code: PublicDiagnosticCode;
  subject?: string;
}): T => {
  Object.defineProperty(error, PUBLIC_DIAGNOSTIC_KEY, {
    value: { code, ...(subject === undefined ? {} : { subject }) },
    enumerable: false,
    configurable: true,
    writable: true,
  });

  return error;
};

/**
 * Read a diagnostic off a caught value, revalidating everything.
 *
 * This is the trust boundary. Nothing about the marked payload is believed: the
 * code must be a member of the closed set and the subject must be an
 * identifier. Anything else — a missing brand, an unknown code, a non-object
 * payload, a subject that is really a message — yields `undefined`, and the
 * caller falls back to full redaction. Failing closed is the whole point.
 */
export const readPublicDiagnostic = ({
  error,
}: {
  error: unknown;
}): PublicDiagnostic | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const marked: unknown = (error as Record<symbol, unknown>)[PUBLIC_DIAGNOSTIC_KEY];
  if (typeof marked !== 'object' || marked === null) {
    return undefined;
  }

  const { code, subject } = marked as { code?: unknown; subject?: unknown };
  if (typeof code !== 'string' || !CODES.has(code)) {
    return undefined;
  }

  const named = typeof subject === 'string' && SUBJECT_PATTERN.test(subject);

  return { code: code as PublicDiagnosticCode, ...(named ? { subject: subject as string } : {}) };
};
