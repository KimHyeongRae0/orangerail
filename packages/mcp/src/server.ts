import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import {
  checkConformance,
  createEngine,
  markNonconforming,
  readPublicDiagnostic,
  renderBigInts,
  renderConformancePath,
  resolveCaller,
  type ConformanceIssue,
  type ExecuteResult,
  type Identity,
  type ObjectDefinition,
  type PublicDiagnostic,
  type RedactAudit,
  type RedactPrior,
  type Registry,
  type ResolveIdentity,
  type ResolveListResult,
  type RuntimeAction,
  type StageResult,
  type Store,
} from 'orangerail-core';

import { deriveFilterSchema, deriveFilterSpec, validateFilter, type FilterSpec } from './filter';
import { validateToolName } from './names';
import { redactFailure, type FailureChannel, type FailureStatus } from './redact';
import { relationLines } from './relations';
import { deriveInputSchema, describeInputIssues, type JsonSchema } from './schema';

/** Runtime preset controlling which tools are exposed and the engine mode (§3.6). */
export type McpPreset = 'readonly' | 'sandbox' | 'approval-for-writes';

/**
 * Which action tools ask the HOST to run its own permission prompt (ONT-048).
 *
 * This is a hint to the client, not a gate. orangerail's gate lives in this
 * process and holds whatever the host does with the hint; the hint only lets a
 * host that has a prompt of its own put it in front of the call as well.
 *
 * - `'off'` (default) — nothing is annotated. The `tools/list` payload carries
 *   no `_meta` at all.
 * - `'ungoverned-actions'` — annotate exactly the actions declared WITHOUT
 *   `policy: { approval: 'required' }`. Those execute on call, so they are the
 *   only tools here where a host prompt removes real risk.
 * - `'all-actions'` — annotate every action tool. Costs the operator a second
 *   prompt on the governed path (which only stages), and buys a checkpoint
 *   before an agent can add to the approval queue at all.
 *
 * Read tools and `check_approval` are NEVER annotated. A read has no effect, and
 * `check_approval` is polled in a loop until a human decides — an unskippable
 * prompt on every poll is unusable, and in a host mode that never prompts a
 * flagged call is denied rather than asked, which would break completion.
 */
export type HostApprovalPrompt = 'off' | 'ungoverned-actions' | 'all-actions';

/**
 * The `_meta` key Claude Code v2.1.199+ reads to force its permission prompt on
 * every call to a tool. Vendor-prefixed per the MCP spec's `_meta` key-name
 * rules, so a host that does not know it treats it as unknown metadata and
 * ignores it. The value must be the JSON boolean `true`; anything else is
 * ignored by the host.
 */
const REQUIRES_USER_INTERACTION = 'anthropic/requiresUserInteraction';

/**
 * The version this package shipped at, read from its own manifest so it cannot
 * drift from what npm installed. `dist/` sits one level under the package root
 * in both this repo and the published tarball, and npm always ships
 * `package.json`, so the relative path holds for the ESM and the CJS build
 * alike — tsup's `shims` option supplies `import.meta.url` to the CJS output.
 *
 * It was a string literal until ONT-101 (#163), and it read `0.1.0` while the
 * package was on `0.1.3`. `serverInfo.version` is what a client displays and
 * what a user quotes in a bug report, so it is where diagnosis starts.
 *
 * A build that cannot find its own manifest reports `unknown` rather than
 * falling back to a number: an obviously absent version costs a reader one
 * question, and a plausible wrong one costs them the whole investigation.
 */
const readShippedVersion = (): string => {
  try {
    const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

    return (JSON.parse(manifest) as { version: string }).version;
  } catch {
    return 'unknown';
  }
};

/**
 * Operator-side sink for the FULL, unredacted failure text (§3.10). The agent
 * gets the redacted form; this is where the driver message actually survives,
 * keyed by the same `correlationId` the agent was handed.
 *
 * Defaults to STDERR: on a stdio transport stdout IS the JSON-RPC channel, so
 * stderr is the only stream a server may write to (the same rule the CLI's
 * startup signal follows). Injectable so a host can route it into its own
 * logger instead.
 */
export type ReportFailure = (args: {
  status: ReportedStatus;
  tool: string;
  correlationId: string;
  error: string;
}) => void;

/**
 * What the operator sink can be called with.
 *
 * `audit_unrecorded` is not a {@link FailureStatus} — the redaction table is
 * written for calls that did nothing, and this one's write already landed — but
 * its store error has no audit home BY DEFINITION (the append is what failed,
 * marker and all), so this sink is the only place that text survives at all
 * (ONT-071).
 */
export type ReportedStatus = FailureStatus | 'audit_unrecorded';

const defaultReportFailure: ReportFailure = ({ status, tool, correlationId, error }) => {
  process.stderr.write(`orangerail: ${status} in "${tool}" [${correlationId}]: ${error}\n`);
};

