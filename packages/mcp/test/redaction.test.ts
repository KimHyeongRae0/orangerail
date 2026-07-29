import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createMemoryStore,
  createRegistry,
  markPublicDiagnostic,
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
    expect(redacted.message).toBe(
      'Tool "update_order" failed: the datasource rejected the action. ' +
        'The datasource error is withheld; an operator can read it in ' +
        'the audit log or host log under correlationId "cid-1".',
    );
  });

  it('distinguishes the failure categories so the agent can still act on them', () => {
    const cause = ({ status }: { status: 'resolve_error' | 'audit_blocked' | 'internal_error' }) =>
      redactFailure({ status, tool: 't', correlationId: 'c' }).message;

    expect(cause({ status: 'resolve_error' })).toContain(
      'the target could not be read from the datasource',
    );
    expect(cause({ status: 'audit_blocked' })).toContain(
      'the audit record could not be written, so nothing ran',
    );
    expect(cause({ status: 'internal_error' })).toContain('an unexpected internal error');
  });

  it('names the KIND of error withheld — a store error is not a datasource error', () => {
    const withheldIn = ({ status }: { status: 'audit_blocked' | 'internal_error' }) =>
      redactFailure({ status, tool: 't', correlationId: 'c' }).message;

    // The old wording called every withheld error a "datasource error", which
    // is false for a blocked audit append (a store/filesystem failure) and for
    // an unclassified internal throw.
    expect(withheldIn({ status: 'audit_blocked' })).toContain('The store error is withheld');
    expect(withheldIn({ status: 'audit_blocked' })).not.toContain('datasource error is withheld');
    expect(withheldIn({ status: 'internal_error' })).toContain('The underlying error is withheld');
    expect(withheldIn({ status: 'internal_error' })).not.toContain('datasource error is withheld');
  });

  it('never points at an audit record that cannot exist', () => {
    // audit_blocked: the append IS the failure, so there is no audit record.
    const blocked = redactFailure({
      status: 'audit_blocked',
      tool: 'update_order',
      correlationId: 'cid-2',
    }).message;

    expect(blocked).toBe(
      'Tool "update_order" failed: the audit record could not be written, so nothing ran. ' +
        'The store error is withheld; an operator can read it in the host log ' +
        'under correlationId "cid-2".',
    );
    expect(blocked).not.toContain('audit log');

    // A read resolver is not audited either — the call site says so explicitly.
    const read = redactFailure({
      status: 'resolve_error',
      tool: 'order_get',
      correlationId: 'cid-3',
      channel: 'host-log',
    }).message;

    expect(read).toContain('read it in the host log');
    expect(read).not.toContain('audit log');
  });
});

