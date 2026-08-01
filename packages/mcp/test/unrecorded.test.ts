import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createEngine,
  createMemoryStore,
  createRegistry,
  type Registry,
  type Store,
} from 'orangerail-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createMcpServer, type ReportFailure } from '../src/server';

/**
 * The store failure behind an unrecorded terminal record. Every fragment is
 * something the agent must not be handed: an absolute path on the operator's
 * machine and an OS errno.
 */
const STORE_ERROR = "EACCES: permission denied, open '/srv/app/.orangerail/audit.jsonl'";

interface ToolCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

interface Reported {
  status: string;
  tool: string;
  correlationId: string;
  error: string;
}

/**
 * A store whose audit log accepts the START of an execution and refuses its
 * OUTCOME — the full terminal record and the minimal marker that stands in for
 * it (§3.5 / ONT-069). That is exactly the shape of `audit_unrecorded`: the
 * attempt is on the chain, the write has happened, and nothing says how it
 * ended.
 */
const unrecordingStore = ({ inner }: { inner: Store }): Store => ({
  ...inner,
  appendAudit: async ({ record }) => {
    if (record.phase === 'succeeded' || record.phase === 'terminal_unrecorded') {
      throw new Error(STORE_ERROR);
    }

    return inner.appendAudit({ record });
  },
});

const buildRegistry = ({
  writes,
  gated,
  result = { deleted: true },
}: {
  writes: string[];
  gated: boolean;
  result?: unknown;
}): Registry => {
  const registry = createRegistry();

  registry.defineAction({
    name: 'delete_widget',
    input: z.object({ widgetId: z.string() }),
    ...(gated ? { policy: { approval: 'required' as const } } : {}),
    execute: async ({ input }) => {
      writes.push(input.widgetId);

      return result;
    },
  });

  return registry;
};

const connect = async ({
  registry,
  store,
}: {
  registry: Registry;
  store: Store;
}): Promise<{ client: Client; reported: Reported[] }> => {
  const reported: Reported[] = [];
  const reportFailure: ReportFailure = (entry) => {
    reported.push(entry);
  };

  const { server } = createMcpServer({ registry, store, allowDevMode: true, reportFailure });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, reported };
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

const messageOf = ({ result }: { result: ToolCallResult }): string =>
  result.content?.[0]?.text ?? '';

/**
 * The three things the sentence must say, checked as three separate assertions
 * so a rewrite that drops one fails on that one.
 */
const expectSaysAllThreeHalves = ({ message }: { message: string }): void => {
  expect(message).toContain('already landed');
  expect(message).toContain('NOT recorded');
  expect(message).toContain('Do NOT retry');
};

