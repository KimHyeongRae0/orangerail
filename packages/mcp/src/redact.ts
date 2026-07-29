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
 */

/** The failure statuses whose detail may carry raw datasource/driver text. */
export type FailureStatus = 'failed' | 'resolve_error' | 'audit_blocked' | 'internal_error';

/** The agent-facing shape of a redacted failure. */
export interface RedactedFailure {
  status: FailureStatus;
  message: string;
  correlationId: string;
}

/**
 * The domain-level cause per status — what the agent needs to decide what to do
 * next. Each says WHERE in the lifecycle the failure happened, which is the
 * useful part; the driver's own wording is the leaking part.
 */
const CAUSE: Record<FailureStatus, string> = {
  failed: 'the action ran and the datasource rejected it',
  resolve_error: 'the action target could not be read from the datasource',
  audit_blocked: 'the audit record could not be written, so nothing was executed',
  internal_error: 'the server hit an unexpected internal error',
};

/**
 * Build the agent-facing failure. The underlying text is never an input here —
 * the redaction cannot be defeated by a caller passing the raw string through,
 * because there is nowhere for it to go.
 */
export const redactFailure = ({
  status,
  tool,
  correlationId,
}: {
  status: FailureStatus;
  tool: string;
  correlationId: string;
}): RedactedFailure => ({
  status,
  correlationId,
  message:
    `Tool "${tool}" failed: ${CAUSE[status]}. ` +
    'The underlying datasource error is withheld from this response; an operator ' +
    `can read it from the host log or the audit record for correlationId "${correlationId}".`,
});
