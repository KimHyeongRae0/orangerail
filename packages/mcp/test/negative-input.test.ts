import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMemoryStore, createRegistry, type Store } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMcpServer } from '../src/server';

/**
 * Negative-value regression fence at the tool boundary (ONT-034).
 *
 * The action-tool handler hands `request.params.arguments` to `engine.stage`
 * verbatim — the only `Number(...)` on the MCP surface is the read-`list`
 * tool's `limit`. These tests pin that: a negative arriving over `tools/call`
 * must reach `execute` with the same sign it was sent with, and the listed tool
 * schema must not gain a bound the engine does not enforce. No production
 * behavior changed; this is coverage for behavior that was measured correct.
 */

interface ToolCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** A governed price action plus an ungoverned one, sharing an `executed` log. */
const buildFixture = () => {
  const executed: unknown[] = [];
  const registry = createRegistry();

  registry.defineAction({
    name: 'adjust_balance',
    input: z.object({ accountId: z.string(), deltaCents: z.number().int() }),
    policy: { approval: 'required' },
    execute: async ({ input }) => {
      executed.push(input);
      return { accountId: input.accountId, deltaCents: input.deltaCents };
    },
  });

  registry.defineAction({
    name: 'record_temperature',
    input: z.object({ celsius: z.number() }),
    execute: async ({ input }) => {
      executed.push(input);
      return { celsius: input.celsius };
    },
  });

  return { registry, executed };
};

const connect = async (): Promise<{
  client: Client;
  store: Store;
  executed: unknown[];
}> => {
  const { registry, executed } = buildFixture();
  const store = createMemoryStore();
  const { server } = createMcpServer({ registry, store, allowDevMode: true });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, store, executed };
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

describe('mcp — negative tool arguments are not coerced (ONT-034)', () => {
  it('runs an ungoverned action with the negative it was called with', async () => {
    const { client, executed } = await connect();

    const res = await call({ client, name: 'record_temperature', args: { celsius: -273.15 } });

    expect(res.isError).not.toBe(true);
    expect(res.structuredContent?.status).toBe('executed');
    expect(res.structuredContent?.result).toEqual({ celsius: -273.15 });
    expect(executed).toEqual([{ celsius: -273.15 }]);
  });

  it('stages, approves and completes a negative through check_approval unchanged', async () => {
    const { client, store, executed } = await connect();

    const staged = await call({
      client,
      name: 'adjust_balance',
      args: { accountId: 'a1', deltaCents: -2500 },
    });

    expect(staged.structuredContent?.status).toBe('approval_pending');
    const approvalId = String(staged.structuredContent?.approvalId);

    // What the approver would see is what the agent sent — sign included.
    const record = await store.getApproval({ id: approvalId });
    expect(record?.input).toEqual({ accountId: 'a1', deltaCents: -2500 });

    await store.resolveApproval({
      id: approvalId,
      decision: 'approved',
      approver: { subject: 'alice', roles: ['ops'] },
    });

    const completed = await call({ client, name: 'check_approval', args: { approvalId } });

    expect(completed.structuredContent?.status).toBe('executed');
    expect(completed.structuredContent?.result).toEqual({ accountId: 'a1', deltaCents: -2500 });
    expect(executed).toEqual([{ accountId: 'a1', deltaCents: -2500 }]);
  });

  it('rejects a stringified negative rather than coercing it to a number', async () => {
    const { client, store, executed } = await connect();

    const res = await call({
      client,
      name: 'adjust_balance',
      args: { accountId: 'a1', deltaCents: '-2500' },
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('invalid_input');
    expect(await store.listPending()).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('rejects a negative non-integer against an int field at the staging gate', async () => {
    const { client, store, executed } = await connect();

    const res = await call({
      client,
      name: 'adjust_balance',
      args: { accountId: 'a1', deltaCents: -0.5 },
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('invalid_input');
    expect(await store.listPending()).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('advertises an unconstrained number — the engine, not the schema, is the gate', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    const adjust = tools.find((t) => t.name === 'adjust_balance');
    const properties = adjust?.inputSchema?.properties as
      Record<string, Record<string, unknown>> | undefined;

    // `deriveInputSchema` is advisory by design (§3.2): it publishes a type and
    // no bound, and the engine re-validates every staged call with the
    // authoritative zod. Pinned so a future `minimum` here is a deliberate
    // change, not an accident that would imply a gate the schema does not own.
    expect(properties?.['deltaCents']).toEqual({ type: 'number' });
    expect(properties?.['deltaCents']).not.toHaveProperty('minimum');
  });
});
