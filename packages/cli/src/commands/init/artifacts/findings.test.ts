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
