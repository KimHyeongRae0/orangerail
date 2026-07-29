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
 */

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
}

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
}: {
  status: FailureStatus;
  tool: string;
  correlationId: string;
  channel?: FailureChannel;
}): RedactedFailure => {
  const failure = FAILURE[status];

  return {
    status,
    correlationId,
    message:
      `Tool "${tool}" failed: ${failure.cause}. ${failure.withheld} is withheld; ` +
      `an operator can read it in ${WHERE[channel ?? failure.channel]} ` +
      `under correlationId "${correlationId}".`,
  };
};
