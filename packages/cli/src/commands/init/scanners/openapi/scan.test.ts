import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { actionFieldExpr } from '../../codegen/zod';
import type { IrAction } from '../../ir';
import { scanOpenApiJson, YAML_HINT } from './scan';

const DOC = JSON.stringify({
  openapi: '3.0.3',
  paths: {
    '/products': { get: { operationId: 'listProducts', responses: {} } },
    '/orders': {
      post: {
        operationId: 'placeOrder',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['productId', 'quantity'],
                properties: {
                  productId: { type: 'string' },
                  quantity: { type: 'integer' },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    '/products/{id}': {
      delete: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {},
      },
    },
    '/coupons': {
      post: { operationId: "grant'); import(`fs`); /* coupon", responses: {} },
    },
  },
});

describe('scanOpenApiJson', () => {
  it('skips GET with an info line and maps write operations', () => {
    const scanned = scanOpenApiJson({ source: DOC });

    expect(scanned.infos.some((i) => /GET \/products/.test(i))).toBe(true);
    expect(scanned.actions.map((a) => a.name).sort()).toEqual(
      ['deleteProductsId', 'grant_import_fs_coupon', 'placeOrder'].sort(),
    );
  });

  it('maps request-body properties with required/optional', () => {
    const scanned = scanOpenApiJson({ source: DOC });
    const place = scanned.actions.find((a) => a.name === 'placeOrder');

    const byName = new Map(place?.input.map((f) => [f.name, f]));
    expect(byName.get('productId')?.optional).toBe(false);
    expect(byName.get('quantity')?.scalar).toBe('int');
    expect(byName.get('note')?.optional).toBe(true);
  });

  it('derives a name for an operation with no operationId', () => {
    const scanned = scanOpenApiJson({ source: DOC });
    const del = scanned.actions.find((a) => a.method === 'DELETE');

    expect(del?.name).toBe('deleteProductsId');
    expect(del?.input.map((f) => f.name)).toEqual(['id']);
  });

  it('sanitizes a hostile operationId into an MCP-safe name, keeping the raw as data', () => {
    const scanned = scanOpenApiJson({ source: DOC });
    const coupon = scanned.actions.find((a) => a.path === '/coupons');

    expect(coupon?.name).toBe('grant_import_fs_coupon');
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(coupon?.name ?? '')).toBe(true);
    expect(coupon?.rawName).toBe("grant'); import(`fs`); /* coupon");
  });

  it('exposes the actionable YAML convert-to-JSON hint text', () => {
    expect(YAML_HINT).toMatch(/convert it to JSON/i);
  });

  it('resolves $ref path parameters into the action input (GitHub shape)', () => {
    // GitHub's spec shares owner/repo as component $refs on nearly every
    // operation; those entries carry no inline `name` and previously dropped.
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/repos/{owner}/{repo}/topics': {
          put: {
            operationId: 'replaceTopics',
            parameters: [
              { $ref: '#/components/parameters/owner' },
              { $ref: '#/components/parameters/repo' },
            ],
          },
        },
      },
      components: {
        parameters: {
          owner: { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          repo: { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const replaceTopics = scanned.actions.find((a) => a.name === 'replaceTopics');

    expect(replaceTopics?.input.map((f) => f.name)).toEqual(['owner', 'repo']);
    expect(replaceTopics?.input.every((f) => f.optional === false)).toBe(true);
    expect(scanned.warnings).toHaveLength(0);
  });

  it('skips a resolved non-path parameter exactly like an inline one', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/orgs/{org}/rules': {
          post: {
            operationId: 'createRule',
            parameters: [
              { $ref: '#/components/parameters/perPage' },
              { $ref: '#/components/parameters/org' },
            ],
          },
        },
      },
      components: {
        parameters: {
          perPage: { name: 'per_page', in: 'query', schema: { type: 'integer' } },
          org: { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const createRule = scanned.actions.find((a) => a.name === 'createRule');

    // The resolved query param is skipped; only the resolved path param lands.
    expect(createRule?.input.map((f) => f.name)).toEqual(['org']);
    expect(scanned.warnings).toHaveLength(0);
  });

  it('drops an unresolvable $ref parameter, keeps the inline one, and warns by reason', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/refparams/{id}': {
          put: {
            operationId: 'updateRefParam',
            parameters: [
              { $ref: '#/components/parameters/Gone' },
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ],
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const updateRefParam = scanned.actions.find((a) => a.name === 'updateRefParam');

    expect(updateRefParam?.input.map((f) => f.name)).toEqual(['id']);
    const warning = scanned.warnings.find((w) => /unresolvable \$ref/.test(w));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/missing/);
  });

  it('resolves a top-level $ref request body (cal.com/NestJS shape)', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/bookings/{uid}/cancel': {
          post: {
            operationId: 'cancelBooking',
            requestBody: {
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CancelBookingInput' } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          CancelBookingInput: {
            type: 'object',
            required: ['cancellationReason'],
            properties: {
              cancellationReason: { type: 'string' },
              allRemainingBookings: { type: 'boolean' },
            },
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const cancel = scanned.actions.find((a) => a.name === 'cancelBooking');
    const byName = new Map(cancel?.input.map((f) => [f.name, f]));

    expect(byName.get('cancellationReason')?.optional).toBe(false);
    expect(byName.get('cancellationReason')?.scalar).toBe('string');
    expect(byName.get('allRemainingBookings')?.optional).toBe(true);
    expect(byName.get('allRemainingBookings')?.scalar).toBe('boolean');
    expect(scanned.warnings).toHaveLength(0);
  });

  it('resolves a property-level $ref (nested schema -> schema)', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/bookings/{uid}/reschedule': {
          post: {
            operationId: 'rescheduleBooking',
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RescheduleBookingInput' },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          SeatId: { type: 'integer' },
          RescheduleBookingInput: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: { type: 'string' },
              seatId: { $ref: '#/components/schemas/SeatId' },
            },
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const reschedule = scanned.actions.find((a) => a.name === 'rescheduleBooking');
    const byName = new Map(reschedule?.input.map((f) => [f.name, f]));

    expect(byName.get('seatId')?.scalar).toBe('int');
    expect(byName.get('seatId')?.optional).toBe(true);
    expect(byName.get('reason')?.optional).toBe(false);
    expect(scanned.warnings).toHaveLength(0);
  });

  it('merges an allOf body: union of branch properties + union of required', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/bookings/{uid}': {
          patch: {
            operationId: 'updateBooking',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/BaseUpdate' },
                      { $ref: '#/components/schemas/ExtraUpdate' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          BaseUpdate: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          ExtraUpdate: { type: 'object', properties: { note: { type: 'string' } } },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const update = scanned.actions.find((a) => a.name === 'updateBooking');
    const byName = new Map(update?.input.map((f) => [f.name, f]));

    expect(update?.input.map((f) => f.name)).toEqual(['id', 'note']);
    expect(byName.get('id')?.optional).toBe(false);
    expect(byName.get('note')?.optional).toBe(true);
    // allOf is a plain merge, not a union — no composition warning.
    expect(scanned.warnings).toHaveLength(0);
  });

  it('surfaces a oneOf body as an all-optional union with a composition warning', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/unions': {
          post: {
            operationId: 'createUnion',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/BranchA' },
                      { $ref: '#/components/schemas/BranchB' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          BranchA: {
            type: 'object',
            required: ['emailField'],
            properties: { emailField: { type: 'string' } },
          },
          BranchB: { type: 'object', properties: { phoneField: { type: 'string' } } },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const union = scanned.actions.find((a) => a.name === 'createUnion');

    expect(union?.input.map((f) => f.name)).toEqual(['emailField', 'phoneField']);
    // Every branch field is optional even though emailField is required in BranchA.
    expect(union?.input.every((f) => f.optional)).toBe(true);
    expect(scanned.warnings.some((w) => /oneOf|composition/.test(w))).toBe(true);
  });

  it('treats a single-branch composition as the plain branch schema', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/single': {
          post: {
            operationId: 'createSingle',
            requestBody: {
              content: {
                'application/json': {
                  schema: { oneOf: [{ $ref: '#/components/schemas/BranchA' }] },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          BranchA: {
            type: 'object',
            required: ['emailField'],
            properties: { emailField: { type: 'string' } },
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const single = scanned.actions.find((a) => a.name === 'createSingle');

    // Single branch keeps its declared requirements and raises no warning.
    expect(single?.input.find((f) => f.name === 'emailField')?.optional).toBe(false);
    expect(scanned.warnings).toHaveLength(0);
  });

  it('keeps a hostile enum string inside a resolved component schema as escaped data', () => {
    const hostile = "emergency'); import(`fs`); /*";
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/priorities': {
          post: {
            operationId: 'setPriority',
            requestBody: {
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/PriorityInput' } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          PriorityInput: {
            type: 'object',
            properties: { priority: { enum: ['low', 'high', hostile] } },
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const setPriority = scanned.actions.find((a) => a.name === 'setPriority');
    const priority = setPriority?.input.find((f) => f.name === 'priority');

    expect(priority?.kind).toBe('enum');
    expect(priority?.enumValues).toContain(hostile);
  });

  it('names each unresolvable reason bucket without leaking resolvable refs', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/cycles': {
          post: {
            operationId: 'createCycle',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ChainA' } } },
            },
          },
        },
        '/missing': {
          post: {
            operationId: 'createMissing',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } },
            },
          },
        },
        '/externals': {
          post: {
            operationId: 'createExternal',
            requestBody: {
              content: {
                'application/json': { schema: { $ref: 'https://example.com/ext.json#/Thing' } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ChainA: { $ref: '#/components/schemas/ChainB' },
          ChainB: { $ref: '#/components/schemas/ChainA' },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const warning = scanned.warnings.find((w) => /unresolvable \$ref/.test(w));

    expect(warning).toMatch(/missing/);
    expect(warning).toMatch(/external/);
    expect(warning).toMatch(/cycle/);
  });

  it('AC-6 pin: a GitHub-shape $ref-param op goes from 0 to 2 named fields', () => {
    const op = {
      operationId: 'replaceTopics',
      parameters: [
        { $ref: '#/components/parameters/owner' },
        { $ref: '#/components/parameters/repo' },
      ],
    };

    // Before: the same op with no component targets resolves nothing.
    const before = scanOpenApiJson({
      source: JSON.stringify({
        openapi: '3.0.3',
        paths: { '/repos/{owner}/{repo}/topics': { put: op } },
      }),
    });
    const beforeOp = before.actions.find((a) => a.name === 'replaceTopics');
    expect(beforeOp?.input).toHaveLength(0);

    // After: with the shared owner/repo components, both path params land.
    const after = scanOpenApiJson({
      source: JSON.stringify({
        openapi: '3.0.3',
        paths: { '/repos/{owner}/{repo}/topics': { put: op } },
        components: {
          parameters: {
            owner: { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            repo: { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          },
        },
      }),
    });
    const afterOp = after.actions.find((a) => a.name === 'replaceTopics');
    expect(afterOp?.input.map((f) => f.name)).toEqual(['owner', 'repo']);
  });

  it('AC-6 pin: a cal.com-shape $ref-body op goes from 0 to its named body fields', () => {
    const op = {
      operationId: 'cancelBooking',
      requestBody: {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CancelBookingInput' } },
        },
      },
    };

    // Before: the $ref body target is absent, so no fields are produced.
    const before = scanOpenApiJson({
      source: JSON.stringify({
        openapi: '3.0.3',
        paths: { '/bookings/{uid}/cancel': { post: op } },
      }),
    });
    const beforeOp = before.actions.find((a) => a.name === 'cancelBooking');
    expect(beforeOp?.input).toHaveLength(0);

    // After: the resolved body maps its properties/required into the input.
    const after = scanOpenApiJson({
      source: JSON.stringify({
        openapi: '3.0.3',
        paths: { '/bookings/{uid}/cancel': { post: op } },
        components: {
          schemas: {
            CancelBookingInput: {
              type: 'object',
              required: ['cancellationReason'],
              properties: {
                cancellationReason: { type: 'string' },
                allRemainingBookings: { type: 'boolean' },
              },
            },
          },
        },
      }),
    });
    const afterOp = after.actions.find((a) => a.name === 'cancelBooking');
    expect(afterOp?.input.map((f) => f.name)).toEqual([
      'cancellationReason',
      'allRemainingBookings',
    ]);
  });
});

/** A one-write-operation document whose single body property is `property`. */
const docWith = ({ property }: { property: unknown }): string =>
  JSON.stringify({
    openapi: '3.0.3',
    paths: {
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', required: ['value'], properties: { value: property } },
              },
            },
          },
        },
      },
    },
  });

/** The emitted expression for the single `value` property of `docWith`. */
const exprFor = ({ property }: { property: unknown }): string => {
  const scanned = scanOpenApiJson({ source: docWith({ property }) });
  const field = scanned.actions[0]?.input[0];

  return field === undefined ? '<no field>' : actionFieldExpr({ field });
};

/**
 * Rebuild a runtime schema out of the EMITTED expressions. The assertion is then
 * about the artifact that lands in `ontology/<action>.mjs`, not about a
 * hand-written copy of it — `new Function` evaluates exactly the emitted string.
 */
const emittedSchema = ({ action }: { action: IrAction }): z.ZodType => {
  const entries = action.input
    .map((field) => `${JSON.stringify(field.name)}: ${actionFieldExpr({ field })}`)
    .join(', ');

  return new Function('z', `return z.object({ ${entries} });`)(z) as z.ZodType;
};

const PRODUCTS_DOC = JSON.stringify({
  openapi: '3.0.0',
  paths: {
    '/products': {
      post: {
        operationId: 'createProduct',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'priceCents'],
                properties: {
                  name: { type: 'string', minLength: 1 },
                  priceCents: { type: 'integer', minimum: 0 },
                  discountPct: { type: 'number', minimum: 0, maximum: 100 },
                },
              },
            },
          },
        },
      },
    },
  },
});

