import type { ApprovalRecord, AuditPrior } from 'orangerail-core';

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

/**
 * Bidi and invisible-formatting code points. None of them is a control
 * character and `JSON.stringify` escapes none of them, so before this they went
 * straight past {@link CONTROL_CHARS} into the approver's terminal. A lone
 * U+202E in `requestedBy` reverses the rendering of everything after it on the
 * line in any bidi-aware terminal (iTerm2, VS Code, GNOME Terminal), so a staged
 * `DROP TABLE orders` can be made to read as innocuous text and one agent can
 * wear another agent's name. That is the Trojan Source class (CVE-2021-42574),
 * aimed at exactly the surface this file exists to defend.
 *
 * The set is "renders as nothing, or changes how its neighbours render":
 *   U+00AD            soft hyphen
 *   U+061C            Arabic letter mark (a bidi control)
 *   U+180E            Mongolian vowel separator
 *   U+200B-U+200F     zero-width space / non-joiner / joiner, LRM, RLM
 *   U+202A-U+202E     LRE, RLE, PDF, LRO, RLO (embeddings and overrides)
 *   U+2028, U+2029    line / paragraph separator (line breaks JSON leaves raw)
 *   U+2060-U+206F     word joiner, invisible operators, the U+2066-U+2069
 *                     isolates, and the deprecated format controls
 *   U+FEFF            zero-width no-break space / BOM
 *   U+FFF9-U+FFFB     interlinear annotation anchors
 *   U+E0000-U+E007F   TAG characters (the ASCII-smuggling block)
 */
const BIDI_AND_INVISIBLE_CHARS =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/gu;

/**
 * Render one code point as its JSON `\uXXXX` form, emitting a surrogate pair
 * above the BMP so the result is always plain ASCII.
 */
const uEscape = ({ codePoint }: { codePoint: number }): string => {
  const unit = ({ value }: { value: number }): string =>
    `\\u${value.toString(16).padStart(4, '0')}`;

  if (codePoint <= 0xffff) {
    return unit({ value: codePoint });
  }

  const offset = codePoint - 0x10000;

  return `${unit({ value: 0xd800 + (offset >> 10) })}${unit({ value: 0xdc00 + (offset & 0x3ff) })}`;
};

/**
 * Replace every bidi/invisible code point with a visible `\uXXXX`. Escaped
 * rather than deleted on purpose: deleting would render a hostile string as a
 * clean one, and the approver would never learn that something unusual was in
 * what they are about to approve.
 */
const escapeInvisible = ({ value }: { value: string }): string =>
  value.replace(BIDI_AND_INVISIBLE_CHARS, (match) =>
    uEscape({ codePoint: match.codePointAt(0) ?? 0 }),
  );

const stripControl = ({ value }: { value: string }): string => value.replace(CONTROL_CHARS, '');

/** Strip control/ANSI chars then JSON-escape an agent-supplied string. */
export const sanitize = ({ value }: { value: string }): string =>
  escapeInvisible({ value: JSON.stringify(stripControl({ value })) });

/** A one-line, length-capped preview of agent-supplied input (already escaped). */
export const previewInput = ({ input }: { input: unknown }): string => {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = String(input);
  }

  // JSON.stringify already escapes control/ANSI into safe \uXXXX, but not the
  // bidi/invisible set. Neutralize BEFORE clipping, so the 80-char cap measures
  // what the terminal will actually show rather than the pre-escape length.
  const safe = escapeInvisible({ value: stripControl({ value: json }) });

  return safe.length > 80 ? `${safe.slice(0, 77)}...` : safe;
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
    // ONT-058: a record with no `inputHash` cannot execute, so it is not really
    // a decision waiting on a human — it is a queue entry that will consume
    // itself. Marked here so an operator does not spend attention on it, and
    // above all does not read the queue draining as work getting done.
    const stale = record.inputHash === undefined ? ' [UNEXECUTABLE]' : '';
    const by = sanitize({ value: record.requestedBy });
    const action = sanitize({ value: record.actionName });
    const age = formatAge({ createdAt: record.createdAt });
    const preview = previewInput({ input: record.input });

    return `${record.id}  ${action}  by ${by}${dev}${stale}  ${age} ago  input=${preview}`;
  });

  const staleCount = ordered.filter((record) => record.inputHash === undefined).length;
  const note =
    staleCount === 0
      ? ''
      : `\n${staleCount} of them cannot execute: created by an older orangerail-core, so approving them writes\nnothing. Run \`orangerail status\`, align the versions, and re-stage.\n`;

  return `${lines.join('\n')}\n\n${ordered.length} pending approval(s).\n${note}`;
};

/**
 * How much staged input `approvals show` prints before it truncates. This is the
 * view the operator is supposed to READ before deciding, so the decision context
 * above it (id / action / status / requestedBy) has to stay on screen: a 1 MB
 * string pretty-prints to ~13,000 wrapped lines and pushes all of it out of a
 * default scrollback, leaving the approver deciding on a wall of one character.
 * Both caps apply; whichever is reached first wins.
 */
const MAX_DETAIL_INPUT_LINES = 40;
const MAX_DETAIL_INPUT_CHARS = 2000;

/**
 * Cap the pretty-printed input, stating exactly how much was withheld and the
 * command that prints all of it. The notice also says the block is no longer
 * valid JSON, so a truncated value can never be mistaken for the whole one.
 */