const errorMessage = ({ err }: { err: unknown }): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Split a caught value the same way the engine does: the full text for the
 * operator sink, plus the classification if the throwing layer attached one.
 * The read tools catch their resolver's throw here rather than in the engine,
 * so they need the same split or a read failure would lose its diagnostic while
 * a write kept it.
 */
const failureOf = ({ err }: { err: unknown }): { error: string; diagnostic?: PublicDiagnostic } => {
  const diagnostic = readPublicDiagnostic({ error: err });

  return { error: errorMessage({ err }), ...(diagnostic ? { diagnostic } : {}) };
};

/** Arguments to {@link createMcpServer}. */
export interface CreateMcpServerArgs {
  registry: Registry;
  store: Store;
  resolveIdentity?: ResolveIdentity;
  preset?: McpPreset;
  redactAudit?: RedactAudit;
  /**
   * Mask the PRIOR target row an audit record now carries (§3.11). Distinct
   * from `redactAudit`, which is written against an action's input and would
   * silently under-mask a row — supplying `redactAudit` alone withholds the row
   * instead of guessing. See `RedactPrior` in `orangerail-core`.
   */
  redactPrior?: RedactPrior;
  /** Where the FULL failure text goes (§3.10). Defaults to STDERR. */
  reportFailure?: ReportFailure;
  /**
   * Secure default (§3.3 / AC-4): with NO `resolveIdentity` adapter, dev mode is
   * entered only when this is explicitly `true`. Defaults to `false`, so a
   * no-adapter server treats every caller as unauthenticated (deny-first) rather
   * than the all-roles `local-dev` identity. A typed arg, NOT an env flag — the
   * zero-`process.env`-reads property is preserved.
   */
  allowDevMode?: boolean;
  /**
   * Engage the host's own permission prompt for some action tools (ONT-048).
   * Defaults to `'off'` — see {@link HostApprovalPrompt} for why this is opt-in
   * and why it is never a substitute for the gate in this process.
   */
  hostApprovalPrompt?: HostApprovalPrompt;
}

type ToolDef =
  | {
      kind: 'get';
      name: string;
      description: string;
      inputSchema: JsonSchema;
      object: ObjectDefinition;
    }
  | {
      kind: 'list';
      name: string;
      description: string;
      inputSchema: JsonSchema;
      object: ObjectDefinition;
      /**
       * The fields this object may be filtered on, derived once at build time.
       * The SAME value renders the advertised schema and gates the call, so the
       * two cannot drift apart.
       */
      filterSpec: FilterSpec;
    }
  | {
      kind: 'action';
      name: string;
      description: string;
      inputSchema: JsonSchema;
      action: RuntimeAction;
      /** Emit the host's always-prompt annotation for this tool (ONT-048). */
      requiresUserInteraction: boolean;
    }
  | { kind: 'check'; name: string; description: string; inputSchema: JsonSchema };

/** Every tool handler returns an MCP `CallToolResult` (content + structured). */
type ToolResult = CallToolResult;

const text = ({ value }: { value: string }): { type: 'text'; text: string }[] => [
  { type: 'text', text: value },
];

const ok = ({
  message,
  structured,
}: {
  message: string;
  structured: Record<string, unknown>;
}): ToolResult => ({ content: text({ value: message }), structuredContent: structured });

/**
 * A payload on its way out of a tool, with every `BigInt` in it rendered as a
 * decimal string (ONT-068) — returned once and used for BOTH halves of the
 * result, so `content` and `structuredContent` cannot describe different values.
 *
 * `JSON.stringify` throws on a `BigInt`, and so does the SDK's own serialization
 * of `structuredContent`, so one unrendered value turns a SUCCESSFUL read or
 * write into `internal_error` — the one status that carries no actionable text.
 * Generated resolvers and every action already render before the value gets
 * here; this is the transport's own boundary, and it holds for a hand-written
 * resolver that has not been touched.
 */
const outbound = ({ value }: { value: unknown }): { value: unknown; json: string } => {
  const rendered = renderBigInts({ value });

  return { value: rendered, json: JSON.stringify(rendered) };
};

/**
 * What a read tool serves for one value, checked against the schema its object
 * declares (ONT-074 AC-5).
 *
 * The verdict is computed over the WIRE FORM — the value after `renderBigInts`
 * and a JSON round trip — and not over the row the resolver handed back, because
 * the wire form is what the agent holds. The difference is not academic: a
 * generated Prisma ontology maps `DateTime` and `Decimal` to `z.string()`
 * (`codegen/zod.ts:60,63`) and returns a `Date` and a `Decimal` OBJECT from the
 * resolver, so a verdict taken off the row would mark `createdAt` on every real
 * project while the agent was receiving a perfectly conforming ISO string. Each
 * consumer asks about the value it holds; that is the same rule the gate follows
 * when it asks about the raw row `evaluateWhere` reads.
 *
 * A conforming value takes the SAME two returns it took before this ticket —
 * `page.json` and `page.value`, not a re-serialization of the round trip — so an
 * ordinary read is byte-identical.
 */
