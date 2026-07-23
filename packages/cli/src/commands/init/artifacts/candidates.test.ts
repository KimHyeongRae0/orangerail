import { describe, expect, it } from 'vitest';

import { extractCandidates } from './candidates';
import { parseSlack, resolveSlackIdentity } from './slack';

const build = ({ messages }: { messages: unknown[] }) => {
  const raw = {
    users: [{ id: 'U_A', name: 'ann', real_name: 'Ann A', is_bot: false }],
    channels: [{ id: 'C1', name: 'deploys', messages }],
  };
  const slack = parseSlack({ raw });
  const identity = resolveSlackIdentity({ slack, jiraAccounts: new Map([['acc_a', 'Ann A']]) });
  return { slack, identity };
};

describe('extractCandidates', () => {
  it('emits evidence-linked records with a matched span and a source pointer', () => {
    const { slack, identity } = build({
      messages: [{ ts: '100.1', user: 'U_A', text: 'approved, ship it' }],
    });

    const candidates = extractCandidates({ slack, identity });
    const approval = candidates.find((c) => c.kind === 'approval')!;

    expect(approval.matchedSpan).toContain('approved');
    expect(approval.source).toEqual({ channel: 'deploys', ts: '100.1' });
  });

  it('never emits a per-person boolean/score field (candidate != verdict)', () => {
    const { slack, identity } = build({
      messages: [{ ts: '100.1', user: 'U_A', text: 'thanks for the help 🙏' }],
    });

    const candidates = extractCandidates({ slack, identity });

    for (const candidate of candidates) {
      expect(Object.keys(candidate).sort()).toEqual(
        ['authorAccountId', 'kind', 'matchedSpan', 'source'].sort(),
      );
      for (const value of Object.values(candidate)) {
        expect(typeof value).not.toBe('boolean');
        expect(typeof value === 'number').toBe(false);
      }
    }
  });

  it('yields no record for a message that matches no pattern', () => {
    const { slack, identity } = build({
      messages: [{ ts: '100.1', user: 'U_A', text: 'standup moved 30 min' }],
    });

    expect(extractCandidates({ slack, identity })).toEqual([]);
  });
});
