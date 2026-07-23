import { describe, expect, it } from 'vitest';

import { computeGraph } from './graph';
import { parseJira } from './jira';
import { parseSlack, resolveSlackIdentity } from './slack';
import type { Person } from './types';

const people: Person[] = [
  { accountId: 'acc_a', displayName: 'Ann A' },
  { accountId: 'acc_b', displayName: 'Bob B' },
];

const jira = parseJira({
  raw: {
    project: { key: 'COM', name: 'Commerce' },
    issues: [
      {
        key: 'COM-1',
        fields: {
          issuetype: { name: 'Bug' },
          status: { name: 'Done' },
          assignee: { accountId: 'acc_a', displayName: 'Ann A' },
          reporter: { accountId: 'acc_a', displayName: 'Ann A' },
          customfield_10016: 3,
          components: [{ name: 'svc-a' }],
          labels: ['svc-a'],
          created: '2025-05-01T10:00:00.000Z',
          resolutiondate: '2025-05-02T10:00:00.000Z',
        },
        changelog: { histories: [] },
      },
      {
        key: 'COM-2',
        fields: {
          issuetype: { name: 'Bug' },
          status: { name: 'Done' },
          assignee: { accountId: 'acc_b', displayName: 'Bob B' },
          reporter: { accountId: 'acc_b', displayName: 'Bob B' },
          customfield_10016: 3,
          components: [{ name: 'svc-b' }],
          labels: ['svc-b'],
          created: '2025-05-01T10:00:00.000Z',
          resolutiondate: '2025-05-02T10:00:00.000Z',
        },
        changelog: { histories: [] },
      },
    ],
  },
});

const buildSlack = ({ messages }: { messages: unknown[] }) => {
  const raw = {
    users: [
      { id: 'U_A', name: 'ann', real_name: 'Ann A', is_bot: false },
      { id: 'U_B', name: 'bob', real_name: 'Bob B', is_bot: false },
    ],
    channels: [{ id: 'C1', name: 'dev', messages }],
  };
  const slack = parseSlack({ raw });
  const identity = resolveSlackIdentity({ slack, jiraAccounts: jira.accounts });
  return { slack, identity };
};

describe('computeGraph help edges', () => {
  it('credits a replier who @mentions in another author thread', () => {
    const { slack, identity } = buildSlack({
      messages: [
        { ts: '100.1', user: 'U_A', text: 'stuck on COM-1', thread_ts: '100.1' },
        { ts: '101.2', user: 'U_B', text: '<@U_A> try a tiebreaker', thread_ts: '100.1' },
      ],
    });

    const graph = computeGraph({ jira, slack, identity, people });
    expect(graph.helpGiven.get('acc_b')).toBe(1);
    expect(graph.helpReceived.get('acc_a')).toBe(1);
    expect(graph.helps).toEqual([{ from: 'acc_b', to: 'acc_a', weight: 1 }]);
  });

  it('credits a replier who is thanked later in the thread', () => {
    const { slack, identity } = buildSlack({
      messages: [
        { ts: '100.1', user: 'U_A', text: 'how do I scope this', thread_ts: '100.1' },
        { ts: '101.2', user: 'U_B', text: 'vertical slices', thread_ts: '100.1' },
        { ts: '102.3', user: 'U_A', text: 'thanks, that helps', thread_ts: '100.1' },
      ],
    });

    const graph = computeGraph({ jira, slack, identity, people });
    expect(graph.helpGiven.get('acc_b')).toBe(1);
  });

  it('does NOT credit a bare reply with no mention and no thanks', () => {
    const { slack, identity } = buildSlack({
      messages: [
        { ts: '100.1', user: 'U_A', text: 'COM-1 done', thread_ts: '100.1' },
        { ts: '101.2', user: 'U_B', text: 'lgtm from a glance', thread_ts: '100.1' },
      ],
    });

    const graph = computeGraph({ jira, slack, identity, people });
    expect(graph.helpGiven.get('acc_b')).toBeUndefined();
  });
});

describe('computeGraph structural edges', () => {
  it('derives works_on touch counts and member_of edges by accountId', () => {
    const { slack, identity } = buildSlack({ messages: [] });
    const graph = computeGraph({ jira, slack, identity, people });

    expect(graph.worksOn).toContainEqual({ from: 'acc_a', to: 'svc-a', weight: 1 });
    expect(graph.memberOf.every((e) => e.to === 'com')).toBe(true);
  });
});
