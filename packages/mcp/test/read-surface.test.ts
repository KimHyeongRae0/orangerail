import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMemoryStore, createRegistry, type Registry } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { deriveFilterSchema, deriveFilterSpec, validateFilter } from '../src/filter';
import { relationLines } from '../src/relations';
import { createMcpServer } from '../src/server';

/**
 * ONT-053 — the generated READ surface is bounded, and says what it is.
 *
 * RED against `5028bb6`: `<Object>_list` advertised `filter: { type: 'object' }`
 * with no properties and passed the value STRAIGHT to `resolve.list`, which for
 * a generated Prisma resolver is `findMany({ where: filter })`. The declared
 * surface was not the surface — a caller could filter across a relation into an
 * object type that has no tool at all. No read tool named a relation either,
 * even though `registry.listLinks()` had them the whole time.
 */

interface ToolCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Records the `filter` each call actually reached the resolver with. */
const seen: { filter?: unknown }[] = [];

const resolve = {
  get: async () => null,
  list: async ({ filter }: { filter?: unknown } = {}) => {
    seen.push({ filter });

    return { items: [] };
  },
};

/** A Prisma-shaped ontology: enum, nullable column, and two relation pairs. */
const buildRegistry = (): Registry => {
  const registry = createRegistry();

  const product = registry.defineObject({
    name: 'Product',
    schema: z.object({
      id: z.string(),
      title: z.string(),
      price: z.number(),
      quantity: z.number().int(),
      inStock: z.boolean(),
      status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
      // A `Json` column and a list column: neither has a leaf JSON type here, so
      // neither may be advertised — and neither is filterable.
      metadata: z.unknown(),
      tags: z.array(z.string()),
    }),
    resolve,
  });

  const customer = registry.defineObject({
    name: 'Customer',
    schema: z.object({ id: z.string(), email: z.string(), name: z.string().optional() }),
    resolve,
  });

  const order = registry.defineObject({
    name: 'Order',
    schema: z.object({ id: z.string(), total: z.number() }),
    resolve,
  });

  registry.defineLink({ name: 'Customer_orders', from: customer, to: order, cardinality: 'many' });
  registry.defineLink({ name: 'Product_orders', from: product, to: order, cardinality: 'many' });

  return registry;
};

