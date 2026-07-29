import type { ApprovalRecord, AuditPhase, AuditRecord, Store } from '../store/contract';
import { GENESIS_HASH, hashApprovalInput, hashAuditRecord } from './chain';

/** Outcome of {@link verifyAudit}: `ok` plus a human-readable issue list. */
export interface AuditVerifyResult {
  ok: boolean;
  issues: string[];
  count: number;
}

const readAll = async ({ store }: { store: Store }): Promise<AuditRecord[]> => {
  const all: AuditRecord[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await store.readAudit(cursor === undefined ? {} : { cursor });
    all.push(...page.items);

    if (page.nextCursor === undefined) {
      break;
    }

    cursor = page.nextCursor;
  }

  return all;
};

/**
 * The phases `execute` can append AFTER the consume CAS has already burned the
 * approval: the execution itself, or one of the pre-execute aborts. Any of them
 * means "this approval was taken off the queue and acted on".
 */
const POST_CONSUME_PHASES: AuditPhase[] = [
  'execution_started',
  'invalidated',
  'condition_changed',
  'resolve_error',
];

/** Everything the chain says about one approvalId, gathered in one pass. */
interface ApprovalTrace {
  /** First record seen per phase (the chain is walked in seq order). */
  firstByPhase: Map<AuditPhase, AuditRecord>;
  startedCount: number;
  /** Every distinct `actionName` the chain attributes to this approval. */
  actionNames: Set<string>;
  /** Input digest of every record that carries one, in chain order. */
  inputs: { phase: AuditPhase; hash: string }[];
}

const traceApprovals = ({ records }: { records: AuditRecord[] }): Map<string, ApprovalTrace> => {
  const traces = new Map<string, ApprovalTrace>();

  for (const record of records) {
    const id = record.approvalId;
    if (id === undefined) {
      continue;
    }

    let trace = traces.get(id);
    if (!trace) {
      trace = { firstByPhase: new Map(), startedCount: 0, actionNames: new Set(), inputs: [] };
      traces.set(id, trace);
    }

    if (!trace.firstByPhase.has(record.phase)) {
      trace.firstByPhase.set(record.phase, record);
    }
    if (record.phase === 'execution_started') {
      trace.startedCount += 1;
    }

    trace.actionNames.add(record.actionName);

    if (record.input !== undefined) {
      trace.inputs.push({ phase: record.phase, hash: hashApprovalInput({ input: record.input }) });
    }
  }

  return traces;
};

/**
 * Cross-check the audit chain against itself for one approval (§3.2 / ONT-040).
 * The chain is a witness independent of the approvals store, so it is the thing
 * that catches a forgery committed in `approvals.jsonl` alone.
 */
const chainSelfChecks = ({
  id,
  trace,
  issues,
}: {
  id: string;
  trace: ApprovalTrace;
  issues: string[];
}): void => {
  const approved = trace.firstByPhase.get('approved');
  const postConsume = POST_CONSUME_PHASES.map((phase) => trace.firstByPhase.get(phase)).filter(
    (record): record is AuditRecord => record !== undefined,
  );
  const firstPostConsume = postConsume.reduce<AuditRecord | undefined>(
    (earliest, record) => (earliest === undefined || record.seq < earliest.seq ? record : earliest),
    undefined,
  );

  // X1 — executed without a human decision. THE defect-A tell: `engine.approve`
  // is the only thing that writes an `approved` record, so an approval flipped
  // to `approved` by appending a line to the approvals log has none, no matter
  // how convincing the forged line is.
  if (firstPostConsume !== undefined) {
    if (approved === undefined) {
      issues.push(
        `forged approval ${id}: executed at seq ${firstPostConsume.seq} with no "approved" audit record — no human decision was ever recorded`,
      );
    } else if (approved.seq > firstPostConsume.seq) {
      issues.push(
        `out-of-order approval ${id}: executed at seq ${firstPostConsume.seq} before it was approved at seq ${approved.seq}`,
      );
    }
  }

  // X2 — decided without a staging. A `created` event injected straight into
  // the approvals log skips stage() entirely (no schema parse, no `where`), so
  // the approval it fabricates has no `staged` record behind its decision.
  const decision = approved ?? trace.firstByPhase.get('rejected');
  const staged = trace.firstByPhase.get('staged');
  if (decision !== undefined && staged === undefined) {
    issues.push(
      `unstaged approval ${id}: decided at seq ${decision.seq} with no preceding "staged" audit record`,
    );
  }

  // X3 — one approval, two executions. The consume CAS is single-winner, so a
  // second `execution_started` means the approval was re-armed behind the
  // engine's back (an appended `resolved`/`created` line rewinding the fold).
  if (trace.startedCount > 1) {
    issues.push(
      `replayed approval ${id}: ${trace.startedCount} execution_started records for a single-use approval`,
    );
  }

  // X4 — the action was swapped. Every record for one approval is written from
  // the same stored `actionName`, so a disagreement means the approval was
  // retargeted at a different action between the records.
  if (trace.actionNames.size > 1) {
    issues.push(
      `retargeted approval ${id}: audit records disagree on the action (${[...trace.actionNames].sort().join(', ')})`,
    );
  }

  // X5 — approve-what-you-execute, after the fact (defect B). `staged` /
  // `approved` carry the payload the human saw; `execution_started` /
  // `succeeded` carry the payload that ran. A swap performed under 0.1.0 has
  // already executed and cannot be prevented retroactively — but it is right
  // here in the chain, and it is detectable without any per-approval hash, so
  // it works on records written before this check existed.
  const baseline = trace.inputs[0];
  if (baseline !== undefined) {
    const changed = trace.inputs.find((entry) => entry.hash !== baseline.hash);
    if (changed !== undefined) {
      issues.push(
        `swapped input on approval ${id}: input changed between the "${baseline.phase}" and "${changed.phase}" audit records — the executed payload is not the approved payload`,
      );
    }
  }
};