describe('scanOpenApiJson value constraints (ONT-037)', () => {
  it('carries the declared bounds from the issue #29 reproduction into the emitted zod', () => {
    const scanned = scanOpenApiJson({ source: PRODUCTS_DOC });
    const create = scanned.actions.find((a) => a.name === 'createProduct');
    const exprs = new Map(create?.input.map((f) => [f.name, actionFieldExpr({ field: f })]));

    expect(exprs.get('name')).toBe('z.string().min(1)');
    expect(exprs.get('priceCents')).toBe('z.number().int().min(0)');
    expect(exprs.get('discountPct')).toBe('z.number().min(0).max(100).optional()');
    // Every declared constraint was honored, so there is nothing to report.
    expect(scanned.warnings).toHaveLength(0);
  });

  it('rejects the contract-violating payload the pre-fix schema accepted', () => {
    const scanned = scanOpenApiJson({ source: PRODUCTS_DOC });
    const create = scanned.actions.find((a) => a.name === 'createProduct') as IrAction;
    const schema = emittedSchema({ action: create });

    expect(schema.safeParse({ name: '', priceCents: -500, discountPct: -1 }).success).toBe(false);
    expect(schema.safeParse({ name: 'Rail', priceCents: 500, discountPct: 10 }).success).toBe(true);
  });

  it('renders exclusive bounds in both the 3.0 modifier and the 3.1 numeric spelling', () => {
    // OpenAPI 3.0: a boolean flag that makes the sibling `minimum` exclusive.
    expect(
      exprFor({
        property: {
          type: 'number',
          minimum: 0,
          exclusiveMinimum: true,
          maximum: 10,
          exclusiveMaximum: true,
        },
      }),
    ).toBe('z.number().gt(0).lt(10)');

    // JSON Schema 2020-12 / OpenAPI 3.1: the keyword IS the bound.
    expect(
      exprFor({ property: { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 } }),
    ).toBe('z.number().int().gt(0).lt(10)');
  });

  it('emits both bounds when an inclusive and an exclusive one are declared together', () => {
    // Their intersection is `>= 10`; emitting only `.gt(5)` would be weaker than
    // what the spec declares, which is the whole defect this ticket fixes.
    expect(exprFor({ property: { type: 'integer', minimum: 10, exclusiveMinimum: 5 } })).toBe(
      'z.number().int().min(10).gt(5)',
    );
  });

  it('treats an explicit `exclusiveMinimum: false` as the no-op it is', () => {
    const scanned = scanOpenApiJson({
      source: docWith({ property: { type: 'integer', minimum: 0, exclusiveMinimum: false } }),
    });

    expect(actionFieldExpr({ field: scanned.actions[0]!.input[0]! })).toBe(
      'z.number().int().min(0)',
    );
    expect(scanned.warnings).toHaveLength(0);
  });

  it('honors a string pattern through the escaping layer, hostile quotes included', () => {
    expect(exprFor({ property: { type: 'string', pattern: '^[A-Z]{2}-[0-9]+$' } })).toBe(
      'z.string().regex(new RegExp("^[A-Z]{2}-[0-9]+$"))',
    );

    const scanned = scanOpenApiJson({
      source: docWith({ property: { type: 'string', pattern: '^["a-z]+$' } }),
    });
    const schema = emittedSchema({ action: scanned.actions[0]! });

    // The quote survived as inert data: the emitted literal still evaluates and
    // still enforces the pattern.
    expect(schema.safeParse({ value: '"abc' }).success).toBe(true);
    expect(schema.safeParse({ value: 'ABC' }).success).toBe(false);
    expect(scanned.warnings).toHaveLength(0);
  });

  it('honors bounds declared on a path parameter', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/tenants/{slug}': {
          put: {
            operationId: 'updateTenant',
            parameters: [
              {
                name: 'slug',
                in: 'path',
                required: true,
                schema: { type: 'string', minLength: 3, maxLength: 32 },
              },
            ],
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });

    expect(actionFieldExpr({ field: scanned.actions[0]!.input[0]! })).toBe(
      'z.string().min(3).max(32)',
    );
  });

  it('leaves a constraint-free property untouched (no IR key, byte-identical output)', () => {
    const scanned = scanOpenApiJson({ source: docWith({ property: { type: 'string' } }) });
    const field = scanned.actions[0]!.input[0]!;

    expect('constraints' in field).toBe(false);
    expect(actionFieldExpr({ field })).toBe('z.string()');
    expect(scanned.warnings).toHaveLength(0);
  });

  it('reports every constraint it cannot honor in one aggregated warning', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/drops': {
          post: {
            operationId: 'createDrop',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      // A string keyword on a numeric kind.
                      label: { type: 'integer', minLength: 3 },
                      // Any bound on an enum: the IR has no place to put it.
                      tier: { enum: ['a', 'b'], minimum: 1 },
                      // Expressible in zod, but outside this ticket's honored set.
                      ratio: { type: 'number', multipleOf: 0.5 },
                      // A pattern that does not compile as a regex.
                      code: { type: 'string', pattern: '[' },
                      // A malformed bound value.
                      size: { type: 'integer', minimum: 'nope' },
                      // An exclusivity flag with no sibling bound to modify.
                      seats: { type: 'integer', exclusiveMinimum: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const warnings = scanned.warnings.filter((w) => /constraint/.test(w));

    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    for (const mention of [
      'label.minLength',
      'tier.minimum',
      'ratio.multipleOf',
      'code.pattern',
      'size.minimum',
      'seats.exclusiveMinimum',
    ]) {
      expect(warning).toContain(mention);
    }

    // Nothing unenforceable leaked into the emitted expressions.
    const exprs = scanned.actions[0]!.input.map((f) => actionFieldExpr({ field: f }));
    expect(exprs.every((e) => !/\.(min|max|gt|lt|regex|multipleOf)\(/.test(e))).toBe(true);
  });
});