describe('mcp — a classified failure gets orangerail prose, not driver prose (ONT-045)', () => {
  it('replaces the generic cause with the specific one and adds the fix', () => {
    const redacted = redactFailure({
      status: 'failed',
      tool: 'createNote',
      correlationId: 'cid-9',
      diagnostic: { code: 'datasource_not_configured' },
    });

    expect(redacted.diagnostic).toBe('datasource_not_configured');
    expect(redacted.message).toContain('the datasource is not configured');
    expect(redacted.message).toContain('DATABASE_URL');
    // The withholding clause survives: the carve-out changes what orangerail
    // says, never whether the driver text travels.
    expect(redacted.message).toContain('The datasource error is withheld');
    expect(redacted.message).toContain('cid-9');
  });

  it('names the subject when it has one, and stays grammatical when it does not', () => {
    const named = redactFailure({
      status: 'resolve_error',
      tool: 'Post_list',
      correlationId: 'c',
      channel: 'host-log',
      diagnostic: { code: 'datasource_model_missing', subject: 'Post' },
    }).message;

    expect(named).toContain('"Post"');
    expect(named).toContain('npx prisma generate');

    const anonymous = redactFailure({
      status: 'resolve_error',
      tool: 'Post_list',
      correlationId: 'c',
      channel: 'host-log',
      diagnostic: { code: 'datasource_model_missing' },
    }).message;

    expect(anonymous).toContain('npx prisma generate');
    expect(anonymous).not.toContain('undefined');
    expect(anonymous).not.toContain('""');
  });

  it('is unchanged for an unclassified failure — the carve-out is opt-in per code', () => {
    expect(redactFailure({ status: 'failed', tool: 't', correlationId: 'c' }).message).toBe(
      redactFailure({ status: 'failed', tool: 't', correlationId: 'c' }).message,
    );
    expect(redactFailure({ status: 'failed', tool: 't', correlationId: 'c' }).diagnostic).toBe(
      undefined,
    );
    expect(redactFailure({ status: 'failed', tool: 't', correlationId: 'c' }).message).toContain(
      'the datasource rejected the action',
    );
  });

  it('renders every code in the closed set with a fix the reader can act on', () => {
    const codes = [
      'datasource_client_missing',
      'datasource_model_missing',
      'datasource_not_configured',
    ] as const;

    for (const code of codes) {
      const message = redactFailure({
        status: 'failed',
        tool: 't',
        correlationId: 'c',
        diagnostic: { code },
      }).message;

      expect(message).toMatch(/retry\./);
      expect(message).toContain('is withheld');
    }
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
    expect(messageOf({ result })).toContain('the datasource rejected the action');

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

    // Reads are not audited, so the message must not send an operator looking
    // for an audit record that was never written.
    expect(messageOf({ result })).toContain('read it in the host log');
    expect(messageOf({ result })).not.toContain('audit log');
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
    expect(reported[0]?.error).toContain('audit.jsonl');

    // Locked verbatim: the withheld error is a STORE error, not a datasource
    // one, and the append that failed is exactly the audit record — so the
    // host log is the only channel this message may name.
    const correlationId = String(result.structuredContent?.['correlationId'] ?? '');
    expect(messageOf({ result })).toBe(
      'Tool "update_order" failed: the audit record could not be written, so nothing ran. ' +
        'The store error is withheld; an operator can read it in the host log ' +
        `under correlationId "${correlationId}".`,
    );
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

  it('adds the fix for a classified failure while still withholding the text', async () => {
    // The exact ONT-018 case: Prisma raises its initialization error, the
    // generated file tags it, and the agent finally learns what to DO.
    const registry = createRegistry();
    registry.defineAction({
      name: 'createNote',
      input: z.object({ title: z.string() }),
      execute: async () => {
        const error = new Error(
          `${DRIVER_ERROR}\nerror: Environment variable not found: DATABASE_URL.`,
        );
        error.name = 'PrismaClientInitializationError';

        throw markPublicDiagnostic({ error, code: 'datasource_not_configured' });
      },
    });

    const { client, reported } = await connect({ registry });
    const result = await call({ client, name: 'createNote', args: { title: 't' } });

    expectNoLeak({ result });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.['diagnostic']).toBe('datasource_not_configured');
    expect(messageOf({ result })).toContain('DATABASE_URL');
    expect(messageOf({ result })).toContain('the datasource is not configured');

    // Prisma's own sentence never appears in the response — only on the sink.
    expect(JSON.stringify(result)).not.toContain('Environment variable not found');
    expect(reported[0]?.error).toContain('Environment variable not found: DATABASE_URL');
  });

  it('cannot be talked into leaking by an error that forges the brand', async () => {
    // The adversarial case for the ONT-045 carve-out: a datasource that knows
    // about the brand and stuffs a connection string into it. The code is not in
    // the closed set and the subject is not an identifier, so both are dropped
    // and the response degrades to the ordinary full redaction.
    const registry = createRegistry();
    registry.defineObject({
      name: 'order',
      schema: z.object({ id: z.string() }),
      resolve: {
        get: async () => {
          const error = new Error(DRIVER_ERROR);
          Object.defineProperty(error, Symbol.for('orangerail.publicDiagnostic'), {
            value: {
              code: 'leak_everything',
              subject: 'postgres://admin:hunter2@db.internal:5432/prod',
            },
            configurable: true,
          });

          throw error;
        },
      },
    });

    const { client } = await connect({ registry });
    const result = await call({ client, name: 'order_get', args: { id: 'o1' } });

    expectNoLeak({ result });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('db.internal');
    expect(serialized).not.toContain('leak_everything');
    expect(result.structuredContent?.['diagnostic']).toBeUndefined();
    expect(messageOf({ result })).toContain('the target could not be read from the datasource');
  });

  it('drops a non-identifier subject on an otherwise valid code', async () => {
    const registry = createRegistry();
    registry.defineObject({
      name: 'order',
      schema: z.object({ id: z.string() }),
      resolve: {
        get: async () => {
          const error = new Error(DRIVER_ERROR);
          Object.defineProperty(error, Symbol.for('orangerail.publicDiagnostic'), {
            value: {
              code: 'datasource_model_missing',
              subject: 'postgres://admin:hunter2@db.internal:5432/prod',
            },
            configurable: true,
          });

          throw error;
        },
      },
    });

    const { client } = await connect({ registry });
    const result = await call({ client, name: 'order_get', args: { id: 'o1' } });

    // The class survives (it is in the closed set); the smuggled subject does not.
    expect(result.structuredContent?.['diagnostic']).toBe('datasource_model_missing');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('postgres://');
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
