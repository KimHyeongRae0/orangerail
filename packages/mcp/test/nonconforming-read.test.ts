import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMemoryStore, createRegistry, UNRENDERABLE_PREFIX } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMcpServer } from '../src/server';

/**
 * ONT-074 AC-5 — a read stays total and stops serving a non-conforming value
 * silently.
 *
 * RED against `062e527`: `handleGet`/`handleList` handed the resolver's row
 * straight to `outbound`, which renders BigInts and nothing else. A `status` the
 * object declares a string and the row carries as `{ code: 'soldout' }`
 * serializes cleanly and reached the agent as if it conformed; a `status` the
 * row omitted reached it as a missing key.
 */

interface ToolCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'active', 'soldout']),
});

/** A read-only server over one object whose resolver returns whatever a test plants. */
const connect = async ({
  row,
  items,
  schema = productSchema,
}: {
  row?: unknown;
  items?: unknown[];
  schema?: z.ZodType;
}): Promise<Client> => {
  const registry = createRegistry();

  registry.defineObject({
    name: 'Product',
    schema,
    resolve: {
      get: async () => (row ?? null) as never,
      list: async () => ({ items: (items ?? []) as never[] }),
    },
  });

  const { server } = createMcpServer({
    registry,
    store: createMemoryStore(),
    preset: 'readonly',
    allowDevMode: true,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
};

const get = async ({
  row,
  schema,
}: {
  row: unknown;
  schema?: z.ZodType;
}): Promise<ToolCallResult> => {
  const client = await connect({ row, ...(schema ? { schema } : {}) });

  return (await client.callTool({
    name: 'Product_get',
    arguments: { id: 'p1' },
  })) as ToolCallResult;
};

const list = async ({
  items,
  schema,
}: {
  items: unknown[];
  schema?: z.ZodType;
}): Promise<ToolCallResult> => {
  const client = await connect({ items, ...(schema ? { schema } : {}) });

  return (await client.callTool({ name: 'Product_list', arguments: {} })) as ToolCallResult;
};

const textOf = ({ result }: { result: ToolCallResult }): string => result.content?.[0]?.text ?? '';

describe('a read of a row that drifts from its declared schema (ONT-074 AC-5)', () => {
  it('serves a conforming row exactly as before', async () => {
    const result = await get({ row: { id: 'p1', title: 'Widget', status: 'active' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      status: 'ok',
      object: { id: 'p1', title: 'Widget', status: 'active' },
    });
    expect(textOf({ result })).toBe('{"id":"p1","title":"Widget","status":"active"}');
  });

  it('marks a field the row carries in a shape the object does not declare', async () => {
    const result = await get({ row: { id: 'p1', title: 'Widget', status: { code: 'soldout' } } });

    expect(result.isError).toBeFalsy();

    const object = result.structuredContent?.['object'] as Record<string, unknown>;

    expect(String(object['status'])).toContain(UNRENDERABLE_PREFIX);
    expect(String(object['status'])).toContain('not what Product declares here');
    expect(object['title']).toBe('Widget');
    expect(result.structuredContent?.['nonconforming']).toEqual([
      { path: 'status', reason: expect.any(String) },
    ]);
  });

  it('marks a field the row omitted, rather than serving the silence', async () => {
    const result = await get({ row: { id: 'p1', title: 'Widget' } });

    const object = result.structuredContent?.['object'] as Record<string, unknown>;

    expect(Object.keys(object)).toContain('status');
    expect(String(object['status'])).toContain(UNRENDERABLE_PREFIX);
  });

  it('keeps the text content and the structured content describing one value', async () => {
    const result = await get({ row: { id: 'p1', title: 'Widget' } });

    expect(JSON.parse(textOf({ result }))).toEqual(result.structuredContent?.['object']);
  });

  // Total: the call still succeeds. A read that refused would be a second
  // outage on a surface ONT-070/071/072 made total on purpose.
  it('still succeeds', async () => {
    const result = await get({ row: 'not an object at all' });

    expect(result.isError).toBeFalsy();
    expect(String(result.structuredContent?.['object'])).toContain(UNRENDERABLE_PREFIX);
  });

  it('says nothing extra when the page conforms', async () => {
    const result = await list({ items: [{ id: 'p1', title: 'Widget', status: 'active' }] });

    expect(result.structuredContent).toEqual({
      status: 'ok',
      items: [{ id: 'p1', title: 'Widget', status: 'active' }],
    });
  });

  it('marks only the rows of a page that drift, and names them by index', async () => {
    const result = await list({
      items: [
        { id: 'p1', title: 'Widget', status: 'active' },
        { id: 'p2', title: 'Gadget' },
      ],
    });

    const items = result.structuredContent?.['items'] as Record<string, unknown>[];

    expect(items[0]).toEqual({ id: 'p1', title: 'Widget', status: 'active' });
    expect(String(items[1]?.['status'])).toContain(UNRENDERABLE_PREFIX);
    expect(result.structuredContent?.['nonconforming']).toEqual([
      { path: 'items[1].status', reason: expect.any(String) },
    ]);
  });

  // AC-7's shape at the unit level: the ontology a generated Prisma project
  // gets declares `datetime` and `decimal` as `z.string()` and `bigint` as a
  // decimal-string regex (`codegen/zod.ts:53-64`), and the resolver hands back
  // a `Date`, a `Decimal` and a `BigInt`. The verdict is taken over the WIRE
  // form, which is what the agent holds — a verdict over the raw row would mark
  // `createdAt` on every real project.
  it('does not mark the Date / Decimal / BigInt a generated ontology carries', async () => {
    const schema = z.object({
      id: z.string().regex(/^-?\d+$/),
      createdAt: z.string(),
      price: z.string(),
    });

    const decimal = { toJSON: () => '19.99', toString: () => '19.99' };
    const result = await get({
      row: {
        id: 9007199254740993n,
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
        price: decimal,
      },
      schema,
    });

    // The JSON the agent reads: every value there, none of them marked.
    expect(JSON.parse(textOf({ result }))).toEqual({
      id: '9007199254740993',
      createdAt: '2026-08-02T00:00:00.000Z',
      price: '19.99',
    });
    expect(textOf({ result })).not.toContain(UNRENDERABLE_PREFIX);
    // And the conforming path hands back the SAME rendered value it did before
    // this ticket — the round trip is only ever used to ask the question.
    expect(result.structuredContent?.['nonconforming']).toBeUndefined();
    expect(
      (result.structuredContent?.['object'] as Record<string, unknown>)['createdAt'],
    ).toBeInstanceOf(Date);
  });

  it('leaves an optional field the row omits unmarked', async () => {
    const schema = z.object({ id: z.string(), note: z.string().optional() });
    const result = await get({ row: { id: 'p1' }, schema });

    expect(result.structuredContent).toEqual({ status: 'ok', object: { id: 'p1' } });
  });

  it('leaves a column the ontology does not name unmarked', async () => {
    const result = await get({
      row: { id: 'p1', title: 'Widget', status: 'active', internalNote: 'x' },
    });

    expect(result.structuredContent).toEqual({
      status: 'ok',
      object: { id: 'p1', title: 'Widget', status: 'active', internalNote: 'x' },
    });
  });
});

describe('the gate refusal an agent is told about (ONT-074 AC-4)', () => {
  /** A staging server whose target row omits the field its `where` clause reads. */
  const stageOverDriftedRow = async (): Promise<ToolCallResult> => {
    const registry = createRegistry();

    const product = registry.defineObject({
      name: 'Product',
      schema: productSchema,
      resolve: { get: async () => ({ id: 'p1', title: 'Widget' }) as never },
    });

    registry.defineAction({
      name: 'issue_coupon',
      target: product,
      targetIdFrom: 'productId',
      input: z.object({ productId: z.string() }),
      policy: { approval: 'required', where: { field: 'status', op: 'neq', value: 'soldout' } },
      execute: async () => ({ ok: true }),
    });

    const { server } = createMcpServer({
      registry,
      store: createMemoryStore(),
      preset: 'approval-for-writes',
      allowDevMode: true,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return (await client.callTool({
      name: 'issue_coupon',
      arguments: { productId: 'p1' },
    })) as ToolCallResult;
  };

  it('refuses, names the field, and says a retry is not the repair', async () => {
    const result = await stageOverDriftedRow();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 'target_nonconforming',
      field: 'status',
    });
    expect(textOf({ result })).toContain('"status"');
    expect(textOf({ result })).toContain('not a retry');
  });

  // §3.10: `reason` carries zod's own sentence, which quotes the stored value it
  // refused, on an object this caller may hold no read access to. The field is
  // published in the tool description; the reason is not published at all.
  it('does not forward the reason to the agent', async () => {
    const result = await stageOverDriftedRow();

    expect(result.structuredContent?.['reason']).toBeUndefined();
    expect(textOf({ result })).not.toContain('not what Product declares');
  });
});
