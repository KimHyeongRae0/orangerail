import { describe, expect, it } from 'vitest';

import { parseJira } from './jira';
import { computeMetrics } from './metrics';
import type { ParsedSlack, Person, SlackIdentity } from './types';

const emptySlack = (): ParsedSlack => ({ users: new Map(), messages: [], diagnostics: [] });
const noIdentity = (): SlackIdentity => ({ userToAccount: new Map(), diagnostics: [] });

const jiraWith = ({ issues }: { issues: unknown[] }): ReturnType<typeof parseJira> =>
  parseJira({ raw: { project: { key: 'COM' }, issues } });

const mkIssue = ({
  key,
  accountId,
  storyPoints,
  created,
  resolutiondate,
  changelog,
}: {
  key: string;
  accountId: string;
  storyPoints: number | null;
  created: string;
  resolutiondate?: string;
  changelog?: unknown;
}): Record<string, unknown> => ({
  key,
  fields: {
    issuetype: { name: 'Bug' },
    status: { name: 'Done' },
    assignee: { accountId, displayName: 'Person P' },
    reporter: { accountId, displayName: 'Person P' },
    customfield_10016: storyPoints,
    components: [{ name: 'svc' }],
    labels: ['svc'],
    created,
    ...(resolutiondate === undefined ? {} : { resolutiondate }),
  },
  ...(changelog === undefined ? {} : { changelog }),
});

