import { userInfo } from 'node:os';

import { resolveCaller, type Identity, type ResolveIdentity } from 'orangerail-core';

/**
 * Resolve the CLI caller identity (§3.3, AC-4): `resolveCaller` with
 * `transport: 'cli'` and `request: { osUser }`. A config `resolveIdentity`
 * adapter maps the OS user to `{ subject, roles }`; with no adapter the local
 * CLI passes `allowDevMode: true`, yielding the `local-dev` identity with
 * `devMode: true` (stamped onto every audit record it produces).
 */
export const resolveCliCaller = async ({
  resolveIdentity,
}: {
  resolveIdentity?: ResolveIdentity | undefined;
}): Promise<Identity | null> =>
  resolveCaller({
    config: {
      transport: 'cli',
      allowDevMode: true,
      ...(resolveIdentity ? { resolveIdentity } : {}),
    },
    request: { osUser: userInfo().username },
  });
