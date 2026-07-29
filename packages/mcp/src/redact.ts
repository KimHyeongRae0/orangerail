/**
 * Execution-failure redaction (§3.10).
 *
 * orangerail sits between an untrusted agent and the datasource precisely so
 * that surface is controlled — so a driver error must never be forwarded
 * verbatim. A raw Prisma/driver message names tables, constraint names, query
 * text, and absolute file paths; a store failure names the audit path and the
 * OS errno. This module turns such a failure into what the agent is allowed to
 * know: a stable status, a domain-level cause, the tool it happened in, and the
 * correlation id an operator can look the FULL text up by.
 *
 * The redaction is deliberately NOT "drop the error": an agent that only learns
 * "something went wrong" cannot decide whether to retry, pick another tool, or
 * escalate to its human. Category + phase + a quotable id keeps it useful.
 *
 * The message is held to the same honesty standard as the rest of the project.
 * It names what KIND of error was withheld — a datasource error and a store
 * error are not the same thing — and points only at a channel that actually
 * holds the text for that failure, never at an audit record that cannot exist.
 *
 * ONT-045 adds ONE thing, and it is not a hole in the above. Where orangerail
 * could positively CLASSIFY the failure, core hands up a `PublicDiagnostic` —
 * a code from a closed enum plus an identifier-shaped subject, never a string
 * from the failing layer. This module owns the sentence for each code. So the
 * classification selects orangerail's own prose; it never carries prose in. The
 * underlying text is still withheld, and the message still says so.
 */

import type { PublicDiagnostic, PublicDiagnosticCode } from 'orangerail-core';

/** The failure statuses whose detail may carry raw datasource/driver text. */
export type FailureStatus = 'failed' | 'resolve_error' | 'audit_blocked' | 'internal_error';

/**
 * Where the withheld text actually lives.
 *
 * `host-log` is always true: the operator sink runs on every failure path
 * before the response is built. `audit-and-host-log` additionally names the
 * audit record, and is claimed ONLY where the engine appends one — not for a
 * read tool (reads are not audited by design) and not for `audit_blocked`
 * (the append is what failed).
 */
export type FailureChannel = 'host-log' | 'audit-and-host-log';

/** The agent-facing shape of a redacted failure. */
export interface RedactedFailure {
  status: FailureStatus;
  message: string;
  correlationId: string;
  /** Present only when the failure was classified; echoed for machine callers. */
  diagnostic?: PublicDiagnosticCode;
}

/**
 * The sentence orangerail prints for each diagnosable failure class. These are
 * the ONLY strings the carve-out can produce, and they live here — in the
 * transport — so no failing layer can supply one. `subject` is an identifier
 * core already revalidated; the subject-less form covers the case where it was
 * absent or rejected.
 *
 * Each is written for the reader who can act: it names the fault, the fix, and
 * nothing about the datasource's own state.
 */
const DIAGNOSTIC: Record<
  PublicDiagnosticCode,
  { cause: string; advice: ({ subject }: { subject?: string }) => string }
> = {
  datasource_client_missing: {
    cause: 'the datasource client is not installed or has never been generated',
    advice: ({ subject }) =>
      `Run \`npm install @prisma/client && npx prisma generate\` in the orangerail project${
        subject === undefined ? '' : ` so object "${subject}" can be read`
      }, then retry.`,
  },
  datasource_model_missing: {
    cause: 'the datasource client carries no such model',
    advice: ({ subject }) =>
      `The installed client was generated from a different schema than the one this ontology was scanned from${
        subject === undefined ? '' : `, and exposes nothing for object "${subject}"`
      }. Re-run \`npx prisma generate\`, then retry.`,
  },
  datasource_not_configured: {
    cause: 'the datasource is not configured, so the client could not connect',
    advice: () =>
      'Its connection URL is missing or unusable — for a Prisma project that is the DATABASE_URL ' +
      'environment variable, which must be set for the process running the orangerail server. ' +
      'Set it, then retry.',
  },
};

/**
 * Per status: the domain-level cause (WHERE in the lifecycle it broke — what
 * the agent needs to decide what to do next), the kind of error being withheld,
 * and the channel that holds it unless the call site knows better.
 */
const FAILURE: Record<FailureStatus, { cause: string; withheld: string; channel: FailureChannel }> =
  {
    failed: {
      cause: 'the datasource rejected the action',
      withheld: 'The datasource error',
      channel: 'audit-and-host-log',
    },
    resolve_error: {
      cause: 'the target could not be read from the datasource',
      withheld: 'The datasource error',
      channel: 'audit-and-host-log',
    },
    audit_blocked: {
      cause: 'the audit record could not be written, so nothing ran',
      withheld: 'The store error',
      channel: 'host-log',
    },
    internal_error: {
      cause: 'an unexpected internal error',
      withheld: 'The underlying error',
      channel: 'host-log',
    },
  };

const WHERE: Record<FailureChannel, string> = {
  'host-log': 'the host log',
  'audit-and-host-log': 'the audit log or host log',
};

/**
 * Build the agent-facing failure. The underlying text is never an input here —
 * the redaction cannot be defeated by a caller passing the raw string through,
 * because there is nowhere for it to go.
 *
 * `channel` overrides the per-status default for a call site that knows the
 * text has no audit home (a throwing read resolver).
 */
export const redactFailure = ({
  status,
  tool,
  correlationId,
  channel,
  diagnostic,
}: {
  status: FailureStatus;
  tool: string;
  correlationId: string;
  channel?: FailureChannel;
  /** The classification core attached, if it could make one. */
  diagnostic?: PublicDiagnostic;
}): RedactedFailure => {
  const failure = FAILURE[status];
  const classified = diagnostic === undefined ? undefined : DIAGNOSTIC[diagnostic.code];

  // A classified failure replaces the generic cause with the specific one and
  // adds the fix. The withholding clause stays either way: the underlying text
  // is still not here, and saying otherwise would be the dishonest version of
  // this feature.
  const cause = classified?.cause ?? failure.cause;
  const advice =
    classified === undefined
      ? ''
      : `${classified.advice({ ...(diagnostic?.subject === undefined ? {} : { subject: diagnostic.subject }) })} `;

  return {
    status,
    correlationId,
    // Keyed off `classified`, not off `diagnostic`: a code with no sentence in
    // the table above is a code this transport does not know, and echoing it
    // would put an unvetted string in front of the agent.
    ...(classified && diagnostic ? { diagnostic: diagnostic.code } : {}),
    message:
      `Tool "${tool}" failed: ${cause}. ${advice}${failure.withheld} is withheld; ` +
      `an operator can read it in ${WHERE[channel ?? failure.channel]} ` +
      `under correlationId "${correlationId}".`,
  };
};
