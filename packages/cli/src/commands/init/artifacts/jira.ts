import type { JiraIssue, ParsedJira } from './types';

/**
 * Pure parser for a Jira Cloud export of shape `{ project, issues[] }` where
 * each issue carries `fields` (assignee/reporter accounts, `customfield_10016`
 * story points, components, labels, created/resolutiondate) and an optional
 * `changelog.histories[]` of status and assignee transitions (plan Step 2). No
 * text is interpreted here — only structured fields are read. Unrecognized
 * records are skipped with a counted diagnostic rather than crashing.
 */

/** Read an account object into an { id, name } pair, tolerating null/absent. */
const readAccount = ({
  account,
}: {
  account: unknown;
}): { id: string | null; name: string | null } => {
  if (account === null || typeof account !== 'object') {
    return { id: null, name: null };
  }

  const record = account as Record<string, unknown>;
  const id = typeof record['accountId'] === 'string' ? record['accountId'] : null;
  const name = typeof record['displayName'] === 'string' ? record['displayName'] : null;

  return { id, name };
};

/** Read a `components`/`labels`-style array of `{ name }` (or strings). */
const readNames = ({ value }: { value: unknown }): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (entry !== null && typeof entry === 'object') {
      const name = (entry as Record<string, unknown>)['name'];
      if (typeof name === 'string') {
        out.push(name);
      }
    }
  }

  return out;
};

/** Parse the raw Jira export JSON into normalized issues + identity accounts. */
export const parseJira = ({ raw }: { raw: unknown }): ParsedJira => {
  const diagnostics: string[] = [];
  const accounts = new Map<string, string>();

  const root = (raw ?? {}) as Record<string, unknown>;
  const project = (root['project'] ?? {}) as Record<string, unknown>;
  const projectKey = typeof project['key'] === 'string' ? project['key'] : 'PROJ';
  const projectName = typeof project['name'] === 'string' ? project['name'] : projectKey;

  const rawIssues = Array.isArray(root['issues']) ? root['issues'] : [];
  let changelogAvailable = false;
  const issues: JiraIssue[] = [];

  for (const rawIssue of rawIssues) {
    if (rawIssue === null || typeof rawIssue !== 'object') {
      diagnostics.push('skipped a non-object issue record');
      continue;
    }

    const issue = rawIssue as Record<string, unknown>;
    const key = typeof issue['key'] === 'string' ? issue['key'] : null;
    const fields = (issue['fields'] ?? {}) as Record<string, unknown>;

    if (key === null) {
      diagnostics.push('skipped an issue with no key');
      continue;
    }

    const assignee = readAccount({ account: fields['assignee'] });
    const reporter = readAccount({ account: fields['reporter'] });

    if (assignee.id !== null && assignee.name !== null) {
      accounts.set(assignee.id, assignee.name);
    }
    if (reporter.id !== null && reporter.name !== null) {
      accounts.set(reporter.id, reporter.name);
    }

    const storyPoints =
      typeof fields['customfield_10016'] === 'number' ? fields['customfield_10016'] : null;
    const issuetype = ((fields['issuetype'] ?? {}) as Record<string, unknown>)['name'];
    const status = ((fields['status'] ?? {}) as Record<string, unknown>)['name'];

    const statusTransitions: string[] = [];
    const assigneeChanges: { from: string | null; to: string | null }[] = [];

    const hasChangelog = 'changelog' in issue && issue['changelog'] !== undefined;
    if (hasChangelog) {
      changelogAvailable = true;
      const changelog = (issue['changelog'] ?? {}) as Record<string, unknown>;
      const histories = Array.isArray(changelog['histories']) ? changelog['histories'] : [];

      for (const history of histories) {
        const items = Array.isArray((history as Record<string, unknown>)?.['items'])
          ? ((history as Record<string, unknown>)['items'] as unknown[])
          : [];

        for (const rawItem of items) {
          const item = (rawItem ?? {}) as Record<string, unknown>;
          if (item['field'] === 'status') {
            statusTransitions.push(typeof item['toString'] === 'string' ? item['toString'] : '');
          } else if (item['field'] === 'assignee') {
            assigneeChanges.push({
              from: typeof item['from'] === 'string' ? item['from'] : null,
              to: typeof item['to'] === 'string' ? item['to'] : null,
            });
          }
        }
      }
    }

    issues.push({
      key,
      issuetype: typeof issuetype === 'string' ? issuetype : 'Task',
      summary: typeof fields['summary'] === 'string' ? fields['summary'] : '',
      status: typeof status === 'string' ? status : '',
      assigneeId: assignee.id,
      assigneeName: assignee.name,
      reporterId: reporter.id,
      reporterName: reporter.name,
      storyPoints,
      components: readNames({ value: fields['components'] }),
      labels: readNames({ value: fields['labels'] }),
      created: typeof fields['created'] === 'string' ? fields['created'] : null,
      resolutiondate:
        typeof fields['resolutiondate'] === 'string' ? fields['resolutiondate'] : null,
      statusTransitions,
      assigneeChanges,
    });
  }

  return { projectKey, projectName, issues, accounts, changelogAvailable, diagnostics };
};