const servedValue = ({
  object,
  value,
  json,
  wire,
}: {
  object: ObjectDefinition;
  /** The rendered value, returned as-is when nothing is wrong with it. */
  value: unknown;
  /** Its JSON, likewise. */
  json: string;
  /** The JSON round trip — what the agent ends up holding. */
  wire: unknown;
}): { value: unknown; json: string; issues: ConformanceIssue[] } => {
  const conformance = checkConformance({ schema: object.schema, value: wire });

  if (conformance.state === 'conforming') {
    return { value, json, issues: [] };
  }

  const marked = markNonconforming({ value: wire, conformance, objectName: object.name });

  return { value: marked.value, json: JSON.stringify(marked.value), issues: marked.issues };
};

/**
 * The list a marked read carries beside the value it marked.
 *
 * zod's message can quote the value it refused, and here that is fine and
 * deliberate: this is a READ, the caller is authorized for this object, and the
 * value is in the payload above it. The same sentence is withheld from the agent
 * at the `where` gate (`nonconformingTarget`), where the caller may have no read
 * access to the target at all.
 */
const nonconformingList = ({
  issues,
  prefix = [],
}: {
  issues: ConformanceIssue[];
  prefix?: (string | number)[];
}): { path: string; reason: string }[] =>
  issues.map((issue) => ({
    path: renderConformancePath({ path: [...prefix, ...issue.path] }),
    reason: issue.message,
  }));

const err = ({
  status,
  message,
  extra,
}: {
  status: string;
  message: string;
  extra?: Record<string, unknown>;
}): ToolResult => ({
  content: text({ value: message }),
  isError: true,
  structuredContent: { status, ...(extra ?? {}) },
});

/** Build the tool table; validates names and rejects collisions at build time. */
const buildTools = ({
  registry,
  preset,
  hostApprovalPrompt,
}: {
  registry: Registry;
  preset: McpPreset;
  hostApprovalPrompt: HostApprovalPrompt;
}): ToolDef[] => {
  const tools: ToolDef[] = [];
  const seen = new Set<string>();

  // Read once, up front: the sentence is identical for both of an object's read
  // tools, and `listLinks()` is a snapshot the tool table is built from exactly
  // like `listObjects()` is.
  const relations = relationLines({ links: registry.listLinks() });

  const add = ({ tool }: { tool: ToolDef }): void => {
    validateToolName({ name: tool.name });

    if (seen.has(tool.name)) {
      throw new Error(`duplicate MCP tool name: "${tool.name}"`);
    }

    seen.add(tool.name);
    tools.push(tool);
  };

  for (const object of registry.listObjects()) {
    if (!object.resolve) {
      continue;
    }

    // Both read tools carry the object's relation sentence, not just `_list`.
    // They are independent entries in `tools/list` and a host that surfaces one
    // without the other — tool search, a filtered tool set — must not be the
    // reason an agent never learns the domain has edges. The cost is one short
    // clause repeated once per object; an object with no links pays nothing.
    const relation = relations.get(object.name);
    const describe = ({ base }: { base: string }): string =>
      relation === undefined ? base : `${base} ${relation}`;

    add({
      tool: {
        kind: 'get',
        name: `${object.name}_get`,
        description: describe({ base: `Fetch a single ${object.name} by id.` }),
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        object,
      },
    });

    if (object.resolve.list) {
      const filterSpec = deriveFilterSpec({ schema: object.schema });
      const { filter, defs } = deriveFilterSchema({ spec: filterSpec });

      add({
        tool: {
          kind: 'list',
          name: `${object.name}_list`,
          description: describe({ base: `List ${object.name} records.` }),
          inputSchema: {
            type: 'object',
            properties: { filter, cursor: { type: 'string' }, limit: { type: 'number' } },
            additionalProperties: false,
            // Absent entirely when the object has no filterable scalar field, so
            // a filter-less object's payload gains no empty container.
            ...(Object.keys(defs).length === 0 ? {} : { $defs: defs }),
          },
          object,
          filterSpec,
        },
      });
    }
  }

  if (preset !== 'readonly') {
    for (const action of registry.listActions()) {
      const governed = action.policy?.approval === 'required';

      // Keyed off what the DECLARATION says, not off what the current preset
      // happens to do with it. `sandbox` still annotates: it exists to rehearse
      // the live wiring, and silently muting a flag the operator turned on is a
      // worse surprise than a prompt in front of a dry run.
      const requiresUserInteraction =
        hostApprovalPrompt === 'all-actions' ||
        (hostApprovalPrompt === 'ungoverned-actions' && !governed);

      add({
        tool: {
          kind: 'action',
          name: action.name,
          description: governed
            ? `Stage the "${action.name}" action for human approval.`
            : `Run the "${action.name}" action.`,
          inputSchema: deriveInputSchema({ schema: action.input }),
          action,
          requiresUserInteraction,
        },
      });
    }

    add({
      tool: {
        kind: 'check',
        name: 'check_approval',
        description:
          'Check a staged approval by id; when approved, completes execution and returns the result.',
        inputSchema: {
          type: 'object',
          properties: { approvalId: { type: 'string' } },
          required: ['approvalId'],
          additionalProperties: false,
        },
      },
    });
  }

  return tools;
};

