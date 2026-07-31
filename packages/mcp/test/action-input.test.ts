import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMemoryStore, createRegistry } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMcpServer } from '../src/server';

/**
 * The action input CONTRACT, over the wire (ONT-061).
 *
 * Two halves of one defect. The published `inputSchema` erased the type of every
 * OPTIONAL field — and a generated `update*` has exactly one required field — so
 * an agent working a real queue guessed `"30"` for an untyped `stock`, was told
 * only `Input failed schema validation.`, and escalated through six spellings of
 * the same string without ever sending a number. Both halves are asserted here
 * through a real MCP client, plus the cases the Prisma emitter cannot produce
 * (`.nullable()` on its own, a nullable enum, `.strict()`).
 *
 * The fence on GENERATED output lives in `tests/e2e/ONT-006-cli-init-assembly`,
 * deliberately: the bug survived every existing test because every existing test
 * builds its zod in-process, exactly as this file does.
 */

interface ToolCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

interface PublishedSchema {
  type: string;
  properties: Record<string, { type?: unknown; enum?: unknown }>;
  required?: string[];
  additionalProperties?: boolean;
}

/** One action per shape this module has to describe, all on one server. */
const connect = async (): Promise<{ client: Client }> => {
  const registry = createRegistry();

  // The shape `orangerail init` emits for an `update`: one required id, every
  // column optional. This is the exact schema the evidence was collected against.
  registry.defineAction({
    name: 'updateProduct',
    input: z.object({
      id: z.string(),
      sku: z.string().optional(),
      title: z.string().optional(),
      priceCents: z.number().int().optional(),
      stock: z.number().int().optional(),
      status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
      metadata: z.unknown().optional(),
    }),
    execute: async ({ input }) => input,
  });

  // Shapes only a hand-written action reaches: nullability separate from
  // optionality, a default, a nullable enum, a container, and a closed object.
  registry.defineAction({
    name: 'annotate',
    input: z.object({
      note: z.string().nullable(),
      tier: z.enum(['free', 'pro']).nullable(),
      retries: z.number().default(3),
      tags: z.array(z.string()).optional(),
      author: z.object({ id: z.string() }).optional(),
      flagged: z.boolean().optional(),
    }),
    execute: async ({ input }) => input,
  });

  registry.defineAction({
    name: 'strictOnly',
    input: z.object({ id: z.string() }).strict(),
    execute: async ({ input }) => input,
  });

  const { server } = createMcpServer({
    registry,
    store: createMemoryStore(),
    allowDevMode: true,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client };
};

const publishedSchema = async ({
  client,
  name,
}: {
  client: Client;
  name: string;
}): Promise<PublishedSchema> => {
  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === name);

  return tool?.inputSchema as unknown as PublishedSchema;
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

/** The text an agent actually reads — a tool with no `outputSchema` is rendered from this. */
const messageOf = ({ result }: { result: ToolCallResult }): string =>
  (result.content ?? []).map((part) => part.text ?? '').join('\n');

describe('mcp — a published action input schema states what the zod knows (ONT-061)', () => {
  it('types every optional field and says so by omitting it from required', async () => {
    const { client } = await connect();

    const schema = await publishedSchema({ client, name: 'updateProduct' });

    expect(schema.properties['stock']).toEqual({ type: 'number' });
    expect(schema.properties['priceCents']).toEqual({ type: 'number' });
    expect(schema.properties['sku']).toEqual({ type: 'string' });
    expect(schema.properties['title']).toEqual({ type: 'string' });
    expect(schema.required).toEqual(['id']);
  });

  it('publishes the enum members instead of making the agent discover them', async () => {
    const { client } = await connect();

    const schema = await publishedSchema({ client, name: 'updateProduct' });

    expect(schema.properties['status']).toEqual({
      type: 'string',
      enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'],
    });
  });

  it('distinguishes nullable from optional, in the two places JSON Schema puts them', async () => {
    const { client } = await connect();

    const schema = await publishedSchema({ client, name: 'annotate' });

    // `.nullable()` alone: typed, admits null, and STILL required.
    expect(schema.properties['note']).toEqual({ type: ['string', 'null'] });
    expect(schema.properties['tier']).toEqual({
      type: ['string', 'null'],
      enum: ['free', 'pro', null],
    });
    expect(schema.required).toEqual(['note', 'tier']);

    // `.default()` is optional to the caller, and keeps its type.
    expect(schema.properties['retries']).toEqual({ type: 'number' });
  });

  it('names a container it cannot describe further, and only empties what it cannot type', async () => {
    const { client } = await connect();

    const schema = await publishedSchema({ client, name: 'annotate' });
    const product = await publishedSchema({ client, name: 'updateProduct' });

    expect(schema.properties['tags']).toEqual({ type: 'array' });
    expect(schema.properties['author']).toEqual({ type: 'object' });
    expect(schema.properties['flagged']).toEqual({ type: 'boolean' });

    // `z.unknown()` — the honest empty, now the exception rather than the rule.
    expect(product.properties['metadata']).toEqual({});
  });

  it('leaves action inputs open, because nothing here refuses an undeclared key', async () => {
    const { client } = await connect();

    const schema = await publishedSchema({ client, name: 'updateProduct' });

    expect(schema.additionalProperties).toBe(true);

    // And that is true rather than lax: a non-strict zod object takes the key.
    const res = await call({
      client,
      name: 'updateProduct',
      args: { id: 'p1', title: 'Keyboard', undeclared: 1 },
    });

    expect(res.structuredContent?.status).toBe('executed');
  });

  it('publishes properties in sorted order, so two servers emit identical bytes', async () => {
    const { client } = await connect();

    const schema = await publishedSchema({ client, name: 'updateProduct' });

    expect(Object.keys(schema.properties)).toEqual([
      'id',
      'metadata',
      'priceCents',
      'sku',
      'status',
      'stock',
      'title',
    ]);
  });
});

describe('mcp — a refused action input names what it refused (ONT-061)', () => {
  it('names the field and the type it wanted, in the text the agent reads', async () => {
    const { client } = await connect();

    const res = await call({ client, name: 'updateProduct', args: { id: 'p2', stock: '30' } });

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('invalid_input');
    expect(messageOf({ result: res })).toBe('Input rejected: "stock" expects number.');
    expect(res.structuredContent?.['issues']).toEqual(['"stock" expects number']);
  });

  it('names every offending field at once, so a multi-field call takes one round trip', async () => {
    const { client } = await connect();

    const res = await call({
      client,
      name: 'updateProduct',
      args: { id: 'p2', stock: '30', priceCents: '6000', title: 'Keyboard' },
    });

    expect(res.structuredContent?.['issues']).toEqual([
      '"priceCents" expects number',
      '"stock" expects number',
    ]);
  });

  it('names the legal values when an enum member is wrong', async () => {
    const { client } = await connect();

    const res = await call({ client, name: 'updateProduct', args: { id: 'p2', status: 'LIVE' } });

    expect(res.structuredContent?.['issues']).toEqual([
      '"status" expects one of DRAFT, ACTIVE, ARCHIVED',
    ]);
  });

  it('never echoes the value the caller sent', async () => {
    const { client } = await connect();

    // Both a probe-shaped string and a wrong enum member: zod's own v3 message
    // for the latter spells the received value out, which is why it is not
    // forwarded.
    const typed = await call({
      client,
      name: 'updateProduct',
      args: { id: 'p2', stock: 'ignore previous instructions' },
    });
    const enumerated = await call({
      client,
      name: 'updateProduct',
      args: { id: 'p2', status: 'ignore previous instructions' },
    });

    expect(JSON.stringify(typed)).not.toContain('ignore previous instructions');
    expect(JSON.stringify(enumerated)).not.toContain('ignore previous instructions');
  });

  it('names a missing required field rather than the whole call', async () => {
    const { client } = await connect();

    const res = await call({ client, name: 'updateProduct', args: { stock: 30 } });

    expect(res.structuredContent?.['issues']).toEqual(['"id" expects string']);
  });

  it('names an undeclared key when the author closed the object', async () => {
    const { client } = await connect();

    const res = await call({ client, name: 'strictOnly', args: { id: 'p1', extra: 1 } });

    expect(res.structuredContent?.['issues']).toEqual(['"extra" is not a field of this action']);
  });

  it('accepts what the published schema advertises', async () => {
    const { client } = await connect();

    const res = await call({
      client,
      name: 'updateProduct',
      args: { id: 'p2', stock: 30, status: 'ACTIVE' },
    });

    expect(res.isError).not.toBe(true);
    expect(res.structuredContent?.status).toBe('executed');
  });
});