const capDetailInput = ({
  pretty,
  id,
  label = 'input',
}: {
  pretty: string;
  id: string;
  /** What the block holds, so the notice names the right thing (input / target row). */
  label?: string;
}): string => {
  const lines = pretty.split('\n');

  if (lines.length <= MAX_DETAIL_INPUT_LINES && pretty.length <= MAX_DETAIL_INPUT_CHARS) {
    return pretty;
  }

  const byLines = lines.slice(0, MAX_DETAIL_INPUT_LINES).join('\n');
  const shown = byLines.slice(0, MAX_DETAIL_INPUT_CHARS);

  return [
    shown,
    `  … TRUNCATED — showing ${shown.length} of ${pretty.length} character(s), ${shown.split('\n').length} of ${lines.length} line(s).`,
    `    This block is cut mid-value and is NOT the whole ${label}. Print it in full with:`,
    `      orangerail approvals show ${id} --full`,
  ].join('\n');
};

/** Pretty-print a value the way the input block does: sanitized and capped. */
const prettyBlock = ({
  value,
  id,
  full,
  label = 'input',
}: {
  value: unknown;
  id: string;
  full: boolean;
  label?: string;
}): string => {
  const pretty = escapeInvisible({
    value: JSON.stringify(value, null, 2).replace(CONTROL_CHARS_KEEP_NEWLINE, ''),
  });

  return full ? pretty : capDetailInput({ pretty, id, label });
};

/**
 * The `target` block of `approvals show` — what the row this write is aimed at
 * looks like RIGHT NOW (§3.11 / ONT-057).
 *
 * The reason it is here: an approver reading `{"id":"p3","stock":25}` is being
 * asked to authorize a change and shown only one side of it. `stock: 25` is a
 * correction or a catastrophe depending on whether the row currently says `0`
 * or `24`, and until now the decision surface had no opinion about that.
 *
 * The heading says "read now" because that is the honest claim and the
 * distinction matters: this is a live read at display time, NOT the `prior`
 * recorded on the audit chain, which is read at execution time and is the value
 * a recovery works from. Between this screen and the approval the row can move.
 * It is masked by the same `maskAuditPrior` policy the chain uses, so the safer
 * surface is never the one that leaks.
 */
const priorLines = ({
  prior,
  id,
  full,
}: {
  prior: AuditPrior;
  id: string;
  full: boolean;
}): string[] => {
  switch (prior.state) {
    case 'value':
      return [
        'target (current state, read now):',
        prettyBlock({ value: prior.value, id, full, label: 'target row' }),
      ];
    case 'none':
      return ['target (current state, read now):', '  NONE — no such object right now.'];
    case 'unreadable':
      return [
        'target (current state, read now):',
        `  COULD NOT READ — ${sanitize({ value: prior.error })}`,
      ];
    case 'withheld':
      return [
        'target (current state, read now):',
        '  WITHHELD — audit redaction is configured and no redactPrior handles this row.',
      ];
    case 'unavailable':
      return prior.reason === 'no_id'
        ? [
            'target (current state, read now):',
            '  UNAVAILABLE — the staged input carries no value at the target id field.',
          ]
        : [
            'target (current state, read now):',
            '  UNAVAILABLE — this action declares no target object with a read contract.',
          ];
  }
};

/**
 * The line `approvals show` prints for a record with no `inputHash` (ONT-058).
 *
 * This is the one thing about an approval that decides whether deciding on it
 * is worth anything, and it was invisible: an operator read the id, the action,
 * the status and the payload, approved it, and watched execution consume the
 * approval and do nothing. Nothing on this surface said the record could never
 * run. It says so now, before the decision rather than after it.
 *
 * Empty for every record a current core created, so the detail view is
 * unchanged in the ordinary case.
 */
const unverifiableLine = ({ record }: { record: ApprovalRecord }): string[] =>
  record.inputHash === undefined
    ? [
        'binding:      NONE — this approval carries no inputHash, so its payload cannot be bound',
        '              to it and execution will refuse (`invalidated (stale_approval)`), spending',
        '              the approval without writing anything. It was created by an orangerail-core',
        '              older than the one running. Approving it changes nothing; re-stage the',
        '              action once the versions agree. Run `orangerail status` for the diagnosis.',
      ]
    : [];

/**
 * Render one approval's full detail with pretty-printed, sanitized input.
 * `full` lifts the length cap for an operator who has decided they want the
 * whole value. `prior` is optional: a caller that could not (or chose not to)
 * read the target omits the block entirely rather than printing a guess.
 */
export const renderApprovalDetail = ({
  record,
  full = false,
  prior,
}: {
  record: ApprovalRecord;
  full?: boolean;
  prior?: AuditPrior | undefined;
}): string => {
  return [
    `id:           ${record.id}`,
    `action:       ${sanitize({ value: record.actionName })}`,
    `status:       ${record.status}`,
    `requestedBy:  ${sanitize({ value: record.requestedBy })}${record.devMode ? ' [dev]' : ''}`,
    `roles:        ${JSON.stringify(record.requestedByRoles)}`,
    `createdAt:    ${record.createdAt}`,
    // Order matters. `unverifiableLine` (ONT-058) says this approval cannot
    // execute at all; the target block (ONT-057) describes what it would change.
    // A reader who is about to be told the decision is moot should be told that
    // before being handed a row to reason about.
    ...unverifiableLine({ record }),
    ...(prior === undefined ? [] : priorLines({ prior, id: record.id, full })),
    `input (agent-supplied):`,
    prettyBlock({ value: record.input, id: record.id, full }),
    '',
  ].join('\n');
};
