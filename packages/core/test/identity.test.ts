import { describe, expect, it } from 'vitest';

import { authorizeApprover, DEV_SUBJECT, resolveCaller } from '../src/identity/contract';
import type { Identity } from '../src/types';

describe('resolveCaller — dev mode vs adapter (§4.6)', () => {
  it('returns a dev-mode identity when there is no adapter and dev mode is allowed', async () => {
    const identity = await resolveCaller({ config: { allowDevMode: true, transport: 'stdio' } });
    expect(identity).toEqual({ subject: DEV_SUBJECT, roles: [], devMode: true });
  });

  it('returns null (anonymous) when there is no adapter and dev mode is not allowed', async () => {
    const identity = await resolveCaller({ config: { allowDevMode: false, transport: 'stdio' } });
    expect(identity).toBeNull();
  });

  it('delegates to the adapter and treats a null return as anonymous', async () => {
    const withIdentity = await resolveCaller({
      config: {
        allowDevMode: true,
        transport: 'cli',
        resolveIdentity: () => ({ subject: 'u', roles: ['admin'] }),
      },
    });
    expect(withIdentity).toEqual({ subject: 'u', roles: ['admin'] });

    const anonymous = await resolveCaller({
      config: { allowDevMode: true, transport: 'stdio', resolveIdentity: () => null },
    });
    expect(anonymous).toBeNull();
  });

  it('passes the transport discriminator into the adapter', async () => {
    let seen: string | undefined;
    await resolveCaller({
      config: {
        allowDevMode: false,
        transport: 'cli',
        resolveIdentity: ({ transport }) => {
          seen = transport;
          return null;
        },
      },
    });
    expect(seen).toBe('cli');
  });
});

describe('authorizeApprover (§4.6)', () => {
  const withRole: Identity = { subject: 'a', roles: ['cs-manager'] };
  const withoutRole: Identity = { subject: 'b', roles: ['ops'] };
  const dev: Identity = { subject: 'd', roles: [], devMode: true };

  it('requires role intersection when the policy declares roles', () => {
    expect(authorizeApprover({ approver: withRole, roles: ['cs-manager'] })).toBe(true);
    expect(authorizeApprover({ approver: withoutRole, roles: ['cs-manager'] })).toBe(false);
  });

  it('allows any authenticated identity when the policy has no roles', () => {
    expect(authorizeApprover({ approver: withoutRole, roles: [] })).toBe(true);
    expect(authorizeApprover({ approver: withoutRole })).toBe(true);
  });

  it('lets a dev-mode identity approve anything (all roles implicit)', () => {
    expect(authorizeApprover({ approver: dev, roles: ['cs-manager'] })).toBe(true);
  });
});
