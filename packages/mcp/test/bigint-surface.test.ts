import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMemoryStore, createRegistry, DECIMAL_INTEGER_SOURCE } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { deriveFilterSchema, deriveFilterSpec, validateFilter } from '../src/filter';
import { deriveInputSchema, type JsonSchemaProperty } from '../src/schema';
import { createMcpServer } from '../src/server';

/**
 * ONT-068 — what the transport publishes for a `BigInt` column, and what it
 * refuses.
 *
 * RED against `752ff7b`: `schema.ts` published `bigint` as `{"type":"integer"}`,
 * which is an invitation to send a JSON number — and `JSON.parse` rounds one
 * above 2^53, so a request for `9007199254740993` silently targeted
 * `9007199254740992`. `filter.ts` dropped the column entirely, so it could not
 * be filtered at all.
 */

/** The node the emitter renders for a scanned `BigInt` column. */
const bigintNode = (): z.ZodType => z.string().regex(new RegExp(DECIMAL_INTEGER_SOURCE));

const specOf = ({ schema }: { schema: z.ZodType }): ReturnType<typeof deriveFilterSpec> =>
  deriveFilterSpec({ schema });

interface ToolListEntry {
  name: string;
  inputSchema: {
    properties: Record<string, JsonSchemaProperty>;
    $defs?: Record<string, JsonSchemaProperty>;
  };
}

/** A live `tools/list` over an object whose id is a `BigInt` column. */
const listTools = async (): Promise<ToolListEntry[]> => {
  const registry = createRegistry();

  registry.defineObject({
    name: 'Signed',
    schema: z.object({ id: bigintNode(), name: z.string() }),
    resolve: { get: async () => null, list: async () => ({ items: [] }) },
  });

  const { server } = createMcpServer({
    registry,
    store: createMemoryStore(),
    allowDevMode: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ont-068', version: '0.0.0' }, { capabilities: {} });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = (await client.listTools()) as unknown as { tools: ToolListEntry[] };

  await client.close();

  return listed.tools;
};

describe('tools/list publishes a BigInt column as a string (AC-4)', () => {
  it('states {"type":"string"} with the decimal pattern, and never an integer', async () => {
    const tools = await listTools();
    const filter = tools.find((tool) => tool.name === 'Signed_list')?.inputSchema;
    const id = filter?.properties['filter']?.properties?.['id'];

    expect(JSON.stringify(tools)).not.toContain('"integer"');
    expect(id?.anyOf?.[0]).toEqual({ type: 'string', pattern: DECIMAL_INTEGER_SOURCE });
    expect(id?.anyOf?.[1]).toEqual({ $ref: '#/$defs/bigintOperators' });
  });

  it('gives the operator object ordering and equality only — no contains', async () => {
    const tools = await listTools();
    const defs = tools.find((tool) => tool.name === 'Signed_list')?.inputSchema.$defs;
    const operators = defs?.['bigintOperators'];

    expect(Object.keys(operators?.properties ?? {})).toEqual([
      'equals',
      'gt',
      'gte',
      'in',
      'lt',
      'lte',
      'not',
    ]);
    // Prisma's `BigIntFilter` has none of these; advertising them is the `Bytes`
    // defect, where the gate accepts what the datasource then refuses.
    for (const absent of ['contains', 'startsWith', 'endsWith']) {
      expect(Object.keys(operators?.properties ?? {})).not.toContain(absent);
    }
    expect(operators?.properties?.['gt']).toEqual({
      type: 'string',
      pattern: DECIMAL_INTEGER_SOURCE,
    });
  });
});

describe('the filter gate refuses what the datasource could not answer (AC-4)', () => {
  const spec = specOf({ schema: z.object({ id: bigintNode(), name: z.string() }) });

  it('accepts a decimal-string operand above 2^53', () => {
    expect(validateFilter({ filter: { id: '9007199254740993' }, spec })).toEqual([]);
    expect(validateFilter({ filter: { id: { gt: '9007199254740993' } }, spec })).toEqual([]);
    expect(validateFilter({ filter: { id: { in: ['1', '9007199254740993'] } }, spec })).toEqual([]);
  });

  it('refuses `contains` HERE, not at the datasource', () => {
    expect(validateFilter({ filter: { id: { contains: '900' } }, spec })).toEqual([
      '"id.contains" is not a supported operator (allowed: equals, gt, gte, in, lt, lte, not)',
    ]);
  });

  it('refuses a JSON number, which is the wrong-row bug in operand form', () => {
    expect(validateFilter({ filter: { id: 9007199254740993 }, spec })).toEqual([
      '"id" expects a decimal integer as a string or an operator object',
    ]);
    expect(validateFilter({ filter: { id: { gte: 1 } }, spec })).toEqual([
      '"id.gte" expects a decimal integer as a string',
    ]);
  });

  it('refuses a string that is not a decimal integer', () => {
    for (const value of ['not-a-number', '', '1.5', '0x10']) {
      expect(validateFilter({ filter: { id: { gt: value } }, spec })).toEqual([
        '"id.gt" expects a decimal integer as a string',
      ]);
    }
  });

  it('leaves a plain String column with its full operator set', () => {
    const { defs } = deriveFilterSchema({ spec });

    expect(Object.keys(defs).sort()).toEqual(['bigintOperators', 'stringOperators']);
    expect(validateFilter({ filter: { name: { contains: 'sign' } }, spec })).toEqual([]);
  });
});

describe('an action input schema never advertises a number for a BigInt (AC-4, section 4)', () => {
  it('publishes a scanned BigInt field as a string', () => {
    const schema = deriveInputSchema({ schema: z.object({ id: bigintNode() }) });

    expect(schema.properties['id']).toEqual({ type: 'string' });
    expect(schema.required).toEqual(['id']);
  });

  it('publishes a hand-written z.bigint() as {} rather than as an integer', () => {
    // `JSON.parse` never yields a BigInt, so the field is uncallable whatever is
    // advertised. `{}` says nothing; `{"type":"integer"}` invited a number that
    // rounds — an untrue label is worse than an empty one.
    const schema = deriveInputSchema({ schema: z.object({ raw: z.bigint() }) });

    expect(schema.properties['raw']).toEqual({});
    expect(JSON.stringify(schema)).not.toContain('integer');
  });
});

describe('the transport renders a BigInt a resolver still hands it (AC-1)', () => {
  it('does not turn a successful read into an internal error', async () => {
    const registry = createRegistry();

    registry.defineObject({
      name: 'Raw',
      schema: z.object({ id: bigintNode() }),
      // A hand-written resolver that has never been touched, returning what
      // Prisma actually hands back for a BIGINT column.
      resolve: {
        get: async () => ({ id: 9007199254740993n, meta: { refs: [1n] } }),
        list: async () => ({ items: [{ id: 9007199254740993n }], nextCursor: '9007199254740993' }),
      },
    });

    const { server } = createMcpServer({
      registry,
      store: createMemoryStore(),
      allowDevMode: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ont-068', version: '0.0.0' }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const got = (await client.callTool({
      name: 'Raw_get',
      arguments: { id: '9007199254740993' },
    })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: { text: string }[];
    };
    const listed = (await client.callTool({ name: 'Raw_list', arguments: {} })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };

    await client.close();

    expect(got.isError).toBeFalsy();
    expect(got.structuredContent?.['object']).toEqual({
      id: '9007199254740993',
      meta: { refs: ['1'] },
    });
    expect(got.content?.[0]?.text).toContain('"9007199254740993"');
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent?.['items']).toEqual([{ id: '9007199254740993' }]);
  });
});
