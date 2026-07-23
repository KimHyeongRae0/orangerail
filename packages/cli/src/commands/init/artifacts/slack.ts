import type { ParsedSlack, SlackIdentity, SlackMessage } from './types';

/**
 * Pure parser for a Slack export of shape `{ users[], channels[] }` where each
 * channel has `messages[]` (`ts`, `user`, `text`, optional `thread_ts`) and
 * each user has `id`, `real_name`, `is_bot` (plan Step 3). The identity map is
 * built from the export's own `users` listing — never hardcoded. Bot, deleted,
 * and unknown users are flagged with a counted diagnostic, never crashed on.
 */

/** Parse the raw Slack export JSON into normalized messages + the user map. */
export const parseSlack = ({ raw }: { raw: unknown }): ParsedSlack => {
  const diagnostics: string[] = [];
  const users = new Map<string, { realName: string; isBot: boolean }>();

  const root = (raw ?? {}) as Record<string, unknown>;
  const rawUsers = Array.isArray(root['users']) ? root['users'] : [];

  for (const rawUser of rawUsers) {
    if (rawUser === null || typeof rawUser !== 'object') {
      continue;
    }

    const user = rawUser as Record<string, unknown>;
    const id = typeof user['id'] === 'string' ? user['id'] : null;
    if (id === null) {
      continue;
    }

    users.set(id, {
      realName: typeof user['real_name'] === 'string' ? user['real_name'] : '',
      isBot: user['is_bot'] === true,
    });
  }

  const rawChannels = Array.isArray(root['channels']) ? root['channels'] : [];
  const messages: SlackMessage[] = [];

  for (const rawChannel of rawChannels) {
    if (rawChannel === null || typeof rawChannel !== 'object') {
      continue;
    }

    const channel = rawChannel as Record<string, unknown>;
    const channelName = typeof channel['name'] === 'string' ? channel['name'] : '';
    const rawMessages = Array.isArray(channel['messages']) ? channel['messages'] : [];

    for (const rawMessage of rawMessages) {
      if (rawMessage === null || typeof rawMessage !== 'object') {
        diagnostics.push(`skipped a non-object message in ${channelName}`);
        continue;
      }

      const message = rawMessage as Record<string, unknown>;
      const ts = typeof message['ts'] === 'string' ? message['ts'] : null;
      const userId = typeof message['user'] === 'string' ? message['user'] : null;

      if (ts === null || userId === null) {
        diagnostics.push(`skipped a message with no ts/user in ${channelName}`);
        continue;
      }

      messages.push({
        channel: channelName,
        ts,
        userId,
        text: typeof message['text'] === 'string' ? message['text'] : '',
        threadTs: typeof message['thread_ts'] === 'string' ? message['thread_ts'] : ts,
      });
    }
  }

  return { users, messages, diagnostics };
};

/**
 * Resolve which Slack userIds map to which Jira accountId by matching the
 * Slack `real_name` to the Jira `displayName` (both are the person's full name
 * in the export). This is the only identity resolution — no fuzzy matching.
 * Bot users and users whose name matches no Jira account are excluded with a
 * counted diagnostic (they never become employees or help edges).
 */
export const resolveSlackIdentity = ({
  slack,
  jiraAccounts,
}: {
  slack: ParsedSlack;
  jiraAccounts: Map<string, string>;
}): SlackIdentity => {
  const nameToAccount = new Map<string, string>();
  for (const [accountId, displayName] of jiraAccounts) {
    nameToAccount.set(displayName, accountId);
  }

  const userToAccount = new Map<string, string>();
  const diagnostics: string[] = [];

  for (const [userId, user] of slack.users) {
    if (user.isBot) {
      diagnostics.push(`excluded bot user ${userId} from help edges`);
      continue;
    }

    const accountId = nameToAccount.get(user.realName);
    if (accountId === undefined) {
      diagnostics.push(`Slack user ${userId} (${user.realName}) matches no Jira account`);
      continue;
    }

    userToAccount.set(userId, accountId);
  }

  return { userToAccount, diagnostics };
};
