import type { Identity, Transport } from '../types';

/** Context passed to a {@link ResolveIdentity} adapter (§4.6). */
export interface ResolveIdentityContext {
  transport: Transport;
  request?: unknown;
}

/**
 * User-supplied authentication adapter. Returning `null` is the explicit
 * "identity resolution failed" signal ⇒ anonymous (§4.6).
 */
export type ResolveIdentity = (
  ctx: ResolveIdentityContext,
) => Promise<Identity | null> | Identity | null;

/**
 * How the transport-free engine learns about dev mode without sniffing (§3.6).
 * Dev mode is entered iff there is NO adapter AND `allowDevMode` is true — the
 * transport layer sets `allowDevMode` for local stdio/cli only; core enforces.
 */
export interface IdentityConfig {
  resolveIdentity?: ResolveIdentity;
  allowDevMode: boolean;
  transport: Transport;
}

/** The synthetic dev-mode subject — holds all roles implicitly, stamped `devMode`. */
export const DEV_SUBJECT = 'local-dev';

/**
 * Resolve a caller identity from config.
 *
 * - adapter present ⇒ its return value (`null` ⇒ anonymous / deny-first);
 * - no adapter + `allowDevMode` ⇒ `local-dev` (all roles implicit, `devMode`);
 * - no adapter + no dev mode ⇒ `null` (anonymous).
 */
export const resolveCaller = async ({
  config,
  request,
}: {
  config: IdentityConfig;
  request?: unknown;
}): Promise<Identity | null> => {
  if (config.resolveIdentity) {
    const ctx: ResolveIdentityContext =
      request === undefined
        ? { transport: config.transport }
        : { transport: config.transport, request };

    return config.resolveIdentity(ctx);
  }

  if (config.allowDevMode) {
    return { subject: DEV_SUBJECT, roles: [], devMode: true };
  }

  return null;
};

/**
 * Whether an identity may approve an action given its `policy.roles` (§4.6):
 *
 * - dev-mode identity ⇒ always (holds all roles implicitly);
 * - no roles on the policy ⇒ any authenticated identity may approve;
 * - otherwise ⇒ non-empty intersection of the identity's roles with the policy's.
 */
export const authorizeApprover = ({
  approver,
  roles,
}: {
  approver: Identity;
  roles?: string[] | undefined;
}): boolean => {
  if (approver.devMode === true) {
    return true;
  }

  if (!roles || roles.length === 0) {
    return true;
  }

  return approver.roles.some((role) => roles.includes(role));
};