/**
 * Turns a core {@link FailureDetail} into the agent-facing result: reports the
 * full text to the operator sink, returns only the redacted form (§3.10).
 * Bound per tool call, so every failure path is forced through one funnel —
 * there is no branch left that can hand `result.error` to the client.
 */
type FailureMapper = (args: {
  status: FailureStatus;
  error: string;
  correlationId: string;
  /** Overrides the status default where the text has no audit home. */
  channel?: FailureChannel;
  /** The classification core attached, when the failure was diagnosable. */
  diagnostic?: PublicDiagnostic;
}) => ToolResult;

/** The `invalidated` reasons core can report (§3.4). */
type InvalidatedReason = Extract<ExecuteResult, { status: 'invalidated' }>['reason'];

/**
 * What an agent is told about an `invalidated` outcome (ONT-058).
 *
 * `Invalidated (<reason>).` was the whole message, and for `stale_approval` it
 * left the agent holding a word that reads like an accusation and no next move
 * — which is how one agent concluded, and reported, that orangerail could not
 * complete a governed write at all. The reason token itself is already part of
 * the agent-facing vocabulary (`signature`, `schema`, `input` all ship in
 * `extra.reason`), so a fourth member discloses nothing new; the sentence is
 * the fix.
 *
 * What the sentence deliberately does NOT say: that two copies of
 * `orangerail-core` are loaded, or which versions they are. That is the
 * operator's install topology, the agent cannot act on it, and it is not this
 * transport's to hand to an untrusted caller — the CLI says it, to the person
 * who can fix it. The agent gets the one fact it can act on (this approval is
 * spent; re-stage) and a pointer at the surface that holds the rest.
 *
 * And NOT a {@link PublicDiagnostic}. That set is closed on purpose and every
 * member exists because a DATASOURCE failure would otherwise be redacted down
 * to nothing — the code is the only channel left. `invalidated` carries no
 * redacted text and never has: its reason survives the boundary intact, so
 * routing the same fact through the diagnostic enum would widen the closed set
 * to buy a second name for something already said.
 */
/** The one outcome whose side effect already happened (§3.5 / ONT-069). */
type UnrecordedResult = Extract<ExecuteResult, { status: 'audit_unrecorded' }>;

/** Renders {@link UnrecordedResult}, bound per tool call so it can report first. */
type UnrecordedMapper = (args: { result: UnrecordedResult }) => ToolResult;

/**
 * What an agent is told when the write LANDED and nothing recorded it (ONT-071).
 *
 * This is the most consequential sentence here, and the two ways to get it wrong
 * pull in opposite directions. Call it a success and the agent carries on
 * believing the audit chain knows about a write it does not — the silent path
 * `audit_unrecorded` exists to remove. Call it an ordinary failure — which is
 * what `default` did, as `"Unexpected execute result."` with status `error` —
 * and an agent that has just been told its write failed does the one thing that
 * must not happen: it retries, and the write happens twice. That reintroduces at
 * the transport layer exactly the duplicate-write behaviour ONT-069 removed from
 * the engine.
 *
 * So the sentence carries BOTH halves and then the instruction, in that order:
 * the effect landed, no record of it exists, do not retry. "Do not re-stage" is
 * there for the gated path, where the approval behind this call is already
 * spent: re-staging is not a retry of this call, it is a second authorization
 * for a second write, and the sentence must not read as an invitation to it.
 *
 * The store error itself is NOT here, by the same rule every other failure on
 * this path follows: it names paths and errnos, the agent cannot act on it, and
 * the correlationId is the handle that takes an operator to the chain state and
 * to the full text in the host log.
 */
const unrecordedMessage = ({ correlationId }: { correlationId: string }): string =>
  'Executed, and NOT recorded. The action ran and its side effect has already landed — the write ' +
  'is done — but the audit chain holds no terminal record of it, not even the minimal marker, ' +
  'because the store refused every append. Do NOT retry this call and do NOT re-stage the ' +
  'action: either one repeats a write that has already happened. The store error is withheld; ' +
  'an operator can read it in the host log and reconcile the chain under correlationId ' +
  `"${correlationId}". Report that id and treat the action as done.`;