describe('mcp — a write that landed and was never recorded says so (ONT-071)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers an ungoverned action with the outcome, not "Unexpected stage result."', async () => {
    const writes: string[] = [];
    const { client } = await connect({
      registry: buildRegistry({ writes, gated: false }),
      store: unrecordingStore({ inner: createMemoryStore() }),
    });

    const called = await call({ client, name: 'delete_widget', args: { widgetId: 'w-1' } });
    const message = messageOf({ result: called });

    expect(writes).toEqual(['w-1']);
    expect(called.structuredContent?.['status']).toBe('audit_unrecorded');
    expect(message).not.toContain('Unexpected stage result.');
    expectSaysAllThreeHalves({ message });

    // Not a success: an agent told this went fine carries on believing the
    // chain knows about a write it does not.
    expect(called.isError).toBe(true);
  });

  it('names the correlationId and withholds the store error (AC-2)', async () => {
    const writes: string[] = [];
    const { client, reported } = await connect({
      registry: buildRegistry({ writes, gated: false }),
      store: unrecordingStore({ inner: createMemoryStore() }),
    });

    const called = await call({ client, name: 'delete_widget', args: { widgetId: 'w-2' } });
    const correlationId = String(called.structuredContent?.['correlationId'] ?? '');

    expect(correlationId).not.toBe('');
    expect(messageOf({ result: called })).toContain(correlationId);

    // The redaction convention, unchanged: the agent gets the id, the operator
    // sink gets the text — and for THIS status the sink is the only place the
    // text can be, because the append is what failed.
    const serialized = JSON.stringify(called);
    expect(serialized).not.toContain('EACCES');
    expect(serialized).not.toContain('/srv/app');
    expect(reported).toEqual([
      { status: 'audit_unrecorded', tool: 'delete_widget', correlationId, error: STORE_ERROR },
    ]);
  });

  it('hands back the action result, so getting it is never a reason to retry', async () => {
    const writes: string[] = [];
    const { client } = await connect({
      registry: buildRegistry({ writes, gated: false, result: { id: 'w-3', deleted: true } }),
      store: unrecordingStore({ inner: createMemoryStore() }),
    });

    const called = await call({ client, name: 'delete_widget', args: { widgetId: 'w-3' } });

    expect(called.structuredContent?.['result']).toEqual({ id: 'w-3', deleted: true });
  });

  it('still says the write happened when execute returned nothing (edge case)', async () => {
    const writes: string[] = [];
    const { client } = await connect({
      registry: buildRegistry({ writes, gated: false, result: undefined }),
      store: unrecordingStore({ inner: createMemoryStore() }),
    });

    const called = await call({ client, name: 'delete_widget', args: { widgetId: 'w-4' } });

    expect(writes).toEqual(['w-4']);
    expect(called.structuredContent?.['status']).toBe('audit_unrecorded');
    expectSaysAllThreeHalves({ message: messageOf({ result: called }) });
  });

  it('answers a GATED action after approval without inviting a re-run (edge case)', async () => {
    const writes: string[] = [];
    const registry = buildRegistry({ writes, gated: true });
    const store = unrecordingStore({ inner: createMemoryStore() });
    const { client, reported } = await connect({ registry, store });

    const staged = await call({ client, name: 'delete_widget', args: { widgetId: 'w-5' } });
    const approvalId = String(staged.structuredContent?.['approvalId'] ?? '');
    expect(approvalId).not.toBe('');

    await createEngine({ registry, store }).approve({
      approvalId,
      approver: { subject: 'alice', roles: ['ops'] },
    });

    const checked = await call({ client, name: 'check_approval', args: { approvalId } });
    const message = messageOf({ result: checked });

    expect(writes).toEqual(['w-5']);
    expect(checked.structuredContent?.['status']).toBe('audit_unrecorded');
    expect(message).not.toContain('Unexpected execute result.');
    expectSaysAllThreeHalves({ message });

    // The approval is spent and the write is done. Re-staging is not a retry of
    // this call, it is a second authorization for a second write — so the
    // sentence says so rather than offering the route `stale_approval` offers.
    expect(message).toContain('do NOT re-stage');
    expect(message).not.toContain('stage the action again');
    expect((await store.getApproval({ id: approvalId }))?.status).toBe('consumed');
    expect(reported.map((entry) => entry.status)).toEqual(['audit_unrecorded']);
  });

  it('leaves the default branch reachable for a status this build predates', async () => {
    const registry = buildRegistry({ writes: [], gated: true });
    const store = createMemoryStore();
    const core = await import('orangerail-core');
    const real = core.createEngine;

    // A core newer (or older) than this transport can hand up a status it has
    // never heard of. Naming it plainly is the honest answer; rendering it as
    // one of the statuses this build DOES know would be a guess about what
    // happened to somebody's data.
    vi.spyOn(core, 'createEngine').mockImplementation((args) => ({
      ...real(args),
      execute: async () => ({ status: 'from_a_newer_core' }) as never,
    }));

    const { client } = await connect({ registry, store });
    const staged = await call({ client, name: 'delete_widget', args: { widgetId: 'w-6' } });
    const approvalId = String(staged.structuredContent?.['approvalId'] ?? '');

    await real({ registry, store }).approve({
      approvalId,
      approver: { subject: 'alice', roles: ['ops'] },
    });

    const checked = await call({ client, name: 'check_approval', args: { approvalId } });

    expect(checked.structuredContent?.['status']).toBe('error');
    expect(messageOf({ result: checked })).toBe('Unexpected execute result.');
  });
});
