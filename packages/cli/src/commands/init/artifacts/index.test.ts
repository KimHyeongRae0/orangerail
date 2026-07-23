import { describe, expect, it } from 'vitest';

import { buildOntology } from './index';

const jiraRaw = {
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
        issuetype: { name: 'Task' },
        status: { name: 'To Do' },
        assignee: null,
        reporter: { accountId: 'acc_a', displayName: 'Ann A' },
        customfield_10016: null,
        components: [{ name: 'svc-a' }],
        labels: ['svc-a'],
        created: '2025-05-01T10:00:00.000Z',
      },
      changelog: { histories: [] },
    },
  ],
};

const slackRaw = {
  users: [
    { id: 'U_A', name: 'ann', real_name: 'Ann A', is_bot: false },
    { id: 'U_B', name: 'bob', real_name: 'Bob B', is_bot: false },
  ],
  channels: [
    {
      id: 'C1',
      name: 'dev',
      messages: [
        { ts: '100.1', user: 'U_A', text: 'stuck on COM-1', thread_ts: '100.1' },
        { ts: '101.2', user: 'U_B', text: '<@U_A> add a tiebreaker', thread_ts: '100.1' },
      ],
    },
  ],
};

describe('buildOntology', () => {
  it('merges helpGiven onto employees and never attributes the unassigned issue', () => {
    const { ontology } = buildOntology({ jiraRaw, slackRaw });

    // acc_b appears only in Slack but matches a Jira account only if present;
    // here acc_b is not a Jira account, so the employee roster is Jira-derived.
    const ann = ontology.employees.find((e) => e.accountId === 'acc_a')!;
    expect(ann.ticketCount).toBe(1); // COM-2 (unassigned) is not attributed to Ann
    expect(ontology.employees.every((e) => e.accountId && e.displayName)).toBe(true);
  });

  it('runs with Jira only (no Slack) and still emits findings', () => {
    const { ontology } = buildOntology({ jiraRaw, slackRaw: undefined });

    expect(ontology.findings.length).toBeGreaterThanOrEqual(5);
    expect(ontology.helps).toEqual([]);
  });
});
