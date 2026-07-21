import type { ApprovalRecord } from 'orangerail-core';

/**
 * Approval-deception defense (§3.5): staged input and requestedBy are
 * attacker-influenced text, and terminal escape sequences in them could forge
 * or hide approver-facing UI. Every agent-supplied string is stripped of ANSI
 * / control characters and then escaped via `JSON.stringify` before it reaches
 * a terminal.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Like {@link CONTROL_CHARS} but keeps `\n` (U+000A). Safe ONLY on
 * `JSON.stringify` output: the serializer already escapes every C0 inside
 * string values, so the sole surviving newlines are the pretty-printer's own
 * layout. C1 (incl. the 8-bit CSI U+009B) is NOT escaped by JSON.stringify
 * and stays stripped.
 */
const CONTROL_CHARS_KEEP_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

const stripControl = ({ value }: { value: string }): string => value.replace(CONTROL_CHARS, '');

/** Strip control/ANSI chars then JSON-escape an agent-supplied string. */
export const sanitize = ({ value }: { value: string }): string =>
  JSON.stringify(stripControl({ value }));

/** A one-line, length-capped preview of agent-supplied input (already escaped). */
export const previewInput = ({ input }: { input: unknown }): string => {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = String(input);
  }

  // JSON.stringify already escapes control/ANSI into safe \uXXXX; clip length.
  const clipped = json.length > 80 ? `${json.slice(0, 77)}...` : json;

  return stripControl({ value: clipped });
};

const formatAge = ({ createdAt }: { createdAt: string }): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }

  return `${Math.floor(seconds / 86400)}d`;
};

/**
 * Render the pending-approval queue as the approver decision surface (§3.5).
 * Anti-fatigue: only `pending` records, newest last, count in the footer, one
 * scannable line each. The full id is shown so the operator can approve it.
 */
export const renderApprovalList = ({ approvals }: { approvals: ApprovalRecord[] }): string => {
  if (approvals.length === 0) {
    return 'No pending approvals.\n';
  }

  const ordered = [...approvals].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const lines = ordered.map((record) => {
    const dev = record.devMode ? ' [dev]' : '';
    const by = sanitize({ value: record.requestedBy });
    const action = sanitize({ value: record.actionName });
    const age = formatAge({ createdAt: record.createdAt });
    const preview = previewInput({ input: record.input });

    return `${record.id}  ${action}  by ${by}${dev}  ${age} ago  input=${preview}`;
  });

  return `${lines.join('\n')}\n\n${ordered.length} pending approval(s).\n`;
};

/** Render one approval's full detail with pretty-printed, sanitized input. */
export const renderApprovalDetail = ({ record }: { record: ApprovalRecord }): string => {
  const prettyInput = JSON.stringify(record.input, null, 2).replace(CONTROL_CHARS_KEEP_NEWLINE, '');

  return [
    `id:           ${record.id}`,
    `action:       ${sanitize({ value: record.actionName })}`,
    `status:       ${record.status}`,
    `requestedBy:  ${sanitize({ value: record.requestedBy })}${record.devMode ? ' [dev]' : ''}`,
    `roles:        ${JSON.stringify(record.requestedByRoles)}`,
    `createdAt:    ${record.createdAt}`,
    `input (agent-supplied):`,
    prettyInput,
    '',
  ].join('\n');
};