const connect = async ({ registry }: { registry: Registry }): Promise<Client> => {
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

const listTools = async ({ registry }: { registry: Registry }) =>
  (await connect({ registry })).listTools();

const filterOf = ({ tool }: { tool: { inputSchema?: unknown } }): Record<string, unknown> =>
  (tool.inputSchema as { properties: { filter: Record<string, unknown> } }).properties.filter;

/** Call `<Object>_list` with a filter and report what came back. */
const callList = async ({
  name,
  filter,
}: {
  name: string;
  filter: unknown;
}): Promise<ToolCallResult> => {
  const client = await connect({ registry: buildRegistry() });

  return (await client.callTool({
    name,
    arguments: { filter },
  })) as unknown as ToolCallResult;
};

const specOf = ({ schema }: { schema: z.ZodType }) => deriveFilterSpec({ schema });

describe('ONT-053 — the filter schema is closed and describes the object`s own fields', () => {
  it('names each declared scalar field, and nothing else', async () => {
    const { tools } = await listTools({ registry: buildRegistry() });
    const filter = filterOf({ tool: tools.find((tool) => tool.name === 'Customer_list')! });

    expect(Object.keys(filter['properties'] as object)).toEqual(['email', 'id', 'name']);
    expect(filter['additionalProperties']).toBe(false);
  });

  it('publishes a bare value OR a bounded operator object per field', async () => {
    const { tools } = await listTools({ registry: buildRegistry() });
    const schema = tools.find((tool) => tool.name === 'Order_list')!.inputSchema as unknown as {
      properties: { filter: { properties: Record<string, { anyOf: Record<string, string>[] }> } };
      $defs: Record<string, { type?: string; properties?: object; additionalProperties?: boolean }>;
    };

    const [leaf, reference] = schema.properties.filter.properties['total']!.anyOf;
    expect(leaf).toEqual({ type: 'number' });
    expect(reference).toEqual({ $ref: '#/$defs/numberOperators' });

    const operators = schema.$defs['numberOperators']!;
    expect(Object.keys(operators.properties as object)).toEqual([
      'equals',
      'gt',
      'gte',
      'in',
      'lt',
      'lte',
      'not',
    ]);
    // The operator object is closed too — the whole grammar is enumerated.
    expect(operators).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('states each operator grammar ONCE per kind rather than once per column', async () => {
    const { tools } = await listTools({ registry: buildRegistry() });
    const schema = tools.find((tool) => tool.name === 'Product_list')!.inputSchema as unknown as {
      properties: { filter: { properties: Record<string, { anyOf: Record<string, string>[] }> } };
      $defs: Record<string, unknown>;
    };

    // Product has three string columns and one number column; the enum is
    // written out in place because its operands are its own members.
    expect(Object.keys(schema.$defs).sort()).toEqual([
      'booleanOperators',
      'numberOperators',
      'stringOperators',
    ]);
    for (const column of ['id', 'title']) {
      expect(schema.properties.filter.properties[column]!.anyOf[1]).toEqual({
        $ref: '#/$defs/stringOperators',
      });
    }
  });

  it('omits `$defs` entirely when the object has no filterable scalar field', async () => {
    const registry = createRegistry();
    registry.defineObject({
      name: 'Opaque',
      schema: z.object({ blob: z.unknown() }),
      resolve,
    });

    const { tools } = await listTools({ registry });
    const schema = tools.find((tool) => tool.name === 'Opaque_list')!.inputSchema;

    expect(schema).not.toHaveProperty('$defs');
  });

  it('publishes an enum`s members, in declared order, on the value and on `in`', async () => {
    const { tools } = await listTools({ registry: buildRegistry() });
    const properties = filterOf({ tool: tools.find((tool) => tool.name === 'Product_list')! })[
      'properties'
    ] as Record<string, { anyOf: Record<string, unknown>[] }>;

    const [leaf, operators] = properties['status']!.anyOf;

    expect(leaf).toEqual({ type: 'string', enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] });
    expect((operators!['properties'] as Record<string, unknown>)['in']).toEqual({
      type: 'array',
      items: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] },
    });
  });

  it('admits null as a whole value on a nullable column, and never as an operand', () => {
    const spec = specOf({ schema: z.object({ name: z.string().optional(), id: z.string() }) });
    const properties = deriveFilterSchema({ spec }).filter.properties as Record<
      string,
      { anyOf: { type?: string | string[] }[] }
    >;

    expect(properties['name']!.anyOf[0]).toEqual({ type: ['string', 'null'] });
    expect(properties['id']!.anyOf[0]).toEqual({ type: 'string' });
    expect(validateFilter({ filter: { name: null }, spec })).toEqual([]);
    expect(validateFilter({ filter: { id: null }, spec })).toHaveLength(1);
    // `{ gt: null }` is meaningless, and excluding it is what lets a nullable
    // and a non-nullable string column share one published operator object.
    expect(validateFilter({ filter: { name: { gt: null } }, spec })).toEqual([
      '"name.gt" expects string',
    ]);
    expect(properties['name']!.anyOf[1]).toEqual({ $ref: '#/$defs/stringOperators' });
    expect(properties['id']!.anyOf[1]).toEqual({ $ref: '#/$defs/stringOperators' });
  });

  it('drops a BigInt column, because it cannot be filtered over JSON-RPC at all', () => {
    // The emitted `z.bigint()` rejects a JSON number, so advertising the field
    // would promise a filter that could never succeed.
    const spec = specOf({ schema: z.object({ big: z.bigint(), id: z.string() }) });

    expect(Object.keys(spec)).toEqual(['id']);
    expect(validateFilter({ filter: { big: 1 }, spec })).toEqual([
      '"big" is not a filterable field of this object (fields: id)',
    ]);
  });

  it('refuses a non-finite number rather than handing NaN to the driver', () => {
    const spec = specOf({ schema: z.object({ price: z.number() }) });

    expect(validateFilter({ filter: { price: { gt: Number.NaN } }, spec })).toEqual([
      '"price.gt" expects number',
    ]);
  });

  it('leaves an undescribable field out, which means it is not filterable', () => {
    const spec = specOf({ schema: z.object({ metadata: z.unknown(), tags: z.array(z.string()) }) });

    expect(deriveFilterSchema({ spec })).toEqual({
      filter: { type: 'object', properties: {}, additionalProperties: false },
      defs: {},
    });
    expect(validateFilter({ filter: { metadata: 'x' }, spec })).toEqual([
      '"metadata" is not a filterable field of this object',
    ]);
  });

  it('sorts fields and defs, so two servers built from one registry publish one payload', () => {
    const spec = specOf({
      schema: z.object({ zeta: z.string(), alpha: z.string(), mid: z.number() }),
    });
    const { filter, defs } = deriveFilterSchema({ spec });

    expect(Object.keys(filter.properties as object)).toEqual(['alpha', 'mid', 'zeta']);
    expect(Object.keys(defs)).toEqual(['numberOperators', 'stringOperators']);
  });

  it('leaves cursor and limit exactly as they were', async () => {
    const { tools } = await listTools({ registry: buildRegistry() });
    const properties = (
      tools.find((tool) => tool.name === 'Customer_list')!.inputSchema as {
        properties: Record<string, unknown>;
      }
    ).properties;

    expect(properties['cursor']).toEqual({ type: 'string' });
    expect(properties['limit']).toEqual({ type: 'number' });
  });
});

