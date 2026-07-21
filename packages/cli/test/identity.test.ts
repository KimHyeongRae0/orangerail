import { DEV_SUBJECT, type ResolveIdentityContext } from 'orangerail-core';
import { describe, expect, it } from 'vitest';

import { resolveCliCaller } from '../src/identity';

describe('cli identity — resolveCaller transport + osUser (AC-4)', () => {
  it('invokes the adapter with transport "cli" and an osUser request', async () => {
    let seen: ResolveIdentityContext | undefined;

    const identity = await resolveCliCaller({
      resolveIdentity: (ctx) => {
        seen = ctx;
        return { subject: 'mapped', roles: ['editor'] };
      },
    });

    expect(seen?.transport).toBe('cli');
    expect(typeof (seen?.request as { osUser?: string })?.osUser).toBe('string');
    expect(identity).toEqual({ subject: 'mapped', roles: ['editor'] });
  });

  it('treats an adapter null return as anonymous (deny-first)', async () => {
    const identity = await resolveCliCaller({ resolveIdentity: () => null });
    expect(identity).toBeNull();
  });

  it('falls back to the dev-mode identity when there is no adapter', async () => {
    const identity = await resolveCliCaller({});
    expect(identity).toEqual({ subject: DEV_SUBJECT, roles: [], devMode: true });
  });
});
