import { createEngine, type ApproveResult, type RejectResult } from 'orangerail-core';

import type { OrangerailConfig } from '../config';
import { resolveCliCaller } from '../identity';
import { renderApprovalDetail, renderApprovalList } from '../render';

const buildEngine = ({ config }: { config: OrangerailConfig }) =>
  createEngine({
    registry: config.registry,
    store: config.store,
    ...(config.redactAudit ? { redactAudit: config.redactAudit } : {}),
  });

/** `orangerail approvals list` — render the pending queue (§3.5). Exit 0. */
export const approvalsList = async ({ config }: { config: OrangerailConfig }): Promise<number> => {
  const pending = await config.store.listPending();
  process.stdout.write(renderApprovalList({ approvals: pending }));

  return 0;
};

/**
 * `orangerail approvals show <id>` — full record with pretty-printed input. The
 * input block is length-capped by default so the decision context stays on the
 * approver's screen; `--full` prints the whole value.
 */
export const approvalsShow = async ({
  config,
  id,
  full = false,
}: {
  config: OrangerailConfig;
  id: string;
  full?: boolean;
}): Promise<number> => {
  const record = await config.store.getApproval({ id });

  if (!record) {
    process.stderr.write(`approval not found: ${id}\n`);
    return 1;
  }

  process.stdout.write(renderApprovalDetail({ record, full }));

  return 0;
};

/**
 * What `approve` adds when the record it just approved carries no `inputHash`
 * (ONT-058).
 *
 * `approve ok (approved)` is true — the CAS really did resolve — and it is the
 * line that made this bug expensive. An operator (and an agent reading the same
 * output) took it as "the write is now cleared to run", and the very next step
 * consumed the approval and performed nothing. The decision surface is the last
 * place this is still cheap to say, so it says it here, to STDERR, next to the
 * success it qualifies rather than instead of it.
 */
const staleApprovalWarning = ({ result }: { result: ApproveResult }): void => {
  if (result.status !== 'approved' || result.record.inputHash !== undefined) {
    return;
  }

  process.stderr.write(
    'WARNING: this approval carries no inputHash, so nothing can bind its payload to it and\n' +
      'execution will refuse it as `invalidated (stale_approval)` — the approval is spent and NO\n' +
      'WRITE HAPPENS. It was created by an orangerail-core older than the one you are running.\n' +
      'Run `orangerail status` for the diagnosis, align the versions, then stage the action again.\n',
  );
};

const reportDecision = ({
  result,
  verb,
}: {
  result: ApproveResult | RejectResult;
  verb: string;
}): number => {
  if (result.status === 'approved' || result.status === 'rejected') {
    process.stdout.write(`${verb} ok (${result.status})\n`);
    return 0;
  }

  const reason =
    result.status === 'denied'
      ? 'denied: anonymous caller'
      : result.status === 'rejected_role'
        ? 'denied: your roles do not authorize this approval'
        : result.status;

  process.stderr.write(`${verb} refused: ${reason}\n`);

  return 1;
};

/** `orangerail approvals approve <id>` — resolve via the store CAS (AC-3). */
export const approvalsApprove = async ({
  config,
  id,
}: {
  config: OrangerailConfig;
  id: string;
}): Promise<number> => {
  const approver = await resolveCliCaller({ resolveIdentity: config.resolveIdentity });
  const result = await buildEngine({ config }).approve({ approvalId: id, approver });

  const code = reportDecision({ result, verb: 'approve' });
  staleApprovalWarning({ result });

  // Still exit 0. The approval genuinely resolved, and a non-zero exit here
  // would break every script that approves in a loop over a condition the
  // script cannot fix — the warning is the signal, the exit code is not.
  return code;
};

/** `orangerail approvals reject <id>` — resolve via the store CAS (AC-3). */
export const approvalsReject = async ({
  config,
  id,
}: {
  config: OrangerailConfig;
  id: string;
}): Promise<number> => {
  const approver = await resolveCliCaller({ resolveIdentity: config.resolveIdentity });
  const result = await buildEngine({ config }).reject({ approvalId: id, approver });

  return reportDecision({ result, verb: 'reject' });
};
