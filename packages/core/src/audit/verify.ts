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
 * The phases that account for a burned approval: the execution itself, or one of
 * the pre-execute aborts. Any of them means "this approval was taken off the
 * queue and acted on".
 *
 * Since ONT-069 each of these is appended BEFORE the CAS that spends the
 * approval, not after — which is why a consumed approval carrying none of them
 * is now a store that consumed something this engine never asked about, rather
 * than the routine outcome of an append that threw.
 */
const POST_CONSUME_PHASES: AuditPhase[] = [
  'execution_started',
  'invalidated',
  'condition_changed',
  'resolve_error',
];

/** The phases that state an execution reached its end, however it ended. */
const TERMINAL_PHASES: AuditPhase[] = ['succeeded', 'failed', 'terminal_unrecorded'];

/** Everything the chain says about one approvalId, gathered in one pass. */
interface ApprovalTrace {
  /** First record seen per phase (the chain is walked in seq order). */
  firstByPhase: Map<AuditPhase, AuditRecord>;
  startedCount: number;
  /**
   * Attempts that wrote `execution_started` and then lost the claim (ONT-069).
   * They are started records that are not executions, and the replay check
   * subtracts them rather than counting a race as tampering.
   */
  abortedCount: number;
  /** Whether any record says this approval's execution reached its end. */
  terminated: boolean;
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
      trace = {
        firstByPhase: new Map(),
        startedCount: 0,
        abortedCount: 0,
        terminated: false,
        actionNames: new Set(),
        inputs: [],
      };
      traces.set(id, trace);
    }

    if (!trace.firstByPhase.has(record.phase)) {
      trace.firstByPhase.set(record.phase, record);
    }
    if (record.phase === 'execution_started') {
      trace.startedCount += 1;
    }
    if (record.phase === 'execution_aborted') {
      trace.abortedCount += 1;
    }
    if (TERMINAL_PHASES.includes(record.phase)) {
      trace.terminated = true;
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
  // second STARTED-AND-NOT-ABORTED execution means the approval was re-armed
  // behind the engine's back (an appended `resolved`/`created` line rewinding
  // the fold).
  //
  // The subtraction is what the ONT-069 ordering costs and it costs nothing:
  // `execution_started` is now written before the claim, so a race leaves the
  // loser's started record on the chain, and the loser writes an
  // `execution_aborted` against it. A re-armed approval executes for real and
  // has no abort to subtract, so the tell still fires. What can also reach this
  // line is an attempt that died between its audit record and the CAS — it
  // never ran, and the chain cannot tell that from a replay, so the message
  // states both readings instead of accusing.
  const executions = trace.startedCount - trace.abortedCount;
  if (executions > 1) {
    issues.push(
      `replayed approval ${id}: ${trace.startedCount} execution_started record(s) and ${trace.abortedCount} aborted attempt(s) for a single-use approval — it was re-armed behind the engine's back, or an attempt died between its audit record and the consume CAS`,
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

  // X10 — an executed approval must be spent. `execute` claims the approval
  // between `execution_started` and `action.execute` (ONT-069), so a TERMINAL
  // record against a store that still shows the approval as re-usable means the
  // `consumed` event was erased to re-arm it.
  //
  // Keyed on the terminal record rather than the start, because since that
  // ordering change a bare `execution_started` no longer proves the approval was
  // claimed: an attempt that died before the CAS wrote one and ran nothing, and
  // its approval is legitimately still executable. Reporting that as an executed
  // approval would accuse the operator of tampering for a crash.
  if (trace?.terminated === true && approval.status !== 'consumed') {
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
 * - every `execution_started` must be closed for the same approval — by a
 *   `succeeded`/`failed`, by an `execution_aborted` (an attempt that lost the
 *   claim), or by a `terminal_unrecorded` marker (the action ran and the store
 *   refused its outcome, reported in its own words);
 * - every `consumed` approval must have a post-consume record — a gap means the
 *   approval was spent without this engine writing anything about it (§3.2
 *   third check, AC-5). An empty store verifies.
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
  //
  // COUNTED rather than set-membership, because one key can now carry several
  // attempts: a race writes a started record per caller. One abort must not
  // stand in for a sibling attempt that died mid-execution, so every start needs
  // a closer of its own.
  const started = new Map<string, number>();
  const closed = new Map<string, number>();
  const unrecorded = new Set<string>();

  const bump = ({ counts, key }: { counts: Map<string, number>; key: string }): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (const record of records) {
    const key = record.approvalId ?? record.correlationId;
    if (key === undefined) {
      continue;
    }

    if (record.phase === 'execution_started') {
      bump({ counts: started, key });
    }

    // A start is closed by its outcome, by an `execution_aborted` (an attempt
    // that lost the claim and ran nothing), or by a `terminal_unrecorded` marker
    // (the action ran and the store refused its outcome) — none of those is
    // "still running", and the last one is answered below in its own words.
    if (
      record.phase === 'succeeded' ||
      record.phase === 'failed' ||
      record.phase === 'execution_aborted' ||
      record.phase === 'terminal_unrecorded'
    ) {
      bump({ counts: closed, key });
    }

    if (record.phase === 'terminal_unrecorded') {
      unrecorded.add(key);
    }
  }

  // Two different accidents, two different sentences (§3.5 / ONT-069). A marker
  // says the action RAN and the chain could not describe the outcome — the
  // operator has a write to reconcile and knows it. An unpaired start says the
  // process never got to any terminal record at all. Reporting both as
  // "incomplete execution" is what sent an operator hunting a crash that never
  // happened.
  for (const key of unrecorded) {
    issues.push(
      `terminal record could not be written for ${key}: the action ran and the chain does not carry its outcome`,
    );
  }

  for (const [key, count] of started) {
    if ((closed.get(key) ?? 0) < count) {
      issues.push(
        `incomplete execution for ${key}: started but never finished — no terminal record was appended, so the process died mid-execution`,
      );
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
