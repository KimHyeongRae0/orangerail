import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createMemoryStore,
  createRegistry,
  type AuditRecord,
  type Registry,
  type Store,
} from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { redactFailure } from '../src/redact';
import { createMcpServer, type ReportFailure } from '../src/server';

/**
 * A realistic Prisma failure. Every fragment below is something an untrusted
 * agent must not learn: the query, the server's source path, the table, and the
 * constraint name.
 */
const DRIVER_ERROR =
  'Invalid `prisma.order.update()` invocation in /srv/app/src/db/orders.ts:42:18 ' +
  'Foreign key constraint failed on the field: `Order_customerId_fkey (index)`';

/** The fragments asserted absent from every agent-facing response. */
const LEAK_FRAGMENTS = [
  'Order_customerId_fkey',
  '/srv/app/src/db/orders.ts',
  'prisma.order.update',
  'Foreign key constraint',
];

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

const connect = async ({
  registry,
  store = createMemoryStore(),
}: {
  registry: Registry;
  store?: Store;
}): Promise<{ client: Client; store: Store; reported: Reported[] }> => {
  const reported: Reported[] = [];
  const reportFailure: ReportFailure = (entry) => {
    reported.push(entry);
  };

  const { server } = createMcpServer({ registry, store, allowDevMode: true, reportFailure });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, store, reported };
};

/**
 * Call a tool and normalize a THROWN transport error into a value. Before this
 * fix an uncaught resolver rejection surfaced as a JSON-RPC internal error, so
 * the assertion has to inspect the throw as well as the result.
 */
const call = async ({
  client,
  name,
  args,
}: {
  client: Client;
  name: string;
  args: Record<string, unknown>;
}): Promise<ToolCallResult> =>
  (await client
    .callTool({ name, arguments: args })
    .catch((caught: unknown) => ({ thrown: String(caught) }))) as ToolCallResult;

const messageOf = ({ result }: { result: ToolCallResult }): string =>
  result.content?.[0]?.text ?? '';

const expectNoLeak = ({ result }: { result: ToolCallResult }): void => {
  const serialized = JSON.stringify(result);
  for (const fragment of LEAK_FRAGMENTS) {
    expect(serialized).not.toContain(fragment);
  }
};

const throwingAction = ({ name = 'update_order' }: { name?: string } = {}): Registry => {
  const registry = createRegistry();
  registry.defineAction({
    name,
    input: z.object({ orderId: z.string() }),
    execute: async () => {
      throw new Error(DRIVER_ERROR);
    },
  });

  return registry;
};

const throwingReads = (): Registry => {
  const registry = createRegistry();
  registry.defineObject({
    name: 'order',
    schema: z.object({ id: z.string() }),
    resolve: {
      get: async () => {
        throw new Error(DRIVER_ERROR);
      },
      list: async () => {
        throw new Error(DRIVER_ERROR);
      },
    },
  });

  return registry;
};

describe('mcp — redactFailure (§3.10)', () => {
  it('names the tool, the domain-level cause, and the correlationId', () => {
    const redacted = redactFailure({
      status: 'failed',
      tool: 'update_order',
      correlationId: 'cid-1',
    });

    expect(redacted.status).toBe('failed');
    expect(redacted.correlationId).toBe('cid-1');
    expect(redacted.message).toContain('update_order');
    expect(redacted.message).toContain('the datasource rejected it');
    expect(redacted.message).toContain('cid-1');
  });

  it('distinguishes the failure categories so the agent can still act on them', () => {
    const cause = ({ status }: { status: 'resolve_error' | 'audit_blocked' | 'internal_error' }) =>
      redactFailure({ status, tool: 't', correlationId: 'c' }).message;

    expect(cause({ status: 'resolve_error' })).toContain('could not be read from the datasource');
    expect(cause({ status: 'audit_blocked' })).toContain('nothing was executed');
    expect(cause({ status: 'internal_error' })).toContain('unexpected internal error');
  });
});

