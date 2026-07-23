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

  it('marks storyPointsAvailable true when any issue carries numeric story points', () => {
    const parsed = parseJira({
      raw: { project: { key: 'COM' }, issues: [issue({ key: 'COM-1', storyPoints: 5 })] },
    });

    expect(parsed.storyPointsAvailable).toBe(true);
  });

  it('marks storyPointsAvailable false when every issue lacks story points', () => {
    const parsed = parseJira({
      raw: {
        project: { key: 'COM' },
        issues: [
          issue({ key: 'COM-1', storyPoints: null }),
          issue({ key: 'COM-2', storyPoints: null }),
        ],
      },
    });

    expect(parsed.storyPointsAvailable).toBe(false);
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

  it('parses a negative story point to null and does not set storyPointsAvailable', () => {
    const parsed = parseJira({
      raw: { project: { key: 'COM' }, issues: [issue({ key: 'COM-1', storyPoints: -5 })] },
    });

    expect(parsed.issues[0]!.storyPoints).toBeNull();
    expect(parsed.storyPointsAvailable).toBe(false);
  });

  it('parses a non-finite story point (NaN/Infinity) to null and does not set storyPointsAvailable', () => {
    const parsed = parseJira({
      raw: {
        project: { key: 'COM' },
        issues: [
          issue({ key: 'COM-1', storyPoints: Number.POSITIVE_INFINITY }),
          issue({ key: 'COM-2', storyPoints: Number.NaN }),
        ],
      },
    });

    expect(parsed.issues[0]!.storyPoints).toBeNull();
    expect(parsed.issues[1]!.storyPoints).toBeNull();
    expect(parsed.storyPointsAvailable).toBe(false);
  });

  it('accepts a valid non-negative story point (including 0) and sets storyPointsAvailable', () => {
    const parsed = parseJira({
      raw: {
        project: { key: 'COM' },
        issues: [issue({ key: 'COM-1', storyPoints: 0 }), issue({ key: 'COM-2', storyPoints: 8 })],
      },
    });

    expect(parsed.issues[0]!.storyPoints).toBe(0);
    expect(parsed.issues[1]!.storyPoints).toBe(8);
    expect(parsed.storyPointsAvailable).toBe(true);
  });

  it('pushes an aggregate diagnostic counting invalid story-point values', () => {
    const parsed = parseJira({
      raw: {
        project: { key: 'COM' },
        issues: [
          issue({ key: 'COM-1', storyPoints: -5 }),
          issue({ key: 'COM-2', storyPoints: -1 }),
          issue({ key: 'COM-3', storyPoints: 3 }),
        ],
      },
    });

    const diagnostic = parsed.diagnostics.find((d) => d.includes('invalid story-point value'));
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toContain('2');
    expect(diagnostic).toContain('customfield_10016');
  });

  it('pushes an aggregate diagnostic counting inverted created/resolutiondate pairs', () => {
    const inverted = ({ key }: { key: string }): Record<string, unknown> => ({
      key,
      fields: {
        issuetype: { name: 'Bug' },
        summary: 'x',
        status: { name: 'Done' },
        assignee: { accountId: 'acc_a', displayName: 'Ann A' },
        reporter: { accountId: 'acc_r', displayName: 'Rep Orter' },
        customfield_10016: 3,
        components: [{ name: 'svc-a' }],
        labels: ['svc-a'],
        created: '2025-05-05T10:00:00.000Z',
        resolutiondate: '2025-05-01T10:00:00.000Z',
      },
    });

    const parsed = parseJira({
      raw: { project: { key: 'COM' }, issues: [inverted({ key: 'COM-1' })] },
    });

    const diagnostic = parsed.diagnostics.find((d) =>
      d.includes('from cycle-time stats (created after resolutiondate)'),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toContain('1');
  });

  it('pushes no data-quality diagnostic on well-formed input', () => {
    const parsed = parseJira({
      raw: {
        project: { key: 'COM' },
        issues: [issue({ key: 'COM-1', storyPoints: 3 })],
      },
    });

    expect(parsed.diagnostics.some((d) => d.includes('invalid story-point value'))).toBe(false);
    expect(parsed.diagnostics.some((d) => d.includes('from cycle-time stats'))).toBe(false);
  });
});
