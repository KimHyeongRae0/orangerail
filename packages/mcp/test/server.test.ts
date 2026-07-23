import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createMemoryStore,
  createRegistry,
  type ResolveIdentity,
  type Store,
} from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMcpServer, type McpPreset } from '../src/server';

/** A typed view of a tools/call result (structuredContent is a plain record). */
interface ToolCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

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

  registry.defineAction({
    name: 'publish_document',
    target: document,
    input: z.object({ documentId: z.string(), note: z.string() }),
    policy: { approval: 'required', where: { field: 'status', op: 'eq', value: 'draft' } },
    execute: async ({ input }) => ({ published: input.documentId }),
  });

  registry.defineAction({
    name: 'touch_counter',
    input: z.object({ label: z.string() }),
    execute: async ({ input }) => ({ touched: input.label }),
  });

  return registry;
};

const connect = async ({
  preset,
  resolveIdentity,
  allowDevMode = true,
}: {
  preset?: McpPreset;
  resolveIdentity?: ResolveIdentity;
  allowDevMode?: boolean;
} = {}): Promise<{ client: Client; store: Store }> => {
  const registry = buildRegistry();
  const store = createMemoryStore();
  // Default the helper to the explicit dev opt-in (ONT-014 AC-4): the MCP
  // server now defaults allowDevMode to false, so these tests — which exercise
  // staging/reads without an adapter — must opt in, exactly as a local operator
  // would in their config. The deny-first invariant is covered by its own test
  // (explicit `resolveIdentity: () => null`) and the secure-default block below.
  const { server } = createMcpServer({
    registry,
    store,
    allowDevMode,
    ...(preset ? { preset } : {}),
    ...(resolveIdentity ? { resolveIdentity } : {}),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, store };
};

const call = async ({
  client,
  name,
  args,
}: {
  client: Client;
  name: string;
  args: Record<string, unknown>;
}): Promise<ToolCallResult> =>
  (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult;

describe('mcp — tool listing (§3.2, AC-2)', () => {
  it('lists read tools, action tools, and check_approval with JSON schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const expected of [
      'document_get',
      'document_list',
      'publish_document',
      'touch_counter',
      'check_approval',
    ]) {
      expect(names).toContain(expected);
    }

    const get = tools.find((t) => t.name === 'document_get');
    expect(get?.inputSchema?.type).toBe('object');
  });

  it('readonly preset exposes no action tools and no check_approval', async () => {
    const { client } = await connect({ preset: 'readonly' });
    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toContain('document_get');
    expect(names).not.toContain('publish_document');
    expect(names).not.toContain('check_approval');
  });
});

describe('mcp — tool-name validation and collision (§3.2)', () => {
  it('throws on an illegal action tool name', () => {
    const registry = createRegistry();
    registry.defineAction({
      name: 'bad name!',
      input: z.object({ v: z.string() }),
      execute: async () => ({}),
    });

    expect(() => createMcpServer({ registry, store: createMemoryStore() })).toThrow(
      /invalid MCP tool name/,
    );
  });

  it('throws on a collision between a read tool and an action tool', () => {
    const registry = createRegistry();
    registry.defineObject({
      name: 'document',
      schema: z.object({ id: z.string() }),
      resolve: { get: async ({ id }) => ({ id }) },
    });
    registry.defineAction({
      name: 'document_get',
      input: z.object({ v: z.string() }),
      execute: async () => ({}),
    });

    expect(() => createMcpServer({ registry, store: createMemoryStore() })).toThrow(
      /duplicate MCP tool name/,
    );
  });
});

describe('mcp — read + stage result mapping (AC-2)', () => {
  it('reads an object via the get tool', async () => {
    const { client } = await connect();
    const res = await call({ client, name: 'document_get', args: { id: 'd1' } });

    expect(res.isError).not.toBe(true);
    expect(JSON.stringify(res)).toContain('Doc');
  });

  it('maps a governed action to approval_pending + approvalId', async () => {
    const { client } = await connect();
    const res = await call({
      client,
      name: 'publish_document',
      args: { documentId: 'd1', note: 'ship' },
    });

    expect(res.structuredContent?.status).toBe('approval_pending');
    expect(typeof res.structuredContent?.approvalId).toBe('string');
  });

  it('maps invalid input to an isError structured status', async () => {
    const { client } = await connect();
    const res = await call({ client, name: 'publish_document', args: { documentId: 'd1' } });

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('invalid_input');
  });

  it('denies an anonymous caller (adapter returns null)', async () => {
    const { client } = await connect({ resolveIdentity: () => null });
    const res = await call({
      client,
      name: 'publish_document',
      args: { documentId: 'd1', note: 'x' },
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('denied');
  });
});

describe('mcp — check_approval mapping incl. consumed re-poll (§3.2, AC-2)', () => {
  it('reports pending, executes on approval, then reports consumed on re-poll', async () => {
    const { client, store } = await connect();

    const staged = await call({
      client,
      name: 'publish_document',
      args: { documentId: 'd1', note: 'ship' },
    });
    const approvalId = String(staged.structuredContent?.approvalId);

    const pending = await call({ client, name: 'check_approval', args: { approvalId } });
    expect(pending.structuredContent?.status).toBe('pending');

    await store.resolveApproval({
      id: approvalId,
      decision: 'approved',
      approver: { subject: 'human', roles: [] },
    });

    const executed = await call({ client, name: 'check_approval', args: { approvalId } });
    expect(executed.structuredContent?.status).toBe('executed');

    const repoll = await call({ client, name: 'check_approval', args: { approvalId } });
    expect(repoll.structuredContent?.status).toBe('consumed');
  });
});

describe('mcp — secure identity default (§3.3, AC-4)', () => {
  it('denies staging a governed action with no adapter and no dev opt-in', async () => {
    const { client } = await connect({ allowDevMode: false });
    const res = await call({
      client,
      name: 'publish_document',
      args: { documentId: 'd1', note: 'ship' },
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('denied');
  });

  it('denies an authenticated read with no adapter and no dev opt-in', async () => {
    const { client } = await connect({ allowDevMode: false });
    const res = await call({ client, name: 'document_get', args: { id: 'd1' } });

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('denied');
  });

  it('denies check_approval for an anonymous caller (no adapter, no opt-in)', async () => {
    const { client } = await connect({ allowDevMode: false });
    const res = await call({ client, name: 'check_approval', args: { approvalId: 'whatever' } });

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('denied');
  });

  it('stages normally once dev mode is explicitly opted in', async () => {
    const { client } = await connect({ allowDevMode: true });
    const res = await call({
      client,
      name: 'publish_document',
      args: { documentId: 'd1', note: 'ship' },
    });

    expect(res.structuredContent?.status).toBe('approval_pending');
  });
});

describe('mcp — sandbox preset dry-run (§3.6, AC-6)', () => {
  it('returns dry_run and never stages an approval', async () => {
    const { client, store } = await connect({ preset: 'sandbox' });
    const res = await call({
      client,
      name: 'publish_document',
      args: { documentId: 'd1', note: 'ship' },
    });

    expect(res.structuredContent?.status).toBe('dry_run');
    expect(await store.listApprovals()).toHaveLength(0);
  });
});
