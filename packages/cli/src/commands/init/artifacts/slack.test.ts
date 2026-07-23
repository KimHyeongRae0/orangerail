import { describe, expect, it } from 'vitest';

import { parseSlack, resolveSlackIdentity } from './slack';

const RAW = {
  users: [
    { id: 'U_A', name: 'ann', real_name: 'Ann A', is_bot: false },
    { id: 'U_BOT', name: 'ci', real_name: 'CI Bot', is_bot: true },
  ],
  channels: [
    {
      id: 'C1',
      name: 'dev',
      messages: [
        { ts: '100.0001', user: 'U_A', text: 'root', thread_ts: '100.0001' },
        { ts: '101.0002', user: 'U_BOT', text: 'build ok' },
        { ts: '102.0003', user: 'U_GHOST', text: 'from an unknown id' },
      ],
    },
  ],
};

describe('parseSlack', () => {
  it('builds the user map and normalizes messages (thread_ts defaults to ts)', () => {
    const parsed = parseSlack({ raw: RAW });

    expect(parsed.users.get('U_A')).toEqual({ realName: 'Ann A', isBot: false });
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[1]!.threadTs).toBe('101.0002');
  });
});

describe('resolveSlackIdentity', () => {
  it('maps only non-bot users whose real_name matches a Jira displayName', () => {
    const slack = parseSlack({ raw: RAW });
    const identity = resolveSlackIdentity({
      slack,
      jiraAccounts: new Map([['acc_a', 'Ann A']]),
    });

    expect(identity.userToAccount.get('U_A')).toBe('acc_a');
    expect(identity.userToAccount.has('U_BOT')).toBe(false);
    expect(identity.diagnostics.some((d) => d.includes('bot'))).toBe(true);
  });
});