/**
 * The action's own return value, carried back under a status that is not
 * `executed`.
 *
 * The write happened, so this is the only copy of what it produced. An agent
 * that is refused it has one obvious way to go and get it, and that way is the
 * retry this whole branch exists to prevent.
 *
 * Rendered exactly like a successful result, and a value the transport cannot
 * serialize is NAMED rather than dropped: the SDK serializes
 * `structuredContent` after this handler has returned, outside every catch in
 * this file, so one exotic field in a returned row would otherwise take the
 * sentence above it down and hand the agent a transport error instead.
 */
const carriedResult = ({ value }: { value: unknown }): Record<string, unknown> => {
  try {
    return { result: outbound({ value }).value };
  } catch {
    return { resultWithheld: 'the action returned a value this transport could not serialize' };
  }
};

/**
 * The refusal for a target row that does not match the shape its object declares
 * (ONT-074 AC-4).
 *
 * The FIELD is named and the reason is not. The field is already published — it
 * is in the tool description that renders the `where` clause — so naming it
 * costs nothing and is the whole difference between an agent that reports
 * something an operator can act on and one that reports "it did not work".
 * `reason` carries zod's own sentence, which quotes the value it refused, and
 * that is a STORED value on an object the caller may have no read access to at
 * all; it stays on the audit record, where §3.10 keeps every other
 * operator-facing text.
 *
 * Distinct from `rejected_where` on the wire for the same reason it is distinct
 * in the engine: retrying is pointless here, and an agent that cannot tell the
 * two apart will retry.
 */
const nonconformingTarget = ({
  result,
}: {
  result: { field: string; reason: string };
}): ToolResult =>
  err({
    status: 'target_nonconforming',
    message: `The target row does not match what this ontology declares for "${result.field}", so the precondition could not be evaluated. Nothing was staged and nothing ran. This is not a retry: an operator has to reconcile the object definition with the datasource. Quote the field name.`,
    extra: { field: result.field },
  });

const invalidatedMessage = ({ reason }: { reason: InvalidatedReason }): string =>
  reason === 'stale_approval'
    ? 'Invalidated (stale_approval): this approval was recorded by an older orangerail-core than the one running, so the payload cannot be verified against it. Nothing executed and the approval is spent — stage the action again. If a fresh staging invalidates the same way, stop retrying and have the operator run `orangerail status`.'
    : `Invalidated (${reason}).`;

const mapStage = ({
  result,
  failure,
  unrecorded,
}: {
  result: StageResult;
  failure: FailureMapper;
  unrecorded: UnrecordedMapper;
}): ToolResult => {
  switch (result.status) {
    case 'approval_pending':
      return ok({
        message: `Action staged for human approval. Poll check_approval with approvalId "${result.approvalId}" once a human decides.`,
        structured: { status: 'approval_pending', approvalId: result.approvalId },
      });
    case 'executed': {
      const executed = outbound({ value: result.result });

      return ok({
        message: executed.json,
        structured: { status: 'executed', result: executed.value },
      });
    }
    case 'dry_run':
      return ok({
        message: 'Dry-run recorded (sandbox preset) — no execution occurred.',
        structured: { status: 'dry_run' },
      });
    case 'not_implemented':
      return err({ status: 'not_implemented', message: 'This action is not implemented.' });
    case 'denied':
      return err({ status: 'denied', message: 'Staging denied: anonymous caller (deny-first).' });
    case 'not_found':
      return err({ status: 'not_found', message: 'Action not found.' });
    // The refusal names the field and what it wanted, in the TEXT content —
    // `structuredContent` carried the raw zod issues all along, and the agent in
    // the ONT-061 evidence never saw them, because a tool with no `outputSchema`
    // is rendered from `content` by every client we have observed. A one-sentence
    // "it was wrong" against a type-erased schema is an unsolvable puzzle.
    case 'invalid_input': {
      const issues = describeInputIssues({ issues: result.issues });

      return err({
        status: 'invalid_input',
        message:
          issues.length === 0
            ? 'Input failed schema validation.'
            : `Input rejected: ${issues.join('; ')}.`,
        extra: { issues },
      });
    }
    case 'rejected_where':
      return err({ status: 'rejected_where', message: 'Precondition (where) not satisfied.' });
    case 'target_nonconforming':
      return nonconformingTarget({ result });
    case 'resolve_error':
      return failure({ ...result, status: 'resolve_error' });
    case 'condition_changed':
      return err({ status: 'condition_changed', message: 'Target changed since staging.' });
    case 'invalidated':
      return err({
        status: 'invalidated',
        message: invalidatedMessage({ reason: result.reason }),
        extra: { reason: result.reason },
      });
    case 'audit_blocked':
      return failure({ ...result, status: 'audit_blocked' });
    // An UNGOVERNED action executes on the staging call, so this outcome reaches
    // an agent through `stage` as readily as through `execute`. One mapper for
    // both: the sentence cannot be right on one path and missing on the other.
    case 'audit_unrecorded':
      return unrecorded({ result });
    case 'failed':
      return failure({ ...result, status: 'failed' });
    case 'consume_failed':
      return err({ status: 'consume_failed', message: `Consume failed (${result.reason}).` });
    // Still here, and still reachable: an older `orangerail-core` can hand up a
    // status this build has never heard of, and saying so plainly beats
    // rendering it as something it is not.
    default:
      return err({ status: 'error', message: 'Unexpected stage result.' });
  }
};

