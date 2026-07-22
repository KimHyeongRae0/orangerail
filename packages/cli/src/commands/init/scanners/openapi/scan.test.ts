import { describe, expect, it } from 'vitest';

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