/**
 * Cross-check one approval record in the store against the chain (§3.2 /
 * ONT-040). The approvals store and the audit chain are two independent
 * witnesses; wherever they overlap they are forced to agree, so tampering has
 * to forge BOTH logs consistently to pass.
 */
const storeChainChecks = ({
  approval,
  trace,
  issues,
}: {
  approval: ApprovalRecord;
  trace: ApprovalTrace | undefined;
  issues: string[];
}): void => {
  const id = approval.id;
  const staged = trace?.firstByPhase.get('staged');
  const approved = trace?.firstByPhase.get('approved');
  const rejected = trace?.firstByPhase.get('rejected');

  // X6 — an approval the chain never saw staged. Catches a `created` event
  // injected into the approvals log, and (the wipe case) a chain deleted out
  // from under a queue that still holds pending approvals: N pending approvals
  // against a zero-length chain is internally inconsistent, and saying "chain
  // OK — 0 records" about it is the wrong answer.
  if (staged === undefined) {
    issues.push(
      `approval ${id} (${approval.status}) has no "staged" audit record — the approvals store and the audit chain disagree that it was ever staged`,
    );
  }

  // X7 — the decision recorded in the two logs must match. A `resolved` line
  // appended to the approvals log resolves an approval that the chain never saw
  // decided; a `resolved` line DELETED from it hides a decision the chain did.
  const resolved = approval.status === 'approved' || approval.status === 'consumed';
  if (resolved && approved === undefined) {
    issues.push(
      `approval ${id} is "${approval.status}" in the approvals store but has no "approved" audit record`,
    );
  }
  if (approval.status === 'rejected' && rejected === undefined) {
    issues.push(
      `approval ${id} is "rejected" in the approvals store but has no "rejected" audit record`,
    );
  }
  if (approval.status === 'pending' && (approved !== undefined || rejected !== undefined)) {
    issues.push(
      `approval ${id} is "pending" in the approvals store but the audit chain records a decision on it`,
    );
  }

  // X8 — the approver's name. The forged-approval PoC puts an innocent person's
  // name on the decision; `engine.approve` is the only writer of the `approver`
  // field on the chain, so the two names must be the same name.
  const decisionRecord = approved ?? rejected;
  if (
    decisionRecord !== undefined &&
    approval.decidedBy !== undefined &&
    approval.decidedBy !== decisionRecord.approver
  ) {
    issues.push(
      `approval ${id} names approver "${approval.decidedBy}" in the approvals store but the audit chain records "${String(decisionRecord.approver)}"`,
    );
  }

  // X9 — the action and the requester recorded at staging. Rewriting either in
  // the approvals log retargets the approval at a different action, or reassigns
  // it to a different requester (which is what separation of duty keys on).
  if (staged !== undefined && staged.actionName !== approval.actionName) {
    issues.push(
      `approval ${id} names action "${approval.actionName}" but was staged as "${staged.actionName}"`,
    );
  }
  if (
    staged !== undefined &&
    staged.requestedBy !== undefined &&
    staged.requestedBy !== approval.requestedBy
  ) {
    issues.push(
      `approval ${id} names requester "${approval.requestedBy}" but was staged by "${staged.requestedBy}"`,
    );
  }

  // X10 — an executed approval must be spent. `execute` consumes BEFORE it
  // appends `execution_started`, so a chain that shows an execution against a
  // store that still shows the approval as re-usable means the `consumed` event
  // was erased to re-arm it.
  if (trace?.firstByPhase.has('execution_started') === true && approval.status !== 'consumed') {
    issues.push(
      `approval ${id} was executed but is "${approval.status}" in the approvals store, not "consumed"`,
    );
  }

  // X11 — the stored input still hashes to the hash stamped when it was created
  // (defect B). Catches an input edited in the store at any point, including
  // after the execution, which the chain-internal comparison cannot see.
  //
  // An ABSENT `inputHash` is a record persisted by 0.1.0 and is NOT reported:
  // verification cannot tell it from a stripped one, and accusing every
  // pre-upgrade approval of tampering would be worse than useless. `execute`
  // takes the other side of the same fact and refuses to run it.
  if (
    approval.inputHash !== undefined &&
    approval.inputHash !== hashApprovalInput({ input: approval.input })
  ) {
    issues.push(
      `approval ${id} input does not match the inputHash stamped when it was created — the approved payload was edited in the store`,
    );
  }
};

