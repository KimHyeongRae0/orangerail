/**
 * ONT-009 Mastra MCP harness — phase runner.
 *
 * A REAL `@mastra/mcp` `MCPClient` (the exact package every Mastra agent uses to
 * consume external MCP tools) connects over stdio to a generated orangerail MCP
 * server — spawned as `node <cli> mcp --config <config>` — and drives one phase
 * of the governed-write loop with NO LLM in the loop (tool discovery and direct
 * `tool.execute()` calls only, never an Agent/model round-trip).
 *
 * Invoked by the e2e driver as `node run-phase.mjs <discover|stage|check>` once
 * per OS process. Each process builds its own client (distinct `id` so Mastra's
 * config-hash dedupe never throws), performs the phase's tool calls, and prints
 * EXACTLY ONE JSON contract line to stdout — the only write to stdout in the
 * whole program. Every diagnostic goes to stderr, and the stdio transport is
 * always torn down via `disconnect()` in a `finally` block.
 *
 * Stdout contract (frozen by the driver):
 *   discover  {"phase":"discover","toolKeys":[...],"listItems":[...]}
 *   stage     {"phase":"stage","publish":{"status":"approval_pending","approvalId":"..."},"auto":{"touched":"<label>"}}
 *   check     {"phase":"check","status":"executed"}
 *
 * Env (supplied by the driver): ORANGERAIL_E2E_CLI, ORANGERAIL_E2E_CONFIG,
 * ORANGERAIL_E2E_STORE, ORANGERAIL_E2E_DATA are read every phase; stage also reads
 * ORANGERAIL_E2E_DOC_ID / _NOTE / _LABEL; check reads ORANGERAIL_E2E_APPROVAL_ID.
 * ORANGERAIL_E2E_STORE and ORANGERAIL_E2E_DATA reach the server via the inherited
 * process env (config.mjs reads them).
 */
import process from 'node:process';

import { MCPClient } from '@mastra/mcp';

/** Reads a required env var or throws a descriptive error. */
const readEnv = ({ name }) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }

  return value;
};

/** Writes a diagnostic line to stderr — never to stdout (contract purity). */
const diag = ({ message }) => {
  process.stderr.write(`[ont-009-harness] ${message}\n`);
};

/**
 * Normalizes a Mastra `tool.execute()` return into `{ shape, data }`.
 *
 * `@mastra/mcp` returns the server's `structuredContent` unwrapped when present,
 * and otherwise hands back the raw MCP `CallToolResult` (whose `content[0].text`
 * must be parsed). orangerail always emits `structuredContent`, so the observed
 * shape is expected to be `structuredContent-unwrapped`; the raw branch is kept
 * for defensive coverage and to record what actually happened.
 */
const surface = ({ result }) => {
  if (result && typeof result === 'object' && !Array.isArray(result.content)) {
    return { shape: 'structuredContent-unwrapped', data: result };
  }

  const parts = Array.isArray(result?.content) ? result.content : [];
  const textPart = parts.find((part) => part && part.type === 'text');

  let data = {};
  try {
    data = textPart ? JSON.parse(textPart.text) : {};
  } catch {
    data = {};
  }

  return { shape: 'raw-content-text', data };
};

/**
 * Builds an `MCPClient` that spawns the orangerail MCP server over stdio. The
 * child inherits the current process env (carrying the sandbox store/data dirs
 * config.mjs needs); its stderr is piped so nothing it emits can reach OUR
 * stdout.
 */
const buildClient = ({ phase }) => {
  const cli = readEnv({ name: 'ORANGERAIL_E2E_CLI' });
  const config = readEnv({ name: 'ORANGERAIL_E2E_CONFIG' });

  return new MCPClient({
    id: `ont-009-${phase}`,
    servers: {
      orangerail: {
        command: 'node',
        args: [cli, 'mcp', '--config', config],
        env: { ...process.env },
        stderr: 'pipe',
      },
    },
    timeout: 60_000,
  });
};

/** discover: list the ontology's tools and read the document backend rows. */
const runDiscover = async ({ tools }) => {
  const toolKeys = Object.keys(tools);

  const listed = surface({ result: await tools['orangerail_document_list'].execute({}) });
  diag({ message: `document_list result shape: ${listed.shape}` });

  const listItems = listed.data.items ?? [];

  return { phase: 'discover', toolKeys, listItems };
};

/** stage: stage the governed publish (approval_pending as DATA) + run the auto action. */
const runStage = async ({ tools }) => {
  const documentId = readEnv({ name: 'ORANGERAIL_E2E_DOC_ID' });
  const note = readEnv({ name: 'ORANGERAIL_E2E_NOTE' });
  const label = readEnv({ name: 'ORANGERAIL_E2E_LABEL' });

  const published = surface({
    result: await tools['orangerail_publish_document'].execute({ documentId, note }),
  });
  diag({ message: `publish_document result shape: ${published.shape}` });

  const publish = { status: published.data.status, approvalId: published.data.approvalId };

  const touched = surface({ result: await tools['orangerail_touch_counter'].execute({ label }) });
  diag({ message: `touch_counter result shape: ${touched.shape}` });

  const auto = { touched: touched.data.result?.touched ?? touched.data.touched };

  return { phase: 'stage', publish, auto };
};

/** check: a fresh session polls check_approval; the approved action executes. */
const runCheck = async ({ tools }) => {
  const approvalId = readEnv({ name: 'ORANGERAIL_E2E_APPROVAL_ID' });

  const checked = surface({
    result: await tools['orangerail_check_approval'].execute({ approvalId }),
  });
  diag({ message: `check_approval result shape: ${checked.shape}` });

  return { phase: 'check', status: checked.data.status, result: checked.data.result };
};

const PHASES = { discover: runDiscover, stage: runStage, check: runCheck };

const main = async () => {
  const phase = process.argv[2];
  const run = PHASES[phase];

  if (!run) {
    throw new Error(`unknown phase "${phase}" — expected one of ${Object.keys(PHASES).join(', ')}`);
  }

  const mcp = buildClient({ phase });

  try {
    const tools = await mcp.listTools();
    const record = await run({ tools });

    process.stdout.write(`${JSON.stringify(record)}\n`);
  } finally {
    await mcp.disconnect();
  }
};

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    diag({ message: `phase failed: ${error?.stack ?? String(error)}` });
    process.exit(1);
  });