const mapExecute = ({
  result,
  failure,
  unrecorded,
}: {
  result: ExecuteResult;
  failure: FailureMapper;
  unrecorded: UnrecordedMapper;
}): ToolResult => {
  switch (result.status) {
    case 'executed': {
      const executed = outbound({ value: result.result });

      return ok({
        message: executed.json,
        structured: { status: 'executed', result: executed.value },
      });
    }
    case 'dry_run':
      // Sandbox preset (§3.6 / ONT-040): the approval is left untouched — not
      // consumed, not executed — so a live server sharing the store can still
      // complete it.
      return ok({
        message: 'Dry-run recorded (sandbox preset) — the approval was not executed.',
        structured: { status: 'dry_run' },
      });
    case 'consume_failed':
      return result.reason === 'already_consumed'
        ? ok({ message: 'Already executed (consumed).', structured: { status: 'consumed' } })
        : err({ status: 'consume_failed', message: `Consume failed (${result.reason}).` });
    case 'invalidated':
      return err({
        status: 'invalidated',
        message: invalidatedMessage({ reason: result.reason }),
        extra: { reason: result.reason },
      });
    case 'condition_changed':
      return err({ status: 'condition_changed', message: 'Target changed since approval.' });
    case 'target_nonconforming':
      return nonconformingTarget({ result });
    case 'resolve_error':
      return failure({ ...result, status: 'resolve_error' });
    case 'audit_blocked':
      return failure({ ...result, status: 'audit_blocked' });
    case 'audit_unrecorded':
      return unrecorded({ result });
    case 'failed':
      return failure({ ...result, status: 'failed' });
    // See the note on the `default` in `mapStage` — a status from a core this
    // build predates still has to arrive as something, and not as a guess.
    default:
      return err({ status: 'error', message: 'Unexpected execute result.' });
  }
};

/**
 * Generate a governed MCP server from an ontology registry (AC-2, §3.2).
 *
 * Uses the low-level `Server` with explicit `tools/list` + `tools/call`
 * handlers (NOT `McpServer.registerTool`, NOT experimental tasks): input
 * validation stays in exactly one place — the engine — so there is no
 * double-parse drift. Read objects with `resolve` become `<name>_get` /
 * `<name>_list` tools (`authenticated` objects deny anonymous callers); each
 * action becomes a tool that stages through the engine; `check_approval` is the
 * re-check surface that runs `engine.execute` IN THIS PROCESS once approved.
 *
 * A read tool is described FROM the registry, not from a template, and the
 * description is BINDING. `_list` publishes the object's own declared fields as
 * a closed `filter` schema, and `handleList` refuses anything that schema does
 * not admit — a `filter` used to reach `resolve.list` untouched, which for a
 * generated Prisma resolver made it a `where` clause and let a caller traverse
 * into an object type the operator never exposed (see `filter.ts`). Both read
 * tools also name the object's links, which is knowledge and nothing more: the
 * read surface is still get-by-id plus a filtered, paginated list, with no join,
 * aggregate or traversal tool, and it must not grow one.
 *
 * Presets: `readonly` (no action tools, no check_approval), `sandbox` (engine
 * dry-run mode), `approval-for-writes` (default; actions as declared).
 *
 * `hostApprovalPrompt` (default `'off'`) optionally annotates action tools with
 * `_meta["anthropic/requiresUserInteraction"]`, which asks a host that supports
 * it to run its OWN permission prompt before the call. It is enforced by the
 * client, so it is a second checkpoint on top of this server's gate and never a
 * replacement for it — see {@link HostApprovalPrompt}.
 *
 * Failures are redacted before they reach the caller (§3.10): the agent gets a
 * stable status, a domain-level cause, and a `correlationId`; the full driver
 * text goes to {@link ReportFailure} (stderr by default) and, where one exists,
 * the audit record for that same id.
 */
