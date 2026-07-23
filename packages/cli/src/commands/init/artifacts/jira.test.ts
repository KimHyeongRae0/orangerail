import { describe, expect, it } from 'vitest';

import { parseJira } from './jira';

const issue = ({
  key,
  assignee,
  reporter,
  storyPoints,
  changelog,
}: {
  key: string;
  assignee?: { accountId: string; displayName: string } | null;
  reporter?: { accountId: string; displayName: string };
  storyPoints?: number | null;
  changelog?: unknown;
}): Record<string, unknown> => ({
  key,
  fields: {
    issuetype: { name: 'Bug' },
    summary: 'x',
    status: { name: 'Done' },
    assignee: assignee ?? null,
    reporter: reporter ?? { accountId: 'acc_r', displayName: 'Rep Orter' },
    customfield_10016: storyPoints === undefined ? 3 : storyPoints,
    components: [{ name: 'svc-a' }],
    labels: ['svc-a'],
    created: '2025-05-01T10:00:00.000Z',
    resolutiondate: '2025-05-03T10:00:00.000Z',
  },
  ...(changelog === undefined ? {} : { changelog }),
});

describe('parseJira', () => {
  it('collects assignee and reporter accounts by id, not by name', () => {
    const parsed = parseJira({
      raw: {
        project: { key: 'COM', name: 'Commerce' },
        issues: [
          issue({
            key: 'COM-1',
            assignee: { accountId: 'acc_a', displayName: 'Ann A' },
            reporter: { accountId: 'acc_b', displayName: 'Bob B' },
            changelog: { histories: [] },
          }),
        ],
      },
    });

    expect(parsed.projectKey).toBe('COM');
    expect(parsed.accounts.get('acc_a')).toBe('Ann A');
    expect(parsed.accounts.get('acc_b')).toBe('Bob B');
    expect(parsed.changelogAvailable).toBe(true);
  });

  it('marks changelogAvailable false when no issue carries a changelog', () => {
    const parsed = parseJira({
      raw: { project: { key: 'COM' }, issues: [issue({ key: 'COM-1' })] },
    });

    expect(parsed.changelogAvailable).toBe(false);
  });

  it('extracts status transitions and assignee changes from the changelog', () => {
    const parsed = parseJira({
      raw: {
        project: { key: 'COM' },
        issues: [
          issue({
            key: 'COM-1',
            assignee: { accountId: 'acc_a', displayName: 'Ann A' },
            changelog: {
              histories: [
                {
                  items: [
                    { field: 'status', fromString: 'Done', toString: 'Reopened' },
                    { field: 'assignee', from: 'acc_a', to: 'acc_b' },
                  ],
                },
              ],
            },
          }),
        ],
      },
    });

    const [only] = parsed.issues;
    expect(only!.statusTransitions).toEqual(['Reopened']);
    expect(only!.assigneeChanges).toEqual([{ from: 'acc_a', to: 'acc_b' }]);
  });

  it('does not attribute an unassigned issue to any account', () => {
    const parsed = parseJira({
      raw: {
        project: { key: 'COM' },
        issues: [issue({ key: 'COM-1', assignee: null })],
      },
    });

    expect(parsed.issues[0]!.assigneeId).toBeNull();
  });
});
