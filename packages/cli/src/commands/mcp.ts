import { createMcpServer, type CreateMcpServerArgs } from 'orangerail-mcp';

import type { OrangerailConfig } from '../config';
import { coreSkewNotice, reviewCoreSkew } from '../core-skew';
import {
  GOVERNANCE_FILE,
  isUnreviewed,
  reviewGovernance,
  withholdActions,
  type GovernanceReview,
} from '../governance';
import {
  heartbeatDirForStore,
  startServerHeartbeat,
  type HeartbeatHandle,
} from '../server-heartbeat';
import { computeStatus, formatStatusLine } from './status';

/**
 * The `createMcpServer` arguments a loaded config resolves to. Every optional
 * hook is passed only when the config actually declared it, so an omitted field
 * gets the server's own default rather than an explicit `undefined`.
 *
 * Extracted as a pure function so the suite can assert the threading without
 * starting a server — `runMcp` connects a stdio transport that never resolves.
 * A hook that stops being forwarded here is a silent loss of governance config,
 * which is exactly the class of bug ONT-044 pulled the argv layer out for.
 *
 * `registry` is an argument rather than read off the config (ONT-050): the
 * server is handed the registry with any weakened actions already withheld, and
 * that is a different object from the one the config declared.
 */
export const mcpServerArgsFrom = ({
  config,
  registry,
}: {
  config: OrangerailConfig;
  registry: CreateMcpServerArgs['registry'];
}): CreateMcpServerArgs => ({
  registry,
  store: config.store,
  ...(config.resolveIdentity ? { resolveIdentity: config.resolveIdentity } : {}),
  ...(config.preset ? { preset: config.preset } : {}),
  ...(config.redactAudit ? { redactAudit: config.redactAudit } : {}),
  ...(config.redactPrior ? { redactPrior: config.redactPrior } : {}),
  ...(config.allowDevMode ? { allowDevMode: config.allowDevMode } : {}),
  ...(config.hostApprovalPrompt ? { hostApprovalPrompt: config.hostApprovalPrompt } : {}),
});

/**
 * What the server says about the baseline before it says anything else. Written
 * to STDERR (stdout is the JSON-RPC channel) as a block, not a clause, because
 * these are the only startup conditions under which the confidence line below
 * would otherwise be reassuring and wrong.
 */
const governanceNotice = ({ review }: { review: GovernanceReview }): string => {
  if (review.state === 'weakened') {
    const lines = review.changes
      .filter((change) => change.direction === 'weakened')
      .map((change) => `orangerail mcp:   - ${change.action}: ${change.detail}\n`)
      .join('');

    return (
      `orangerail mcp: GOVERNANCE DRIFT — ${review.weakenedActions.length} action(s) have a weaker posture than ${GOVERNANCE_FILE}:\n` +
      lines +
      `orangerail mcp: WITHHOLDING ${review.weakenedActions.join(', ')} — these tools are not exposed and cannot be called.\n` +
      'orangerail mcp: Everything else is served normally. Revert the change, or run `orangerail sync --accept-governance` to record the new posture.\n'
    );
  }

  if (review.state === 'unreadable') {
    return (
      `orangerail mcp: ${GOVERNANCE_FILE} could not be read (${review.detail ?? 'unknown'}), so this server CANNOT verify\n` +
      'orangerail mcp: that the gates it is about to enforce are the ones you approved. Serving anyway — restore the file from version control.\n'
    );
  }

  if (review.state === 'unrecorded') {
    return (
      `orangerail mcp: no governance baseline — ${GOVERNANCE_FILE} does not exist, so this server cannot verify that\n` +
      'orangerail mcp: the gates below are the ones you approved. Run `orangerail sync --accept-governance` and commit the file.\n'
    );
  }

  if (isUnreviewed({ review })) {
    return `orangerail mcp: ${GOVERNANCE_FILE} was recorded by \`orangerail init\` and has not been reviewed — run \`orangerail sync --accept-governance\` to vouch for it.\n`;
  }

  return '';
};

