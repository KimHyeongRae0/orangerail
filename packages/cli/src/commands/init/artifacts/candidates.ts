import type { Candidate, ParsedSlack, SlackIdentity } from './types';

/**
 * Layer-2 lexical candidates (plan Step 6). Text pattern matching over message
 * bodies emits ONLY evidence-linked `Candidate` records — each carries the
 * matched span plus a source pointer (channel + ts). A candidate is never a
 * verdict about a person: the type has no boolean/score field. A message that
 * matches no pattern yields no record. These candidates are surfaced as
 * evidence for a human to read, never as a conclusion the scanner draws.
 */

const PATTERNS: { kind: Candidate['kind']; re: RegExp }[] = [
  { kind: 'approval', re: /\b(approv\w*|lgtm|go for it|green light|ship it|ok to ship)\b/i },
  { kind: 'reassign', re: /\b(reassign\w*|handing (this|it) (over|off)|taking over)\b/i },
  { kind: 'thanks', re: /(thank\w*|🙏|🙌)/i },
];

/** The character window kept around a match as the evidence span. */
const SPAN_LIMIT = 160;

/** Extract layer-2 candidates from every Slack message that matches a pattern. */
export const extractCandidates = ({
  slack,
  identity,
}: {
  slack: ParsedSlack;
  identity: SlackIdentity;
}): Candidate[] => {
  const candidates: Candidate[] = [];

  for (const message of slack.messages) {
    const authorAccountId = identity.userToAccount.get(message.userId) ?? null;

    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(message.text);
      if (match === null) {
        continue;
      }

      candidates.push({
        kind: pattern.kind,
        authorAccountId,
        matchedSpan: message.text.slice(0, SPAN_LIMIT),
        source: { channel: message.channel, ts: message.ts },
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.source.channel.localeCompare(b.source.channel) ||
      a.source.ts.localeCompare(b.source.ts) ||
      a.kind.localeCompare(b.kind),
  );

  return candidates;
};
