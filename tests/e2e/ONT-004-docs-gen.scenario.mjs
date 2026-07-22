/**
 * ONT-004 e2e driver — docs-gen prompt rail (ticket §5, plan §7).
 *
 * Pure Node stdlib. Runs the real `orangerail docs` CLI against the fixture
 * ontology and asserts the generated document; then pins exposure
 * truthfulness by comparing the document's MCP tools table against the
 * live `tools/list` of a real `orangerail mcp` process (ndjson JSON-RPC,
 * no SDK client) — under the default preset and under readonly.
 *
 * Phases:
 *   A (generate)     `orangerail docs` writes .orangerail/generated/AGENTS.md
 *                    with the do-not-edit header and all required sections.
 *   B (truthfulness) governance badges exact; hostile name escaped inside
 *                    the mermaid fence; declarative + functional where
 *                    rendered per contract.
 *   C (determinism)  second run is byte-identical.
 *   D (exposure)     doc tool set EQUALS live tools/list (both directions),
 *                    default preset and readonly (action tools +
 *                    check_approval absent from both; read-only guide +
 *                    [not exposed] markers present).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const CONFIG = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-004', 'config.mjs');

const fail = ({ message }) => {
  console.error(`ASSERTION FAILED: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

/** Runs an `orangerail` CLI command to completion in a given directory. */
const runCli = ({ args, cwd, env }) => {
  const res = spawnSync('node', [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** Minimal MCP stdio session (same wire-honest client as ONT-003). */
const openSession = async ({ env }) => {
  const child = spawn('node', [CLI, 'mcp', '--config', CONFIG], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let nextId = 1;
  let buffer = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');

    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (line !== '') {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const settle = pending.get(msg.id);
          pending.delete(msg.id);
          settle(msg);
        }
      }

      idx = buffer.indexOf('\n');
    }
  });

  const send = ({ payload }) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = ({ method, params }) => {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 20_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(`MCP error for ${method}: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolve(msg.result);
      });
      send({ payload: { jsonrpc: '2.0', id, method, params } });
    });
  };

  const exited = new Promise((resolve) => child.on('exit', resolve));

  await request({
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ont-004-e2e', version: '0.0.0' },
    },
  });
  send({ payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  const close = async () => {
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
  };

  const listTools = async () => request({ method: 'tools/list', params: {} });

  return { listTools, close };
};

/** Live tool-name set from a real `orangerail mcp` process. */
const liveToolNames = async ({ env }) => {
  const session = await openSession({ env });
  const listed = await session.listTools();
  await session.close();

  return new Set(listed.tools.map((tool) => tool.name));
};

/**
 * Tool-name set the document claims, extracted from its "## MCP tools"
 * table: first cell of each data row, backticks stripped.
 */
const documentToolNames = ({ doc }) => {
  const start = doc.indexOf('## MCP tools');
  assert({ ok: start !== -1, message: 'document has no "## MCP tools" section' });

  const rest = doc.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);

  const names = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|')[1]?.trim() ?? '')
    .map((cell) => cell.replace(/`/g, ''))
    .filter((cell) => cell !== '' && cell !== 'Tool' && !/^[-\s:]+$/.test(cell));

  return new Set(names);
};

const assertSetEquality = ({ docSet, liveSet, label }) => {
  for (const name of docSet) {
    assert({
      ok: liveSet.has(name),
      message: `${label}: doc lists "${name}" but server does not serve it`,
    });
  }
  for (const name of liveSet) {
    assert({
      ok: docSet.has(name),
      message: `${label}: server serves "${name}" but doc does not list it`,
    });
  }
};

/** Generate docs in a fresh sandbox cwd; returns the document text. */
const generate = ({ env }) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ont-004-'));
  const result = runCli({ args: ['docs', '--config', CONFIG], cwd: sandbox, env });
  assert({ ok: result.status === 0, message: `orangerail docs failed: ${result.stderr}` });

  const outPath = join(sandbox, '.orangerail', 'generated', 'AGENTS.md');
  assert({ ok: existsSync(outPath), message: `expected output at ${outPath}` });

  return readFileSync(outPath, 'utf8');
};

