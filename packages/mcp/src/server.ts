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
  resolveCaller,
  type ExecuteResult,
  type Identity,
  type ObjectDefinition,
  type RedactAudit,
  type Registry,
  type ResolveIdentity,
  type ResolveListResult,
  type RuntimeAction,
  type StageResult,
  type Store,
} from 'orangerail-core';

import { validateToolName } from './names';
import { redactFailure, type FailureChannel, type FailureStatus } from './redact';
import { deriveInputSchema, type JsonSchema } from './schema';

/** Runtime preset controlling which tools are exposed and the engine mode (§3.6). */
export type McpPreset = 'readonly' | 'sandbox' | 'approval-for-writes';

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

/** Arguments to {@link createMcpServer}. */
export interface CreateMcpServerArgs {
  registry: Registry;
  store: Store;
  resolveIdentity?: ResolveIdentity;
  preset?: McpPreset;
  redactAudit?: RedactAudit;
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
    }
  | {
      kind: 'action';
      name: string;
      description: string;
      inputSchema: JsonSchema;
      action: RuntimeAction;
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
const buildTools = ({ registry, preset }: { registry: Registry; preset: McpPreset }): ToolDef[] => {
  const tools: ToolDef[] = [];
  const seen = new Set<string>();

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

    add({
      tool: {
        kind: 'get',
        name: `${object.name}_get`,
        description: `Fetch a single ${object.name} by id.`,
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
      add({
        tool: {
          kind: 'list',
          name: `${object.name}_list`,
          description: `List ${object.name} records.`,
          inputSchema: {
            type: 'object',
            properties: {
              filter: { type: 'object' },
              cursor: { type: 'string' },
              limit: { type: 'number' },
            },
            additionalProperties: false,
          },
          object,
        },
      });
    }
  }

  if (preset !== 'readonly') {
    for (const action of registry.listActions()) {
      const governed = action.policy?.approval === 'required';

      add({
        tool: {
          kind: 'action',
          name: action.name,
          description: governed
            ? `Stage the "${action.name}" action for human approval.`
            : `Run the "${action.name}" action.`,
          inputSchema: deriveInputSchema({ schema: action.input }),
          action,
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
}) => ToolResult;

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
    case 'invalid_input':
      return err({
        status: 'invalid_input',
        message: 'Input failed schema validation.',
        extra: { issues: result.issues },
      });
    case 'rejected_where':
      return err({ status: 'rejected_where', message: 'Precondition (where) not satisfied.' });
    case 'resolve_error':
      return failure({ ...result, status: 'resolve_error' });
    case 'condition_changed':
      return err({ status: 'condition_changed', message: 'Target changed since staging.' });
    case 'invalidated':
      return err({
        status: 'invalidated',
        message: `Invalidated (${result.reason}).`,
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
    case 'consume_failed':
      return result.reason === 'already_consumed'
        ? ok({ message: 'Already executed (consumed).', structured: { status: 'consumed' } })
        : err({ status: 'consume_failed', message: `Consume failed (${result.reason}).` });
    case 'invalidated':
      return err({
        status: 'invalidated',
        message: `Invalidated (${result.reason}).`,
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
 * Presets: `readonly` (no action tools, no check_approval), `sandbox` (engine
 * dry-run mode), `approval-for-writes` (default; actions as declared).
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
  reportFailure = defaultReportFailure,
  allowDevMode = false,
}: CreateMcpServerArgs): { server: Server; serve: () => Promise<void> } => {
  const engine = createEngine({
    registry,
    store,
    mode: preset === 'sandbox' ? 'dry_run' : 'live',
    ...(redactAudit ? { redactAudit } : {}),
  });

  const idConfig = {
    transport: 'stdio' as const,
    allowDevMode,
    ...(resolveIdentity ? { resolveIdentity } : {}),
  };

  const tools = buildTools({ registry, preset });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const failureFor =
    ({ tool }: { tool: string }): FailureMapper =>
    ({ status, error, correlationId, channel }) => {
      reportFailure({ status, tool, correlationId, error });

      const redacted = redactFailure({
        status,
        tool,
        correlationId,
        ...(channel ? { channel } : {}),
      });

      return err({
        status: redacted.status,
        message: redacted.message,
        extra: { correlationId },
      });
    };

  const server = new Server(
    { name: 'orangerail', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
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
        error: errorMessage({ err: caught }),
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
      return err({ status: 'denied', message: 'Authentication required to list this object.' });
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
        error: errorMessage({ err: caught }),
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
      return handleList({ object: tool.object, args, caller, failure });
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
        error: errorMessage({ err: caught }),
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