describe('ONT-053 — the schema is a gate, not a hint', () => {
  it('REFUSES a relation filter into an object type with no tool', async () => {
    // The defect, verbatim: reproduced against a real sqlite project, this
    // filter recovered `Order.secret` for a customer one prefix at a time,
    // through a server whose tools/list carried no Order tool at all.
    seen.length = 0;

    const result = await callList({
      name: 'Customer_list',
      filter: { orders: { some: { secret: { startsWith: 'h' } } } },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.status).toBe('invalid_input');
    expect(result.structuredContent?.issues).toEqual([
      '"orders" is not a filterable field of this object (fields: email, id, name)',
    ]);
    // The whole point: the resolver was never reached, so no `where` was built.
    expect(seen).toEqual([]);
  });

  it('refuses AND / OR / NOT with a reason, not a generic unknown-key error', async () => {
    const result = await callList({
      name: 'Customer_list',
      filter: { AND: [{ email: 'a@example.com' }] },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.issues).toEqual([
      '"AND" is not supported — a filter is a flat conjunction of field predicates',
    ]);
  });

  it('refuses a Prisma operator that is not in the published set', () => {
    const spec = specOf({ schema: z.object({ email: z.string() }) });

    expect(validateFilter({ filter: { email: { mode: 'insensitive' } }, spec })).toEqual([
      '"email.mode" is not a supported operator (allowed: contains, endsWith, equals, gt, gte, in, lt, lte, not, startsWith)',
    ]);
  });

  it('refuses a value of the wrong type, and an enum member that does not exist', () => {
    const spec = specOf({
      schema: z.object({ price: z.number(), status: z.enum(['DRAFT', 'ACTIVE']) }),
    });

    expect(validateFilter({ filter: { price: '5' }, spec })).toEqual([
      '"price" expects number or an operator object',
    ]);
    expect(validateFilter({ filter: { status: 'PAID' }, spec })).toEqual([
      '"status" expects one of DRAFT, ACTIVE or an operator object',
    ]);
    expect(validateFilter({ filter: { status: { in: ['DRAFT', 'PAID'] } }, spec })).toEqual([
      '"status.in" expects an array of one of DRAFT, ACTIVE',
    ]);
  });

  it('refuses a prototype key with the ordinary message, not an internal error', async () => {
    // `JSON.parse` gives `{"__proto__": …}` an OWN key, and a plain-object
    // lookup for it returns `Object.prototype` — truthy. A membership test
    // written as `spec[key] === undefined` would admit it and then throw.
    const spec = specOf({ schema: z.object({ id: z.string() }) });
    const hostile = JSON.parse('{"__proto__": {"gt": 1}, "constructor": 1}') as unknown;

    expect(validateFilter({ filter: hostile, spec })).toEqual([
      '"__proto__" is not a filterable field of this object (fields: id)',
      '"constructor" is not a filterable field of this object (fields: id)',
    ]);

    seen.length = 0;
    const result = await callList({ name: 'Customer_list', filter: hostile });

    expect(result.structuredContent?.status).toBe('invalid_input');
    expect(seen).toEqual([]);
  });

  it('refuses a filter that is not an object at all', () => {
    const spec = specOf({ schema: z.object({ id: z.string() }) });

    for (const filter of [[], 'id', 7, null]) {
      expect(validateFilter({ filter, spec })).toEqual([
        'filter must be an object of field predicates',
      ]);
    }
  });

  it('reports every violation at once rather than the first', () => {
    const spec = specOf({ schema: z.object({ id: z.string() }) });
    const issues = validateFilter({ filter: { orders: {}, OR: [], id: 5 }, spec });

    expect(issues).toHaveLength(3);
  });

  it('names keys and expected shapes, never the value the caller sent', () => {
    // The message reaches the agent AND the operator log; a probe's payload is
    // not something either should be made to echo.
    const spec = specOf({ schema: z.object({ email: z.string() }) });
    const issues = validateFilter({ filter: { email: { startsWith: 12345 } }, spec });

    expect(issues).toEqual(['"email.startsWith" expects string']);
    expect(issues.join(' ')).not.toContain('12345');
  });

  it('ADMITS everything it advertises, and forwards it untouched', async () => {
    seen.length = 0;

    const filter = {
      email: { contains: '@example.com' },
      name: null,
      id: { in: ['c1', 'c2'] },
    };
    const result = await callList({ name: 'Customer_list', filter });

    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([{ filter }]);
  });

  it('lets a scalar comparison through — the operators that already worked keep working', async () => {
    seen.length = 0;

    const result = await callList({ name: 'Order_list', filter: { total: { gt: 5, lte: 100 } } });

    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([{ filter: { total: { gt: 5, lte: 100 } } }]);
  });

  it('leaves a call with no filter at all untouched', async () => {
    seen.length = 0;

    const client = await connect({ registry: buildRegistry() });
    const result = (await client.callTool({
      name: 'Customer_list',
      arguments: {},
    })) as unknown as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([{ filter: undefined }]);
  });
});

describe('ONT-053 — read tools name the object`s relations', () => {
  it('states the outbound side on both read tools', async () => {
    const { tools } = await listTools({ registry: buildRegistry() });

    expect(tools.find((tool) => tool.name === 'Customer_list')?.description).toBe(
      'List Customer records. Relations: has many Order.',
    );
    expect(tools.find((tool) => tool.name === 'Customer_get')?.description).toBe(
      'Fetch a single Customer by id. Relations: has many Order.',
    );
  });

  it('states the inbound side on the far object', async () => {
    const { tools } = await listTools({ registry: buildRegistry() });

    expect(tools.find((tool) => tool.name === 'Order_list')?.description).toBe(
      'List Order records. Relations: belongs to Customer; belongs to Product.',
    );
  });

  it('leaves an object with no links byte-identical to before', async () => {
    const registry = createRegistry();
    registry.defineObject({
      name: 'Standalone',
      schema: z.object({ id: z.string() }),
      resolve,
    });

    const { tools } = await listTools({ registry });

    expect(tools.find((tool) => tool.name === 'Standalone_get')?.description).toBe(
      'Fetch a single Standalone by id.',
    );
    expect(tools.find((tool) => tool.name === 'Standalone_list')?.description).toBe(
      'List Standalone records.',
    );
  });

  it('names what exists without offering a way to traverse it', async () => {
    // Knowledge, not capability. The tool set is unchanged by the sentence.
    const { tools } = await listTools({ registry: buildRegistry() });

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'Customer_get',
      'Customer_list',
      'Order_get',
      'Order_list',
      'Product_get',
      'Product_list',
    ]);
  });

  it('orders sentences by link name, not by declaration order', () => {
    const object = (name: string) => ({ name }) as never;
    const link = (name: string, from: string, to: string) =>
      ({
        kind: 'link' as const,
        name,
        from: object(from),
        to: object(to),
        cardinality: 'many' as const,
      }) as never;

    const forward = relationLines({
      links: [link('A_zeta', 'A', 'Zeta'), link('A_alpha', 'A', 'Alpha')],
    });
    const reversed = relationLines({
      links: [link('A_alpha', 'A', 'Alpha'), link('A_zeta', 'A', 'Zeta')],
    });

    expect(forward.get('A')).toBe('Relations: has many Alpha; has many Zeta.');
    expect(reversed.get('A')).toBe(forward.get('A'));
  });

  it('collapses two links between the same pair into one phrase', () => {
    // A `LinkDefinition` carries no relation-field name, so there is nothing
    // truthful to tell `author` and `reviewer` apart with.
    const object = (name: string) => ({ name }) as never;
    const lines = relationLines({
      links: [
        {
          kind: 'link',
          name: 'Post_author',
          from: object('User'),
          to: object('Post'),
          cardinality: 'many',
        } as never,
        {
          kind: 'link',
          name: 'Post_reviewer',
          from: object('User'),
          to: object('Post'),
          cardinality: 'many',
        } as never,
      ],
    });

    expect(lines.get('User')).toBe('Relations: has many Post.');
  });

  it('weakens the far-side phrase for a one-cardinality link', () => {
    const object = (name: string) => ({ name }) as never;
    const lines = relationLines({
      links: [
        {
          kind: 'link',
          name: 'Order_invoice',
          from: object('Order'),
          to: object('Invoice'),
          cardinality: 'one',
        } as never,
      ],
    });

    expect(lines.get('Order')).toBe('Relations: has one Invoice.');
    expect(lines.get('Invoice')).toBe('Relations: referenced by Order.');
  });
});

describe('ONT-053 — the whole payload is deterministic', () => {
  it('two servers built from equivalent registries emit identical tools/list bytes', async () => {
    const first = await listTools({ registry: buildRegistry() });
    const second = await listTools({ registry: buildRegistry() });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
