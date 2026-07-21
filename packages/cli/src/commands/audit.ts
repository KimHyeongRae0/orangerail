import { verifyAudit } from 'orangerail-core';

import type { OrangerailConfig } from '../config';

/**
 * `orangerail audit verify` (AC-5). Wraps core `verifyAudit`, which checks chain
 * tampering, started-but-unfinished executions, AND consumed approvals with no
 * `execution_started` record (orphans). Exits non-zero with human-readable
 * findings on any issue.
 */
export const auditVerify = async ({ config }: { config: OrangerailConfig }): Promise<number> => {
  const verdict = await verifyAudit({ store: config.store });

  if (verdict.ok) {
    process.stdout.write(`audit chain OK — ${verdict.count} record(s) verified.\n`);
    return 0;
  }

  process.stderr.write(
    `audit verification FAILED — ${verdict.count} record(s), ${verdict.issues.length} issue(s):\n`,
  );
  for (const issue of verdict.issues) {
    process.stderr.write(`  - ${issue}\n`);
  }

  return 1;
};