/**
 * Walk the audit chain and report integrity issues (§3.5 / AC-7):
 *
 * - each record's `prevHash` must equal the prior record's `hash` (genesis for
 *   the first) — a break means deletion or reordering;
 * - each record's `hash` must equal a recomputation over its content — a
 *   mismatch means the record was tampered with;
 * - every `execution_started` must have a matching `succeeded`/`failed` for the
 *   same approval — a gap means an incomplete execution (side effect without a
 *   terminal record);
 * - every `consumed` approval must have an `execution_started` record — a gap
 *   means a crash between `consumeApproval` and the audit append (§3.2 third
 *   check, AC-5). An empty store verifies.
 *
 * On top of that walk, the approvals store and the audit chain are cross-checked
 * against each other wherever they overlap (§3.2 / ONT-040) — staging,
 * decision, decider, requester, action, consumption, and payload. Neither log
 * is trusted on its own, so forging one of them is no longer enough.
 *
 * NOT a defense against an attacker holding write access to the store: the
 * chain hash is unkeyed and its anchor is unsigned and lives beside it, so both
 * logs can be rewritten consistently. These checks raise the bar to "tampering
 * that forges both logs in agreement", nothing higher.
 */
export const verifyAudit = async ({ store }: { store: Store }): Promise<AuditVerifyResult> => {
  const records = await readAll({ store });
  const issues: string[] = [];

  let prev = GENESIS_HASH;

  for (const record of records) {
    if (record.prevHash !== prev) {
      issues.push(`chain break at seq ${record.seq}: prevHash does not match the previous record`);
    }

    const { hash, ...rest } = record;
    const recomputed = hashAuditRecord({ record: rest });
    if (recomputed !== hash) {
      issues.push(`tampered record at seq ${record.seq}: hash mismatch`);
    }

    prev = record.hash;
  }

  // Key the started->terminal cross-check on `approvalId ?? correlationId`, so
  // auto actions (no approvalId, §3.2 / AC-2) are paired via their correlation
  // id and a truncated auto terminal is caught — closing the old
  // "no approvalId -> skipped" gap.
  const started = new Set<string>();
  const finished = new Set<string>();

  for (const record of records) {
    const key = record.approvalId ?? record.correlationId;
    if (key === undefined) {
      continue;
    }

    if (record.phase === 'execution_started') {
      started.add(key);
    }
    if (record.phase === 'succeeded' || record.phase === 'failed') {
      finished.add(key);
    }
  }

  for (const key of started) {
    if (!finished.has(key)) {
      issues.push(`incomplete execution for ${key}: started but never finished`);
    }
  }

  const traces = traceApprovals({ records });

  for (const [id, trace] of traces) {
    chainSelfChecks({ id, trace, issues });
  }

  // A consumed approval is accounted-for once execute has appended ANY of its
  // post-consume outcomes (execution_started, or a pre-execute abort:
  // invalidated / condition_changed / resolve_error). A consumed approval with
  // none of these is a crash between consumeApproval and that append (§3.2).
  const accounted = new Set<string>();
  for (const record of records) {
    if (record.approvalId === undefined) {
      continue;
    }
    if (POST_CONSUME_PHASES.includes(record.phase)) {
      accounted.add(record.approvalId);
    }
  }

  const approvals = await store.listApprovals();
  for (const approval of approvals) {
    if (approval.status === 'consumed' && !accounted.has(approval.id)) {
      issues.push(
        `orphaned consumed approval ${approval.id}: consumed but no post-consume audit record`,
      );
    }

    storeChainChecks({ approval, trace: traces.get(approval.id), issues });
  }

  // Anchored-head containment check (§3.1 / AC-1..AC-3). The internally
  // consistent chain walk above cannot see a tail that was truncated wholesale;
  // the persisted checkpoint records how long the chain SHOULD be. CONTAINMENT
  // (not equality) so a chain one record ahead of the checkpoint — the single
  // crash-between-append-and-head-write window — never false-positives, while
  // any truncation (which only ever shortens the chain) is caught.
  const head = await store.readAuditHead();

  if (head === null) {
    if (records.length > 0) {
      issues.push(
        `audit checkpoint missing: chain has ${records.length} record(s) but no anchored head`,
      );
    }
  } else if (records.length < head.seq) {
    issues.push(
      `audit truncated: on-disk chain has ${records.length} record(s), shorter than anchored head seq ${head.seq}`,
    );
  } else {
    const anchored = records.find((record) => record.seq === head.seq);
    if (anchored === undefined) {
      issues.push(`audit diverged from anchored head: no record at seq ${head.seq}`);
    } else if (anchored.hash !== head.hash) {
      issues.push(`audit diverged from anchored head at seq ${head.seq}: hash mismatch`);
    }
  }

  return { ok: issues.length === 0, issues, count: records.length };
};