/**
 * `orangerail mcp` — launch the governed MCP server over stdio (§3.4). Once
 * connected, the stdio transport keeps the process alive; the caller (a human
 * or an MCP client) ends the session by closing stdin. Never resolves under
 * normal operation.
 *
 * Before it serves anything it reviews the ontology's governance posture against
 * `orangerail.governance.json` (ONT-050). An action whose posture WEAKENED is
 * withheld: it is not in `tools/list` and the engine cannot resolve it, so it
 * cannot be staged or executed. Everything else — every other action, every read
 * tool — is served.
 *
 * Why that line and not another. Refusing to start at all is a stronger
 * guarantee, but it punishes every action that did not change and can take an
 * operator's tooling away in the middle of an incident. Reporting only is what
 * this command did before, and it is exactly how a `sync` that had already
 * printed "approval gate removed" was followed by a server that ran the un-gated
 * action for an agent with a green audit chain to show for it. Withholding the
 * specific actions makes the blast radius of the refusal equal to the blast
 * radius of the drift, and recovery is the one command that already exists and
 * leaves a diff in a committed file.
 *
 * A MISSING or UNREADABLE baseline does not stop the server. A project that has
 * never recorded one must keep working on upgrade, so deleting the file is
 * always an available downgrade; failing closed on a corrupt one therefore buys
 * no security at all, and would cost an operator their server over a JSON typo.
 * Both states are reported loudly and neither is allowed to read as verified.
 *
 * Once serving, write a one-line confidence signal to STDERR: proof that
 * governance is wired, that the audit chain verifies, and how the posture stands
 * against the baseline. It answers a first-run operator's "is this actually
 * protecting me?" without a live dashboard.
 */
export const runMcp = async ({
  config,
  projectRoot,
}: {
  config: OrangerailConfig;
  /** Where `orangerail.governance.json` lives; defaults to the cwd. */
  projectRoot?: string | undefined;
}): Promise<void> => {
  const root = projectRoot ?? process.cwd();
  const review = reviewGovernance({ projectRoot: root, registry: config.registry });

  // Reviewed against the DECLARED registry, before `withholdActions` can wrap
  // it: the wrapper is this CLI's own object and would report alignment no
  // matter which core built the thing it wraps.
  const skew = reviewCoreSkew({ config });

  // The registry the server actually serves. Identical to the declared one
  // unless something weakened, in which case exactly those actions are gone.
  const served =
    review.weakenedActions.length === 0
      ? config.registry
      : withholdActions({ registry: config.registry, names: new Set(review.weakenedActions) });

  // The counts describe what is SERVED — calling the withheld action either
  // "approval-gated" or "auto" would be false — but the baseline verdict is the
  // one taken against the DECLARED registry, because a review of the filtered
  // one would read the withheld action as "removed from the ontology" and
  // report a clean baseline.
  const report = await computeStatus({
    config: { ...config, registry: served },
    projectRoot: root,
    governance: review,
    skew,
  });

  // Build and CONNECT the server before anything claims it is up. Both steps can
  // fail — `createMcpServer` rejects an illegal tool name, `serve()` can fail to
  // connect the transport — and the confidence line used to be written above
  // them, so a host's log read as a healthy start followed by a mysterious
  // crash. ONT-029 ordered the line after the heartbeat write for exactly this
  // reason; the same discipline covers the whole startup path here. Nothing
  // below this point is reachable by a server that failed to start.
  const { serve } = createMcpServer(mcpServerArgsFrom({ config, registry: served }));

  await serve();

  // Publish a liveness heartbeat BEFORE the `serving` line, so the line is
  // backed by a real on-disk entry a concurrent `orangerail status` can already
  // observe — not just a hopeful claim. The entry is this process's own
  // (`servers/<pid>.json`), so any number of servers may share the store and
  // none of them can erase another. A no-op dir (a non-file store has no shared
  // on-disk location) leaves `status` reporting "not detected" honestly.
  // Cleanup is registered once, best-effort, and stops the refresh timer +
  // removes OUR entry on any terminating signal or a normal exit so a clean
  // shutdown never lingers as "stale".
  const heartbeatDir = heartbeatDirForStore({ store: config.store });
  const heartbeat: HeartbeatHandle | null =
    heartbeatDir === null ? null : startServerHeartbeat({ dir: heartbeatDir });

  if (heartbeat) {
    const shutdown = ({ signal }: { signal: NodeJS.Signals }): void => {
      heartbeat.stop();
      process.kill(process.pid, signal);
    };

    process.once('exit', () => heartbeat.stop());
    process.once('SIGINT', () => shutdown({ signal: 'SIGINT' }));
    process.once('SIGTERM', () => shutdown({ signal: 'SIGTERM' }));
  }

  // Skew first. A governance verdict describes gates that are wired correctly
  // and will still never complete a write, so reading it before the skew notice
  // sends an operator to fix a baseline that was never the problem.
  process.stderr.write(
    `${coreSkewNotice({ review: skew })}${governanceNotice({ review })}${formatStatusLine({ report })}\n`,
  );
};
