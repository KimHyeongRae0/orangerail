import { describe, expect, it } from 'vitest';

import { computeFindings } from './findings';
import { parseSlack, resolveSlackIdentity } from './slack';
import type { EmployeeMetric, IncidentInstance, Person, ServiceInstance } from './types';

const people: Person[] = [
  { accountId: 'acc_a', displayName: 'Ann A' },
  { accountId: 'acc_b', displayName: 'Bob B' },
];

const employee = ({
  accountId,
  storyPointsTotal,
  helpGiven,
}: {
  accountId: string;
  storyPointsTotal: number;
  helpGiven: number;
}): EmployeeMetric => ({
  accountId,
  displayName: accountId === 'acc_a' ? 'Ann A' : 'Bob B',
  active: true,
  ticketCount: 5,
  storyPointsTotal,
  complexityMix: { hi: 1, med: 2, lo: 2 },
  medianCycleDaysFirstHalf: 1,
  medianCycleDaysSecondHalf: 1,
  reopenRate: 0,
  reassignmentsGiven: 0,
  reassignmentsReceived: 0,
  helpGiven,
  helpReceived: 0,
  weekendOffHoursShare: 0,
});

const services: ServiceInstance[] = [
  {
    id: 'svc-a',
    name: 'svc-a',
    ticketCount: 6,
    distinctAssignees: 1,
    busFactor: 1,
    assignees: [{ accountId: 'acc_a', displayName: 'Ann A', count: 6 }],
  },
];

const incidents: IncidentInstance[] = [
  {
    id: 'INC-001',
    date: '2025-09-14',
    channel: 'incidents',
    threadTs: '1757880720.000100',
    leadResponderAccountId: 'acc_a',
    leadResponder: 'Ann A',
    hasTrackerIssue: false,
    participantAccountIds: ['acc_a'],
  },
];

const slackRaw = {
  users: [
    { id: 'U_A', name: 'ann', real_name: 'Ann A', is_bot: false },
    { id: 'U_B', name: 'bob', real_name: 'Bob B', is_bot: false },
  ],
  channels: [
    {
      id: 'C1',
      name: 'deploys',
      messages: [
        { ts: '100.1', user: 'U_A', text: 'release COM-10. <@U_B> approve?', thread_ts: '100.1' },
        { ts: '101.2', user: 'U_B', text: 'go for it', thread_ts: '100.1' },
        {
          ts: '900.9',
          user: 'U_A',
          text: 'deploying COM-99 to prod. shipped, no sign-off',
          thread_ts: '900.9',
        },
      ],
    },
  ],
};

describe('computeFindings', () => {
  const slack = parseSlack({ raw: slackRaw });
  const identity = resolveSlackIdentity({
    slack,
    jiraAccounts: new Map([
      ['acc_a', 'Ann A'],
      ['acc_b', 'Bob B'],
    ]),
  });

  const findings = computeFindings({
    employees: [
      employee({ accountId: 'acc_a', storyPointsTotal: 80, helpGiven: 1 }),
      employee({ accountId: 'acc_b', storyPointsTotal: 20, helpGiven: 5 }),
    ],
    services,
    incidents,
    helpGiven: new Map([
      ['acc_a', 1],
      ['acc_b', 5],
    ]),
    slack,
    identity,
    people,
    slackProvided: true,
  });

  it('emits the required finding categories', () => {
    const text = JSON.stringify(findings);
    for (const pattern of [
      /workload/i,
      /bus.?factor/i,
      /approval/i,
      /incident/i,
      /knowledge|help hub/i,
    ]) {
      expect(pattern.test(text)).toBe(true);
    }
  });

  it('gives every finding a non-empty evidence pointer', () => {
    for (const finding of findings) {
      expect(finding.pointer).toBeDefined();
      expect(JSON.stringify(finding.pointer).length).toBeGreaterThan(2);
    }
  });

  it('points the process-gap finding at the ticket-less incident thread', () => {
    const processGap = findings.find((f) => /process gap/i.test(f.title))!;
    expect(JSON.stringify(processGap.pointer)).toContain('1757880720.000100');
  });

  it('detects the deploy with no approval after the historical approver stops', () => {
    const vacuum = findings.find((f) => /approval/i.test(f.title))!;
    expect(JSON.stringify(vacuum.pointer)).toContain('COM-99');
  });
});