/**
 * ONT-042 A — `type: array` and `type: object` missed `JSON_TYPE_TO_SCALAR`
 * entirely, so `baseOf` fell through to `SCALARS['string']` and both emitted
 * `z.string()` with nothing in the report. The agent was told a string was
 * acceptable and every valid call failed validation.
 */
describe('scanOpenApiJson array and object properties (ONT-042 A)', () => {
  it('maps an array of scalars and a nested object instead of collapsing both to a string', () => {
    const scanned = scanOpenApiJson({
      source: docWith({ property: { type: 'array', items: { type: 'string' } } }),
    });

    expect(actionFieldExpr({ field: scanned.actions[0]!.input[0]! })).toBe('z.array(z.string())');

    expect(
      exprFor({ property: { type: 'object', properties: { deep: { type: 'string' } } } }),
    ).toBe('z.object({ "deep": z.string().optional() })');
  });

  it('accepts the values the spec allows and rejects the ones it does not', () => {
    const scanned = scanOpenApiJson({
      source: docWith({
        property: { type: 'object', required: ['deep'], properties: { deep: { type: 'string' } } },
      }),
    });
    const schema = emittedSchema({ action: scanned.actions[0]! });

    // Both of these used to be inverted: the object was rejected, a string passed.
    expect(schema.safeParse({ value: { deep: 'ok' } }).success).toBe(true);
    expect(schema.safeParse({ value: 'a string' }).success).toBe(false);
  });

  it('honors the item constraints of an array and the required set of a nested object', () => {
    expect(exprFor({ property: { type: 'array', items: { type: 'integer', minimum: 0 } } })).toBe(
      'z.array(z.number().int().min(0))',
    );

    expect(
      exprFor({
        property: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' }, note: { type: 'string' } },
        },
      }),
    ).toBe('z.object({ "id": z.string(), "note": z.string().optional() })');
  });

  it('maps an array of objects and an object nested two levels deep', () => {
    expect(
      exprFor({
        property: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' } } },
        },
      }),
    ).toBe('z.array(z.object({ "id": z.string().optional() }))');

    expect(
      exprFor({
        property: {
          type: 'object',
          properties: { inner: { type: 'object', properties: { leaf: { type: 'integer' } } } },
        },
      }),
    ).toBe('z.object({ "inner": z.object({ "leaf": z.number().int().optional() }).optional() })');
  });

  it('resolves a $ref item and a $ref nested property', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/tags': {
          post: {
            operationId: 'createTags',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
                      owner: { $ref: '#/components/schemas/Owner' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Tag: { type: 'string', minLength: 1 },
          Owner: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const exprs = new Map(
      scanned.actions[0]!.input.map((f) => [f.name, actionFieldExpr({ field: f })]),
    );

    expect(exprs.get('tags')).toBe('z.array(z.string().min(1)).optional()');
    expect(exprs.get('owner')).toBe('z.object({ "id": z.string().optional() }).optional()');
    expect(scanned.warnings).toHaveLength(0);
  });

  it('emits an untyped array as an array of unknown and says nothing (nothing was dropped)', () => {
    const scanned = scanOpenApiJson({ source: docWith({ property: { type: 'array' } }) });

    expect(actionFieldExpr({ field: scanned.actions[0]!.input[0]! })).toBe('z.array(z.unknown())');
    expect(scanned.warnings).toHaveLength(0);
  });

  it('reports an array of arrays and a property-less object instead of faking a shape', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/shapes': {
          post: {
            operationId: 'createShape',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      matrix: {
                        type: 'array',
                        items: { type: 'array', items: { type: 'string' } },
                      },
                      freeform: { type: 'object' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const exprs = new Map(
      scanned.actions[0]!.input.map((f) => [f.name, actionFieldExpr({ field: f })]),
    );

    expect(exprs.get('matrix')).toBe('z.array(z.unknown()).optional()');
    expect(exprs.get('freeform')).toBe('z.unknown().optional()');

    const warnings = scanned.warnings.filter((w) => /cannot express/.test(w));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('matrix (array of arrays)');
    expect(warnings[0]).toContain('freeform (object with no declared properties)');
  });

  it('stops at the nesting bound instead of recursing forever through an inline chain', () => {
    // Six levels of inline `properties` — one past the scanner's nesting bound.
    let property: unknown = { type: 'string' };
    for (let level = 0; level < 6; level += 1) {
      property = { type: 'object', properties: { next: property } };
    }

    const scanned = scanOpenApiJson({ source: docWith({ property }) });

    expect(scanned.warnings.some((w) => /nested deeper than/.test(w))).toBe(true);
    expect(actionFieldExpr({ field: scanned.actions[0]!.input[0]! })).toContain('z.unknown()');
  });

  it('reports the array/object cardinality keywords it does not carry', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/cards': {
          post: {
            operationId: 'createCard',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tags: {
                        type: 'array',
                        items: { type: 'string' },
                        minItems: 1,
                        uniqueItems: true,
                      },
                      meta: {
                        type: 'object',
                        properties: { k: { type: 'string' } },
                        minProperties: 1,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const warning = scanOpenApiJson({ source: doc }).warnings.find((w) => /constraint/.test(w));

    expect(warning).toContain('tags.minItems');
    expect(warning).toContain('tags.uniqueItems');
    expect(warning).toContain('meta.minProperties');
  });
});

/**
 * ONT-042 B — `collectInput` read `content['application/json']` and nothing
 * else, so a whole request body became `input: z.object({})` with no diagnostic.
 */
describe('scanOpenApiJson request-body media types (ONT-042 B)', () => {
  /** A one-operation document whose request body declares exactly `content`. */
  const docWithContent = ({ content }: { content: unknown }): string =>
    JSON.stringify({
      openapi: '3.0.3',
      paths: { '/things': { post: { operationId: 'createThing', requestBody: { content } } } },
    });

  const objectSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

  it('maps a non-JSON body from its declared schema and names the operation and media type', () => {
    for (const mediaType of [
      'application/xml',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
    ]) {
      const scanned = scanOpenApiJson({
        source: docWithContent({ content: { [mediaType]: { schema: objectSchema } } }),
      });

      expect(scanned.actions[0]?.input.map((f) => f.name)).toEqual(['id']);

      const warning = scanned.warnings.find((w) => /no JSON content/.test(w));
      expect(warning).toContain('POST /things');
      expect(warning).toContain(mediaType);
    }
  });

  it('reports a body whose content declares no schema at all', () => {
    const scanned = scanOpenApiJson({ source: docWithContent({ content: { 'text/plain': {} } }) });

    expect(scanned.actions[0]?.input).toHaveLength(0);
    const warning = scanned.warnings.find((w) => /declares no schema/.test(w));
    expect(warning).toContain('POST /things');
    expect(warning).toContain('text/plain');
  });

  it('recognizes +json and parameterized media types as JSON, silently', () => {
    for (const mediaType of [
      'application/json',
      'application/json; charset=utf-8',
      'application/merge-patch+json',
      'application/vnd.api+json',
    ]) {
      const scanned = scanOpenApiJson({
        source: docWithContent({ content: { [mediaType]: { schema: objectSchema } } }),
      });

      expect(scanned.actions[0]?.input.map((f) => f.name)).toEqual(['id']);
      expect(scanned.warnings).toHaveLength(0);
    }
  });

  it('prefers the JSON entry when the body offers several media types', () => {
    const scanned = scanOpenApiJson({
      source: docWithContent({
        content: {
          'application/xml': {
            schema: { type: 'object', properties: { xmlOnly: { type: 'string' } } },
          },
          'application/json': { schema: objectSchema },
        },
      }),
    });

    expect(scanned.actions[0]?.input.map((f) => f.name)).toEqual(['id']);
    expect(scanned.warnings).toHaveLength(0);
  });

  it('falls back to the entry that has a schema when the JSON one does not', () => {
    const scanned = scanOpenApiJson({
      source: docWithContent({
        content: { 'application/json': {}, 'application/xml': { schema: objectSchema } },
      }),
    });

    expect(scanned.actions[0]?.input.map((f) => f.name)).toEqual(['id']);
    expect(scanned.warnings.some((w) => /no JSON content/.test(w))).toBe(true);
  });
});

/**
 * ONT-042 E — a `__proto__` key in a generated object literal sets the
 * prototype instead of declaring the field, so it disappeared from the schema,
 * from the action input and from the write payload, silently.
 */
describe('scanOpenApiJson unrepresentable field names (ONT-042 E)', () => {
  it('skips a __proto__ body property with a warning and keeps its siblings', () => {
    // Built as raw JSON text on purpose: a JS object literal would apply the
    // same prototype rule this test is about and never carry the key at all.
    const source = String.raw`{"openapi":"3.0.3","paths":{"/evil":{"post":{"operationId":"createEvil","requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"string"}}}}}}}}}}`;

    const scanned = scanOpenApiJson({ source });

    expect(scanned.actions[0]?.input.map((f) => f.name)).toEqual(['ok']);
    const warning = scanned.warnings.find((w) => /object literal cannot carry/.test(w));
    expect(warning).toContain('__proto__');
  });

  it('skips a __proto__ path parameter the same way', () => {
    const source = String.raw`{"openapi":"3.0.3","paths":{"/p/{__proto__}":{"put":{"operationId":"putProto","parameters":[{"name":"__proto__","in":"path","required":true,"schema":{"type":"string"}},{"name":"ok","in":"path","required":true,"schema":{"type":"string"}}]}}}}`;

    const scanned = scanOpenApiJson({ source });

    expect(scanned.actions[0]?.input.map((f) => f.name)).toEqual(['ok']);
    expect(scanned.warnings.some((w) => /object literal cannot carry/.test(w))).toBe(true);
  });
});

/** ONT-042 F — the smaller reporting gaps ONT-037 left open. */
describe('scanOpenApiJson remaining reporting gaps (ONT-042 F)', () => {
  it('reports an allOf property a later branch redefines differently', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/dups': {
          post: {
            operationId: 'createDup',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { type: 'object', properties: { dup: { type: 'integer', minimum: 5 } } },
                      { type: 'object', properties: { dup: { type: 'string', maxLength: 3 } } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });

    // The first branch still wins — that behavior is unchanged.
    expect(actionFieldExpr({ field: scanned.actions[0]!.input[0]! })).toBe(
      'z.number().int().min(5).optional()',
    );
    const warning = scanned.warnings.find((w) => /more than one branch/.test(w));
    expect(warning).toContain('dup');
  });

  it('says nothing when two allOf branches declare the identical property', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/sames': {
          post: {
            operationId: 'createSame',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
                      { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(scanOpenApiJson({ source: doc }).warnings).toHaveLength(0);
  });

  it('reports `nullable: true` and treats `nullable: false` as the no-op it is', () => {
    const dropped = scanOpenApiJson({
      source: docWith({ property: { type: 'string', nullable: true } }),
    }).warnings.find((w) => /constraint/.test(w));
    expect(dropped).toContain('value.nullable');

    expect(
      scanOpenApiJson({ source: docWith({ property: { type: 'string', nullable: false } }) })
        .warnings,
    ).toHaveLength(0);
  });

  it('honors the string keywords of an UNTYPED property, which really does emit z.string()', () => {
    const scanned = scanOpenApiJson({
      source: docWith({ property: { pattern: '^a+$', minLength: 2, maxLength: 8 } }),
    });

    expect(actionFieldExpr({ field: scanned.actions[0]!.input[0]! })).toBe(
      'z.string().min(2).max(8).regex(new RegExp("^a+$"))',
    );
    expect(scanned.warnings).toHaveLength(0);
  });
});
