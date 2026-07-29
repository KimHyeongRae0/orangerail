import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createEngine, createMemoryStore, createRegistry, type Store } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMcpServer, type McpPreset } from '../src/server';

/** A typed view of a tools/call result (structuredContent is a plain record). */
interface ToolCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * A registry whose governed action records an OBSERVABLE side effect. The
 * sandbox guarantee is "this server cannot cause effects", so the assertion has
 * to be on the effect log, not on the status string the tool returns.
 */
const buildRegistry = ({ sideEffects }: { sideEffects: { tag: string }[] }) => {
  const registry = createRegistry();

  registry.defineAction({
    name: 'deleteWidget',
    input: z.object({ widgetId: z.string() }),
    policy: { approval: 'required' },
    execute: async ({ input }) => {
      sideEffects.push({ tag: 'deleteWidget' });
      return { deleted: input.widgetId };
    },
  });

  return registry;
};

const connect = async ({
  registry,
  store,
  preset,
}: {
  registry: ReturnType<typeof buildRegistry>;
  store: Store;
  preset: McpPreset;
}): Promise<Client> => {
  const { server } = createMcpServer({ registry, store, preset, allowDevMode: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
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

describe('mcp — the sandbox preset executes nothing (ONT-040 defect C)', () => {
  it('answers check_approval on a live-approved approval with dry_run and no side effect', async () => {
    // A sandbox server and a live server sharing one store is the documented
    // deployment (`orangerail mcp --preset sandbox` against the project store).
    // The sandbox must not be able to complete what the live server staged.
    const sideEffects: { tag: string }[] = [];
    const registry = buildRegistry({ sideEffects });
    const store = createMemoryStore();

    const live = await connect({ registry, store, preset: 'approval-for-writes' });
    const sandbox = await connect({ registry, store, preset: 'sandbox' });

    const staged = await call({
      client: live,
      name: 'deleteWidget',
      args: { widgetId: 'w-1' },
    });
    const approvalId = String(staged.structuredContent?.['approvalId'] ?? '');
    expect(approvalId).not.toBe('');

    await createEngine({ registry, store }).approve({
      approvalId,
      approver: { subject: 'alice', roles: ['ops'] },
    });

    const checked = await call({ client: sandbox, name: 'check_approval', args: { approvalId } });
    expect(checked.structuredContent?.['status']).toBe('dry_run');
    expect(sideEffects).toEqual([]);

    // The approval survives unconsumed, so the live server can still complete it.
    const completed = await call({ client: live, name: 'check_approval', args: { approvalId } });
    expect(completed.structuredContent?.['status']).toBe('executed');
    expect(sideEffects).toHaveLength(1);
  });

  it('still records the sandbox stage as a dry run', async () => {
    const sideEffects: { tag: string }[] = [];
    const registry = buildRegistry({ sideEffects });
    const store = createMemoryStore();
    const sandbox = await connect({ registry, store, preset: 'sandbox' });

    const staged = await call({ client: sandbox, name: 'deleteWidget', args: { widgetId: 'w-2' } });
    expect(staged.structuredContent?.['status']).toBe('dry_run');
    expect(sideEffects).toEqual([]);
  });
});