describe('computeFindings — Jira-only (no Slack export provided)', () => {
  const jiraOnly = computeFindings({
    employees: [
      employee({ accountId: 'acc_a', storyPointsTotal: 80, helpGiven: 0 }),
      employee({ accountId: 'acc_b', storyPointsTotal: 20, helpGiven: 0 }),
    ],
    services,
    incidents,
    helpGiven: new Map(),
    slack: parseSlack({ raw: { users: [], channels: [] } }),
    identity: { userToAccount: new Map(), diagnostics: [] },
    people,
    slackProvided: false,
  });

  it('marks the four Slack-dependent findings as "not evaluated - no Slack export"', () => {
    for (const id of [2, 3, 4, 6]) {
      const f = jiraOnly.find((x) => x.id === id)!;
      expect(f).toBeDefined();
      expect(/not evaluated/i.test(f.detail)).toBe(true);
      expect(/slack/i.test(f.detail)).toBe(true);
    }
  });

  it('never asserts a superlative over an unavailable/0 help value', () => {
    const text = JSON.stringify(jiraOnly);
    for (const phrase of ['top help-giver', 'help interactions total', 'helpGiven=0']) {
      expect(text.includes(phrase)).toBe(false);
    }
    expect(text.includes('NaN')).toBe(false);
  });

  it('still emits the Jira-only findings (workload, bus factor) when evidenced', () => {
    expect(jiraOnly.find((f) => f.id === 1)).toBeDefined();
    expect(jiraOnly.find((f) => f.id === 5)).toBeDefined();
  });

  it('drops evidence-free findings on an empty corpus', () => {
    const empty = computeFindings({
      employees: [],
      services: [],
      incidents: [],
      helpGiven: new Map(),
      slack: parseSlack({ raw: { users: [], channels: [] } }),
      identity: { userToAccount: new Map(), diagnostics: [] },
      people: [],
      slackProvided: false,
    });

    expect(empty.find((f) => f.id === 1)).toBeUndefined();
    expect(empty.find((f) => f.id === 5)).toBeUndefined();
  });

  it('drops the four Slack-dependent placeholders when the org is empty (ONT-013 D3)', () => {
    const empty = computeFindings({
      employees: [],
      services: [],
      incidents: [],
      helpGiven: new Map(),
      slack: parseSlack({ raw: { users: [], channels: [] } }),
      identity: { userToAccount: new Map(), diagnostics: [] },
      people: [],
      slackProvided: false,
    });

    expect(empty).toEqual([]);
    for (const id of [2, 3, 4, 6]) {
      expect(empty.find((f) => f.id === id)).toBeUndefined();
    }
  });
});

describe('computeFindings — ONT-013 D1 share clamp', () => {
  const clampEmployee = ({
    accountId,
    storyPointsTotal,
  }: {
    accountId: string;
    storyPointsTotal: number;
  }): EmployeeMetric => ({
    accountId,
    displayName: accountId,
    active: true,
    ticketCount: 5,
    storyPointsTotal,
    complexityMix: { hi: 1, med: 2, lo: 2 },
    medianCycleDaysFirstHalf: 1,
    medianCycleDaysSecondHalf: 1,
    reopenRate: 0,
    reassignmentsGiven: 0,
    reassignmentsReceived: 0,
    helpGiven: 0,
    helpReceived: 0,
    weekendOffHoursShare: 0,
  });

  it('clamps the workload share to <= 100 even if a stray negative total shrinks the denominator', () => {
    // A negative total on a non-top-2 employee makes top2 sum exceed the grand
    // total; the clamp keeps the rendered share <= 100 (defense-in-depth).
    const findings = computeFindings({
      employees: [
        clampEmployee({ accountId: 'acc_a', storyPointsTotal: 100 }),
        clampEmployee({ accountId: 'acc_b', storyPointsTotal: 20 }),
        clampEmployee({ accountId: 'acc_c', storyPointsTotal: -100 }),
      ],
      services: [],
      incidents: [],
      helpGiven: new Map(),
      slack: parseSlack({ raw: { users: [], channels: [] } }),
      identity: { userToAccount: new Map(), diagnostics: [] },
      people: [
        { accountId: 'acc_a', displayName: 'acc_a' },
        { accountId: 'acc_b', displayName: 'acc_b' },
        { accountId: 'acc_c', displayName: 'acc_c' },
      ],
      slackProvided: false,
    });

    const workload = findings.find((f) => f.id === 1)!;
    expect(workload).toBeDefined();
    expect((workload.pointer as { sharePct: number }).sharePct).toBeLessThanOrEqual(100);
  });
});
