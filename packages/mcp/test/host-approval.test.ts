import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMemoryStore, createRegistry } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMcpServer, type HostApprovalPrompt, type McpPreset } from '../src/server';

/**
 * ONT-048 — the host's own always-prompt annotation.
 *
 * These tests pin the tool SET that carries
 * `_meta["anthropic/requiresUserInteraction"]`, per mode and per preset, so a
 * future change to tool emission cannot silently flip it. The key is written as
 * a literal here on purpose: it is a wire contract with Claude Code, and a
 * rename of the constant in `server.ts` must fail here rather than pass.
 *
 * The listing is fetched through a real SDK `Client`, so every assertion below
 * has also survived `ListToolsResultSchema` — which is the check that proves a
 * vendor `_meta` key is not stripped or rejected on the way out.
 */
const META_KEY = 'anthropic/requiresUserInteraction';

const buildRegistry = () => {
  const registry = createRegistry();

  const document = registry.defineObject({
    name: 'document',
    schema: z.object({ id: z.string(), title: z.string(), status: z.string() }),
    resolve: {
      get: async ({ id }) => ({ id, title: 'Doc', status: 'draft' }),
      list: async () => ({ items: [{ id: 'd1', title: 'Doc', status: 'draft' }] }),
    },
  });

  // Governed: STAGES an approval and returns an id. Calling it has no effect.
  registry.defineAction({
    name: 'publish_document',
    target: document,
    input: z.object({ documentId: z.string(), note: z.string() }),
    policy: { approval: 'required' },
    execute: async ({ input }) => ({ published: input.documentId }),
  });

  registry.defineAction({
    name: 'archive_document',
    target: document,
    input: z.object({ documentId: z.string() }),
    policy: { approval: 'required' },
    execute: async ({ input }) => ({ archived: input.documentId }),
  });

  // Ungoverned: EXECUTES on call. No orangerail gate in front of it.
  registry.defineAction({
    name: 'touch_counter',
    input: z.object({ label: z.string() }),
    execute: async ({ input }) => ({ touched: input.label }),
  });

  return registry;
};

/** The raw `tools/list` entries, exactly as an SDK client parses them. */
const listTools = async ({
  hostApprovalPrompt,
  preset,
}: {
  hostApprovalPrompt?: HostApprovalPrompt;
  preset?: McpPreset;
} = {}): Promise<{ name: string; _meta?: Record<string, unknown> | undefined }[]> => {
  const { server } = createMcpServer({
    registry: buildRegistry(),
    store: createMemoryStore(),
    allowDevMode: true,
    ...(hostApprovalPrompt ? { hostApprovalPrompt } : {}),
    ...(preset ? { preset } : {}),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return (await client.listTools()).tools;
};

/** Names of the tools whose entry asks the host to prompt. */
const flagged = async (args: {
  hostApprovalPrompt?: HostApprovalPrompt;
  preset?: McpPreset;
}): Promise<string[]> =>
  (await listTools(args))
    .filter((tool) => tool._meta?.[META_KEY] === true)
    .map((tool) => tool.name);

describe('mcp — host approval prompt, default off (ONT-048 AC-1)', () => {
  it('emits no _meta at all when the field is not set', async () => {
    const tools = await listTools();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool._meta).toBeUndefined();
    }
  });

  it('emits no _meta at all for an explicit "off"', async () => {
    for (const tool of await listTools({ hostApprovalPrompt: 'off' })) {
      expect(tool._meta).toBeUndefined();
    }
  });
});

describe('mcp — host approval prompt target sets (ONT-048 AC-2/AC-3/AC-4)', () => {
  it('"ungoverned-actions" flags only the actions that execute on call', async () => {
    // publish_document / archive_document only STAGE, so a host prompt in front
    // of them removes no risk and costs the operator a second prompt per write.
    expect(await flagged({ hostApprovalPrompt: 'ungoverned-actions' })).toEqual(['touch_counter']);
  });

  it('"all-actions" flags every action tool, governed and ungoverned', async () => {
    expect((await flagged({ hostApprovalPrompt: 'all-actions' })).sort()).toEqual([
      'archive_document',
      'publish_document',
      'touch_counter',
    ]);
  });

  it('never flags check_approval, which the agent polls in a loop', async () => {
    for (const mode of ['off', 'ungoverned-actions', 'all-actions'] as const) {
      const check = (await listTools({ hostApprovalPrompt: mode })).find(
        (tool) => tool.name === 'check_approval',
      );

      expect(check).toBeDefined();
      expect(check?._meta).toBeUndefined();
    }
  });

  it('never flags a read tool', async () => {
    for (const mode of ['off', 'ungoverned-actions', 'all-actions'] as const) {
      const reads = (await listTools({ hostApprovalPrompt: mode })).filter((tool) =>
        tool.name.startsWith('document_'),
      );

      expect(reads.map((tool) => tool.name).sort()).toEqual(['document_get', 'document_list']);
      for (const read of reads) {
        expect(read._meta).toBeUndefined();
      }
    }
  });
});

describe('mcp — host approval prompt under a preset (ONT-048 AC-5)', () => {
  it('readonly emits nothing in any mode — it exposes no action tools', async () => {
    for (const mode of ['off', 'ungoverned-actions', 'all-actions'] as const) {
      const tools = await listTools({ hostApprovalPrompt: mode, preset: 'readonly' });

      expect(tools.map((tool) => tool.name).sort()).toEqual(['document_get', 'document_list']);
      for (const tool of tools) {
        expect(tool._meta).toBeUndefined();
      }
    }
  });

  it('sandbox still annotates: the flag describes the declaration, not the mode', async () => {
    // Nothing executes under sandbox, so the prompt protects nothing — but
    // sandbox exists to rehearse the live wiring, and silently muting a flag the
    // operator turned on is a worse surprise than a prompt over a dry run.
    expect(await flagged({ hostApprovalPrompt: 'all-actions', preset: 'sandbox' })).toHaveLength(3);
    expect(await flagged({ hostApprovalPrompt: 'ungoverned-actions', preset: 'sandbox' })).toEqual([
      'touch_counter',
    ]);
  });
});

describe('mcp — the annotation is exactly what Claude Code reads (ONT-048 AC-6)', () => {
  it('carries the JSON boolean true under the vendor-prefixed key and nothing else', async () => {
    const touch = (await listTools({ hostApprovalPrompt: 'ungoverned-actions' })).find(
      (tool) => tool.name === 'touch_counter',
    );

    // The docs are explicit: the value must be the JSON boolean `true`; any
    // other value is ignored. A truthy string would silently do nothing.
    expect(touch?._meta).toEqual({ 'anthropic/requiresUserInteraction': true });
    expect(typeof touch?._meta?.['anthropic/requiresUserInteraction']).toBe('boolean');
  });
});