const main = async () => {
  // ---- Phase A: generation, header, sections ----
  console.log('Phase A: generate + sections');

  const doc = generate({ env: {} });

  assert({ ok: doc.includes('DO NOT EDIT'), message: 'do-not-edit header missing' });

  for (const section of [
    '# Domain ontology',
    '## How to act in this domain',
    '## Domain map',
    '## MCP tools',
    '## Object types',
    '## Link types',
    '## Action types',
  ]) {
    assert({ ok: doc.includes(section), message: `section missing: ${section}` });
  }

  // ---- Phase B: truthful governance + escaping ----
  console.log('Phase B: governance badges + escaping');

  for (const marker of [
    '[approval required]',
    'approvers: editor',
    'approver: unspecified',
    '[auto]',
    '[stub — not implemented]',
    'custom code predicate',
    'only when status eq "draft"',
  ]) {
    assert({ ok: doc.includes(marker), message: `marker missing: ${marker}` });
  }

  // Every declared entity is documented — nothing silently dropped (AC-2).
  for (const name of [
    'product',
    'internal_note',
    'product_notes',
    'publish_product',
    'discount_product',
    'touch_counter',
    'sync_catalog',
  ]) {
    assert({ ok: doc.includes(name), message: `declared entity missing from doc: ${name}` });
  }

  const fenceStart = doc.indexOf('```mermaid');
  assert({ ok: fenceStart !== -1, message: 'mermaid fence missing' });
  const fenceEnd = doc.indexOf('```', fenceStart + '```mermaid'.length);
  assert({ ok: fenceEnd !== -1, message: 'mermaid fence not closed' });
  const fence = doc.slice(fenceStart, fenceEnd);

  assert({
    ok: fence.includes('weird'),
    message: 'hostile-named object absent from the mermaid diagram',
  });
  assert({
    ok: !fence.includes('weird "spec|al"'),
    message: 'hostile name appears RAW (unescaped) inside the mermaid fence',
  });

  // Read-tool names are verbatim tool names, not prose shorthands.
  assert({
    ok: doc.includes('product_get'),
    message: 'verbatim read tool name product_get missing',
  });
  assert({
    ok: doc.includes('product_list'),
    message: 'verbatim read tool name product_list missing',
  });

  // ---- Phase C: determinism ----
  console.log('Phase C: determinism');

  const second = generate({ env: {} });
  assert({ ok: second === doc, message: 'two runs are not byte-identical' });

  // ---- Phase D: exposure truthfulness (set equality, both presets) ----
  console.log('Phase D: exposure equality vs live tools/list');

  const docTools = documentToolNames({ doc });
  const liveTools = await liveToolNames({ env: {} });
  assertSetEquality({ docSet: docTools, liveSet: liveTools, label: 'default preset' });
  assert({
    ok: docTools.has('check_approval'),
    message: 'default preset doc must list check_approval',
  });

  const readonlyEnv = { ORANGERAIL_E2E_PRESET: 'readonly' };
  const readonlyDoc = generate({ env: readonlyEnv });

  assert({
    ok: readonlyDoc.includes('[not exposed — readonly preset]'),
    message: 'readonly doc lacks the [not exposed — readonly preset] marker',
  });
  assert({
    ok: readonlyDoc.includes('read-only'),
    message: 'readonly doc lacks a read-only agent guide statement',
  });

  const readonlyDocTools = documentToolNames({ doc: readonlyDoc });
  const readonlyLiveTools = await liveToolNames({ env: readonlyEnv });
  assertSetEquality({
    docSet: readonlyDocTools,
    liveSet: readonlyLiveTools,
    label: 'readonly preset',
  });

  for (const gone of [
    'publish_product',
    'discount_product',
    'touch_counter',
    'sync_catalog',
    'check_approval',
  ]) {
    assert({
      ok: !readonlyDocTools.has(gone),
      message: `readonly doc still lists action-side tool "${gone}"`,
    });
  }
  assert({
    ok: readonlyDocTools.has('product_get') && readonlyDocTools.has('product_list'),
    message: 'readonly doc must still list the read tools',
  });

  console.log('ONT-004 docs-gen scenario: all assertions passed');
};

await main();