describe('computeMetrics', () => {
  const people: Person[] = [{ accountId: 'acc_p', displayName: 'Person P' }];

  it('sums story points and bins the complexity mix (lo<=2, med=3, hi>=5)', () => {
    const jira = jiraWith({
      issues: [
        mkIssue({
          key: 'C1',
          accountId: 'acc_p',
          storyPoints: 2,
          created: '2025-05-01T10:00:00.000Z',
          changelog: { histories: [] },
        }),
        mkIssue({
          key: 'C2',
          accountId: 'acc_p',
          storyPoints: 3,
          created: '2025-05-01T10:00:00.000Z',
          changelog: { histories: [] },
        }),
        mkIssue({
          key: 'C3',
          accountId: 'acc_p',
          storyPoints: 8,
          created: '2025-05-01T10:00:00.000Z',
          changelog: { histories: [] },
        }),
      ],
    });

    const [p] = computeMetrics({ jira, slack: emptySlack(), identity: noIdentity(), people });

    expect(p!.storyPointsTotal).toBe(13);
    expect(p!.complexityMix).toEqual({ hi: 1, med: 1, lo: 1 });
    expect(p!.ticketCount).toBe(3);
  });

  it('degrades complexity to a single lo bucket when story points are absent corpus-wide', () => {
    const jira = jiraWith({
      issues: [
        mkIssue({
          key: 'C1',
          accountId: 'acc_p',
          storyPoints: null,
          created: '2025-05-01T10:00:00.000Z',
        }),
        mkIssue({
          key: 'C2',
          accountId: 'acc_p',
          storyPoints: null,
          created: '2025-05-01T10:00:00.000Z',
        }),
      ],
    });

    const [p] = computeMetrics({ jira, slack: emptySlack(), identity: noIdentity(), people });

    expect(p!.storyPointsTotal).toBe(0);
    expect(p!.complexityMix).toEqual({ hi: 0, med: 0, lo: 2 });
    expect(p!.complexityMix.lo).toBe(p!.ticketCount);
  });

  it('keeps the ONT-010 per-issue band behavior on a mixed corpus (some points present)', () => {
    const jira = jiraWith({
      issues: [
        mkIssue({
          key: 'C1',
          accountId: 'acc_p',
          storyPoints: 8,
          created: '2025-05-01T10:00:00.000Z',
        }),
        // Bug with no points falls back to the type band (med), not lo.
        mkIssue({
          key: 'C2',
          accountId: 'acc_p',
          storyPoints: null,
          created: '2025-05-01T10:00:00.000Z',
        }),
      ],
    });

    const [p] = computeMetrics({ jira, slack: emptySlack(), identity: noIdentity(), people });

    expect(p!.complexityMix).toEqual({ hi: 1, med: 1, lo: 0 });
  });

  it('reports "unavailable" (never 0) for reopen/reassignment without a changelog', () => {
    const jira = jiraWith({
      issues: [
        mkIssue({
          key: 'C1',
          accountId: 'acc_p',
          storyPoints: 3,
          created: '2025-05-01T10:00:00.000Z',
        }),
      ],
    });

    const [p] = computeMetrics({ jira, slack: emptySlack(), identity: noIdentity(), people });

    expect(p!.reopenRate).toBe('unavailable');
    expect(p!.reassignmentsReceived).toBe('unavailable');
    expect(p!.reassignmentsGiven).toBe('unavailable');
  });

  it('counts reassignments given to the from-person and received by the to-person', () => {
    const jira = jiraWith({
      issues: [
        mkIssue({
          key: 'C1',
          accountId: 'acc_to',
          storyPoints: 3,
          created: '2025-05-01T10:00:00.000Z',
          changelog: {
            histories: [{ items: [{ field: 'assignee', from: 'acc_from', to: 'acc_to' }] }],
          },
        }),
      ],
    });

    const metrics = computeMetrics({
      jira,
      slack: emptySlack(),
      identity: noIdentity(),
      people: [
        { accountId: 'acc_from', displayName: 'From F' },
        { accountId: 'acc_to', displayName: 'To T' },
      ],
    });

    const from = metrics.find((m) => m.accountId === 'acc_from')!;
    const to = metrics.find((m) => m.accountId === 'acc_to')!;
    expect(from.reassignmentsGiven).toBe(1);
    expect(to.reassignmentsReceived).toBe(1);
  });

  it('excludes an inverted (created after resolutiondate) cycle and keeps the median non-negative', () => {
    const jira = jiraWith({
      issues: [
        // Valid: created before resolved -> positive cycle.
        mkIssue({
          key: 'C1',
          accountId: 'acc_p',
          storyPoints: 3,
          created: '2025-05-01T10:00:00.000Z',
          resolutiondate: '2025-05-05T10:00:00.000Z',
        }),
        // Inverted: created AFTER resolved -> would be a negative cycle; excluded.
        mkIssue({
          key: 'C2',
          accountId: 'acc_p',
          storyPoints: 3,
          created: '2025-05-20T10:00:00.000Z',
          resolutiondate: '2025-05-10T10:00:00.000Z',
        }),
      ],
    });

    const [p] = computeMetrics({ jira, slack: emptySlack(), identity: noIdentity(), people });

    expect(p!.medianCycleDaysFirstHalf).toBeGreaterThanOrEqual(0);
    expect(p!.medianCycleDaysSecondHalf).toBeGreaterThanOrEqual(0);
  });

  it('keeps storyPointsTotal at 0 and degrades complexity when all points are invalid', () => {
    const jira = jiraWith({
      issues: [
        mkIssue({
          key: 'C1',
          accountId: 'acc_p',
          storyPoints: -5,
          created: '2025-05-01T10:00:00.000Z',
        }),
        mkIssue({
          key: 'C2',
          accountId: 'acc_p',
          storyPoints: -1,
          created: '2025-05-01T10:00:00.000Z',
        }),
      ],
    });

    const [p] = computeMetrics({ jira, slack: emptySlack(), identity: noIdentity(), people });

    expect(p!.storyPointsTotal).toBe(0);
    expect(p!.storyPointsTotal).toBeGreaterThanOrEqual(0);
    expect(p!.complexityMix).toEqual({ hi: 0, med: 0, lo: 2 });
    expect(p!.complexityMix.lo).toBe(p!.ticketCount);
  });

  it('produces byte-identical output on repeated runs (determinism)', () => {
    const issues = [
      mkIssue({
        key: 'C1',
        accountId: 'acc_p',
        storyPoints: 5,
        created: '2025-05-01T10:00:00.000Z',
        resolutiondate: '2025-05-05T10:00:00.000Z',
        changelog: { histories: [] },
      }),
    ];

    const one = computeMetrics({
      jira: jiraWith({ issues }),
      slack: emptySlack(),
      identity: noIdentity(),
      people,
    });
    const two = computeMetrics({
      jira: jiraWith({ issues }),
      slack: emptySlack(),
      identity: noIdentity(),
      people,
    });

    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});