export const createMcpServer = ({
  registry,
  store,
  resolveIdentity,
  preset = 'approval-for-writes',
  redactAudit,
  redactPrior,
  reportFailure = defaultReportFailure,
  allowDevMode = false,
  hostApprovalPrompt = 'off',
}: CreateMcpServerArgs): { server: Server; serve: () => Promise<void> } => {
  const engine = createEngine({
    registry,
    store,
    mode: preset === 'sandbox' ? 'dry_run' : 'live',
    ...(redactAudit ? { redactAudit } : {}),
    ...(redactPrior ? { redactPrior } : {}),
  });

  const idConfig = {
    transport: 'stdio' as const,
    allowDevMode,
    ...(resolveIdentity ? { resolveIdentity } : {}),
  };

  const tools = buildTools({ registry, preset, hostApprovalPrompt });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const failureFor =
    ({ tool }: { tool: string }): FailureMapper =>
    ({ status, error, correlationId, channel, diagnostic }) => {
      reportFailure({ status, tool, correlationId, error });

      const redacted = redactFailure({
        status,
        tool,
        correlationId,
        ...(channel ? { channel } : {}),
        ...(diagnostic ? { diagnostic } : {}),
      });

      return err({
        status: redacted.status,
        message: redacted.message,
        extra: {
          correlationId,
          ...(redacted.diagnostic ? { diagnostic: redacted.diagnostic } : {}),
        },
      });
    };

  // Reports before it answers, for the same reason every failure does: the
  // agent's half is the sentence, and the operator's half is the store error
  // that has nowhere else left to be.
  const unrecordedFor =
    ({ tool }: { tool: string }): UnrecordedMapper =>
    ({ result }) => {
      reportFailure({
        status: 'audit_unrecorded',
        tool,
        correlationId: result.correlationId,
        error: result.error,
      });

      return err({
        status: 'audit_unrecorded',
        message: unrecordedMessage({ correlationId: result.correlationId }),
        extra: { correlationId: result.correlationId, ...carriedResult({ value: result.result }) },
      });
    };

  const server = new Server(
    { name: 'orangerail', version: readShippedVersion() },
    { capabilities: { tools: {} } },
  );

  // `_meta` is only ever present when `hostApprovalPrompt` selected this tool, so
  // the default listing is byte-identical to one built without the feature —
  // which is what keeps every tool-set comparison in the e2e suite untouched.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.kind === 'action' && tool.requiresUserInteraction
        ? { _meta: { [REQUIRES_USER_INTERACTION]: true } }
        : {}),
    })),
  }));

  const handleGet = async ({
    object,
    args,
    caller,
    failure,
  }: {
    object: ObjectDefinition;
    args: Record<string, unknown>;
    caller: Identity | null;
    failure: FailureMapper;
  }): Promise<ToolResult> => {
    if (object.readAccess === 'authenticated' && caller === null) {
      return err({ status: 'denied', message: 'Authentication required to read this object.' });
    }

    const id = String(args['id'] ?? '');

    // A read resolver is datasource code too (§3.10). Uncaught, its throw would
    // escape as a JSON-RPC internal error carrying the driver text verbatim —
    // the same leak as a failing write, on a tool with no approval gate in
    // front of it. Caught here so it takes the redacted resolve_error path.
    // Reads are not audited, so the host log is the only channel to name.
    let result: unknown;
    try {
      result = await object.resolve?.get({ id });
    } catch (caught) {
      return failure({
        status: 'resolve_error',
        ...failureOf({ err: caught }),
        correlationId: randomUUID(),
        channel: 'host-log',
      });
    }

    if (result === null || result === undefined) {
      return err({ status: 'not_found', message: `No ${object.name} with id "${id}".` });
    }

    const row = outbound({ value: result });
    const served = servedValue({
      object,
      value: row.value,
      json: row.json,
      wire: JSON.parse(row.json),
    });

    return ok({
      message: served.json,
      structured: {
        status: 'ok',
        object: served.value,
        // Spread only when there is something to say, so a conforming read's
        // structured content is exactly the two keys it has always had.
        ...(served.issues.length > 0
          ? { nonconforming: nonconformingList({ issues: served.issues }) }
          : {}),
      },
    });
  };

  const handleList = async ({
    object,
    filterSpec,
    args,
    caller,
    failure,
  }: {
    object: ObjectDefinition;
    filterSpec: FilterSpec;
    args: Record<string, unknown>;
    caller: Identity | null;
    failure: FailureMapper;
  }): Promise<ToolResult> => {
    if (object.readAccess === 'authenticated' && caller === null) {
      return err({ status: 'denied', message: 'Authentication required to list this object.' });
    }

    // The gate that makes the advertised filter schema true. `filter` used to go
    // to the resolver untouched, and for a generated Prisma resolver that is
    // `findMany({ where: filter })` — a relation predicate reached straight into
    // an object type the operator never exposed. Checked HERE rather than in
    // generated code so a hand-written resolver is covered identically, and so
    // the check sits on the same boundary as the schema that describes it.
    if (args['filter'] !== undefined) {
      const issues = validateFilter({ filter: args['filter'], spec: filterSpec });

      if (issues.length > 0) {
        return err({
          status: 'invalid_input',
          message: `Filter rejected: ${issues.join('; ')}.`,
          extra: { issues },
        });
      }
    }

    const listArgs = {
      ...(args['filter'] !== undefined
        ? { filter: args['filter'] as Record<string, unknown> }
        : {}),
      ...(args['cursor'] !== undefined ? { cursor: String(args['cursor']) } : {}),
      ...(args['limit'] !== undefined ? { limit: Number(args['limit']) } : {}),
    };
    // Same fail-closed guard as `handleGet` — a throwing list adapter must not
    // escape uncaught with its driver text attached (§3.10).
    let result: ResolveListResult<unknown> | undefined;
    try {
      result = await object.resolve?.list?.(listArgs);
    } catch (caught) {
      return failure({
        status: 'resolve_error',
        ...failureOf({ err: caught }),
        correlationId: randomUUID(),
        channel: 'host-log',
      });
    }

    const page = outbound({ value: result ?? { items: [] } });

    // The declared schema describes ONE row, so the page is checked row by row
    // rather than as a whole — `items` and `nextCursor` are this transport's own
    // envelope and no ontology declares them.
    const wire = JSON.parse(page.json) as Record<string, unknown>;
    const rows: unknown[] = Array.isArray(wire['items']) ? wire['items'] : [];
    const checked = rows.map((row) => {
      const conformance = checkConformance({ schema: object.schema, value: row });

      return markNonconforming({ value: row, conformance, objectName: object.name });
    });
    const nonconforming = checked.flatMap((row, index) =>
      nonconformingList({ issues: row.issues, prefix: ['items', index] }),
    );

    if (nonconforming.length === 0) {
      return ok({
        message: page.json,
        structured: { status: 'ok', ...(page.value as Record<string, unknown>) },
      });
    }

    const marked = { ...wire, items: checked.map((row) => row.value) };

    return ok({
      message: JSON.stringify(marked),
      structured: { status: 'ok', ...marked, nonconforming },
    });
  };

  const handleCall = async ({
    name,
    args,
    failure,
    unrecorded,
  }: {
    name: string;
    args: Record<string, unknown>;
    failure: FailureMapper;
    unrecorded: UnrecordedMapper;
  }): Promise<ToolResult> => {
    const tool = byName.get(name);
    if (!tool) {
      return err({ status: 'unknown_tool', message: `Unknown tool: ${name}` });
    }

    const caller = await resolveCaller({ config: idConfig });

    if (tool.kind === 'get') {
      return handleGet({ object: tool.object, args, caller, failure });
    }
    if (tool.kind === 'list') {
      return handleList({
        object: tool.object,
        filterSpec: tool.filterSpec,
        args,
        caller,
        failure,
      });
    }
    if (tool.kind === 'action') {
      return mapStage({
        result: await engine.stage({ actionName: tool.action.name, input: args, caller }),
        failure,
        unrecorded,
      });
    }

    // check_approval — require a non-anonymous caller before touching the
    // approval (§3.5 / AC-6). Under the secure default a no-adapter no-opt-in
    // server yields caller === null here, so an anonymous connector can no
    // longer trigger a governed completion by knowing an approvalId.
    if (caller === null) {
      return err({ status: 'denied', message: 'Authentication required to check an approval.' });
    }

    const approvalId = String(args['approvalId'] ?? '');
    const record = await store.getApproval({ id: approvalId });

    if (!record) {
      return err({ status: 'not_found', message: `No approval with id "${approvalId}".` });
    }
    if (record.status === 'pending') {
      return ok({ message: 'Still pending human approval.', structured: { status: 'pending' } });
    }
    if (record.status === 'rejected') {
      return ok({
        message: 'Approval was rejected; a new staging is required.',
        structured: { status: 'rejected' },
      });
    }
    if (record.status === 'consumed') {
      return ok({ message: 'Already executed (consumed).', structured: { status: 'consumed' } });
    }

    return mapExecute({ result: await engine.execute({ approvalId }), failure, unrecorded });
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const failure = failureFor({ tool: name });
    const unrecorded = unrecordedFor({ tool: name });

    // Last-resort backstop (§3.10). Anything that still throws — a store read
    // inside check_approval, an identity adapter, a bug — would otherwise be
    // converted by the SDK into a JSON-RPC internal error whose `message` is
    // the raw text. Catching here means NO path out of `tools/call` carries an
    // unredacted error, which is the property the fix is actually claiming.
    try {
      return await handleCall({ name, args, failure, unrecorded });
    } catch (caught) {
      return failure({
        status: 'internal_error',
        ...failureOf({ err: caught }),
        correlationId: randomUUID(),
      });
    }
  });

  const serve = async (): Promise<void> => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  };

  return { server, serve };
};
