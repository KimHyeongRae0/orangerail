import { randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import {
  createEngine,
  readPublicDiagnostic,
  resolveCaller,
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
  status: FailureStatus;
  tool: string;
  correlationId: string;
  error: string;
}) => void;

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
const invalidatedMessage = ({ reason }: { reason: InvalidatedReason }): string =>
  reason === 'stale_approval'
    ? 'Invalidated (stale_approval): this approval was recorded by an older orangerail-core than the one running, so the payload cannot be verified against it. Nothing executed and the approval is spent — stage the action again. If a fresh staging invalidates the same way, stop retrying and have the operator run `orangerail status`.'
    : `Invalidated (${reason}).`;

const mapStage = ({
  result,
  failure,
}: {
  result: StageResult;
  failure: FailureMapper;
}): ToolResult => {
  switch (result.status) {
    case 'approval_pending':
      return ok({
        message: `Action staged for human approval. Poll check_approval with approvalId "${result.approvalId}" once a human decides.`,
        structured: { status: 'approval_pending', approvalId: result.approvalId },
      });
    case 'executed':
      return ok({
        message: JSON.stringify(result.result),
        structured: { status: 'executed', result: result.result },
      });
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
    case 'failed':
      return failure({ ...result, status: 'failed' });
    case 'consume_failed':
      return err({ status: 'consume_failed', message: `Consume failed (${result.reason}).` });
    default:
      return err({ status: 'error', message: 'Unexpected stage result.' });
  }
};

const mapExecute = ({
  result,
  failure,
}: {
  result: ExecuteResult;
  failure: FailureMapper;
}): ToolResult => {
  switch (result.status) {
    case 'executed':
      return ok({
        message: JSON.stringify(result.result),
        structured: { status: 'executed', result: result.result },
      });
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
    case 'resolve_error':
      return failure({ ...result, status: 'resolve_error' });
    case 'audit_blocked':
      return failure({ ...result, status: 'audit_blocked' });
    case 'failed':
      return failure({ ...result, status: 'failed' });
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

  const server = new Server(
    { name: 'orangerail', version: '0.1.0' },
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

    return ok({ message: JSON.stringify(result), structured: { status: 'ok', object: result } });
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

    return ok({
      message: JSON.stringify(result ?? { items: [] }),
      structured: { status: 'ok', ...(result ?? { items: [] }) },
    });
  };

  const handleCall = async ({
    name,
    args,
    failure,
  }: {
    name: string;
    args: Record<string, unknown>;
    failure: FailureMapper;
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

    return mapExecute({ result: await engine.execute({ approvalId }), failure });
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const failure = failureFor({ tool: name });

    // Last-resort backstop (§3.10). Anything that still throws — a store read
    // inside check_approval, an identity adapter, a bug — would otherwise be
    // converted by the SDK into a JSON-RPC internal error whose `message` is
    // the raw text. Catching here means NO path out of `tools/call` carries an
    // unredacted error, which is the property the fix is actually claiming.
    try {
      return await handleCall({ name, args, failure });
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
