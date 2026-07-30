import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createEngine,
  createMemoryStore,
  createRegistry,
  type ApprovalRecord,
  type Store,
} from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMcpServer } from '../src/server';

/** A typed view of a tools/call result. */
interface ToolCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

/**
 * A `0.1.0`-era store — conforming except that it never stamps `inputHash`,
 * because the version that wrote it had no such field. This is what a project
 * whose config resolves an older `orangerail-core` than its CLI actually hands
 * the engine.
 */
const legacyStore = ({ inner }: { inner: Store }): Store => {
  const strip = <T extends ApprovalRecord | null>(record: T): T => {
    if (record === null) {
      return record;
    }

    const copy = { ...record };
    delete (copy as { inputHash?: string }).inputHash;

    return copy as T;
  };

  return {
    ...inner,
    createApproval: async (args) => strip(await inner.createApproval(args)),
    getApproval: async (args) => strip(await inner.getApproval(args)),
    consumeApproval: async (args) => {
      const result = await inner.consumeApproval(args);

      return result.ok ? { ok: true, record: strip(result.record) } : result;
    },
    listPending: async () => (await inner.listPending()).map((record) => strip(record)),
    listApprovals: async () => (await inner.listApprovals()).map((record) => strip(record)),
  };
};

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
}: {
  registry: ReturnType<typeof buildRegistry>;
  store: Store;
}): Promise<Client> => {
  const { server } = createMcpServer({ registry, store, allowDevMode: true });
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

describe('mcp — a stale approval reads as a stale approval (ONT-058)', () => {
  it('gives the agent the distinct reason and a route, not an accusation', async () => {
    const sideEffects: { tag: string }[] = [];
    const registry = buildRegistry({ sideEffects });
    const store = legacyStore({ inner: createMemoryStore() });

    const client = await connect({ registry, store });

    const staged = await call({ client, name: 'deleteWidget', args: { widgetId: 'w-1' } });
    const approvalId = String(staged.structuredContent?.['approvalId'] ?? '');
    expect(approvalId).not.toBe('');

    await createEngine({ registry, store }).approve({
      approvalId,
      approver: { subject: 'alice', roles: ['ops'] },
    });

    const checked = await call({ client, name: 'check_approval', args: { approvalId } });
    const message = checked.content?.[0]?.text ?? '';

    expect(checked.isError).toBe(true);
    expect(checked.structuredContent).toEqual({
      status: 'invalidated',
      reason: 'stale_approval',
    });
    expect(sideEffects).toEqual([]);

    // The whole point of the sentence: the agent learns the approval is spent
    // and that re-staging is the move. Pre-fix the entire message was
    // `Invalidated (input).` — a word that reads as an accusation and offers
    // nothing to do about it.
    expect(message).toContain('stale_approval');
    expect(message).toContain('stage the action again');
    expect(message).toContain('orangerail status');

    // And it does NOT hand an untrusted caller the operator's install topology.
    expect(message).not.toContain('node_modules');
    expect(message).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('leaves a normally-staged approval executing, message unchanged', async () => {
    const sideEffects: { tag: string }[] = [];
    const registry = buildRegistry({ sideEffects });
    const store = createMemoryStore();

    const client = await connect({ registry, store });
    const staged = await call({ client, name: 'deleteWidget', args: { widgetId: 'w-2' } });
    const approvalId = String(staged.structuredContent?.['approvalId'] ?? '');

    await createEngine({ registry, store }).approve({
      approvalId,
      approver: { subject: 'alice', roles: ['ops'] },
    });

    const checked = await call({ client, name: 'check_approval', args: { approvalId } });

    expect(checked.isError).toBeFalsy();
    expect(sideEffects).toHaveLength(1);
  });
});