describe('mcp — execution failures are redacted before reaching the agent (§3.10)', () => {
  it('withholds the driver text from a failing action and hands back a correlationId', async () => {
    const { client, store, reported } = await connect({ registry: throwingAction() });

    const result = await call({ client, name: 'update_order', args: { orderId: 'o1' } });

    expectNoLeak({ result });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.status).toBe('failed');

    const correlationId = String(result.structuredContent?.['correlationId'] ?? '');
    expect(correlationId).not.toBe('');
    expect(messageOf({ result })).toContain(correlationId);

    // The agent keeps a domain-level "why": which tool, and where it failed.
    expect(messageOf({ result })).toContain('update_order');
    expect(messageOf({ result })).toContain('the datasource rejected it');

    // Operator side: the FULL text survives on the host sink...
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toBe(DRIVER_ERROR);
    expect(reported[0]?.correlationId).toBe(correlationId);

    // ...and in the audit record the correlationId points at.
    const records: AuditRecord[] = (await store.readAudit({})).items;
    const failed = records.find((record) => record.phase === 'failed');
    expect(failed?.correlationId).toBe(correlationId);
    expect(failed?.error).toBe(DRIVER_ERROR);
  });

  it('withholds the driver text from a throwing read resolver (get)', async () => {
    const { client, reported } = await connect({ registry: throwingReads() });

    const result = await call({ client, name: 'order_get', args: { id: 'o1' } });

    expectNoLeak({ result });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.status).toBe('resolve_error');
    expect(reported[0]?.error).toBe(DRIVER_ERROR);
    expect(reported[0]?.tool).toBe('order_get');
  });

  it('withholds the driver text from a throwing read resolver (list)', async () => {
    const { client, reported } = await connect({ registry: throwingReads() });

    const result = await call({ client, name: 'order_list', args: {} });

    expectNoLeak({ result });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.status).toBe('resolve_error');
    expect(reported[0]?.error).toBe(DRIVER_ERROR);
  });

  it('withholds the store error when the audit append blocks execution', async () => {
    const base = createMemoryStore();
    const store: Store = {
      ...base,
      appendAudit: async ({ record }) => {
        if (record.phase === 'execution_started') {
          throw new Error(`EACCES: permission denied, open '/srv/app/.orangerail/audit.jsonl'`);
        }

        return base.appendAudit({ record });
      },
    };

    const { client, reported } = await connect({ registry: throwingAction(), store });
    const result = await call({ client, name: 'update_order', args: { orderId: 'o1' } });

    expect(JSON.stringify(result)).not.toContain('audit.jsonl');
    expect(JSON.stringify(result)).not.toContain('EACCES');
    expect(result.structuredContent?.status).toBe('audit_blocked');
    expect(messageOf({ result })).toContain('nothing was executed');
    expect(reported[0]?.error).toContain('audit.jsonl');
  });

  it('backstops any other throw out of tools/call instead of leaking it as an internal error', async () => {
    const base = createMemoryStore();
    const store: Store = {
      ...base,
      getApproval: async () => {
        throw new Error(DRIVER_ERROR);
      },
    };

    const { client, reported } = await connect({ registry: throwingAction(), store });
    const result = await call({ client, name: 'check_approval', args: { approvalId: 'a1' } });

    expectNoLeak({ result });
    expect(result.structuredContent?.status).toBe('internal_error');
    expect(reported[0]?.error).toBe(DRIVER_ERROR);
  });

  it('correlates an approval-path failure by its approvalId', async () => {
    const registry = createRegistry();
    registry.defineAction({
      name: 'update_order',
      input: z.object({ orderId: z.string() }),
      policy: { approval: 'required' },
      execute: async () => {
        throw new Error(DRIVER_ERROR);
      },
    });

    const { client, store, reported } = await connect({ registry });

    const staged = await call({ client, name: 'update_order', args: { orderId: 'o1' } });
    const approvalId = String(staged.structuredContent?.['approvalId']);

    await store.resolveApproval({
      id: approvalId,
      decision: 'approved',
      approver: { subject: 'human', roles: [] },
    });

    const result = await call({ client, name: 'check_approval', args: { approvalId } });

    expectNoLeak({ result });
    expect(result.structuredContent?.status).toBe('failed');
    expect(result.structuredContent?.['correlationId']).toBe(approvalId);
    expect(reported[0]?.error).toBe(DRIVER_ERROR);

    const records: AuditRecord[] = (await store.readAudit({})).items;
    const failed = records.find((record) => record.phase === 'failed');
    expect(failed?.approvalId).toBe(approvalId);
    expect(failed?.error).toBe(DRIVER_ERROR);
  });

  it('defaults the operator sink to stderr, never the JSON-RPC stdout stream', async () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const { server } = createMcpServer({
        registry: throwingAction(),
        store: createMemoryStore(),
        allowDevMode: true,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      await call({ client, name: 'update_order', args: { orderId: 'o1' } });
    } finally {
      process.stderr.write = original;
    }

    expect(chunks.join('')).toContain('Order_customerId_fkey');
  });
});
