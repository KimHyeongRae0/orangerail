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

  it('warns once, aggregated, for $ref parameters instead of dropping them silently', () => {
    // Real-world shape: GitHub's spec shares owner/repo as component $refs on
    // nearly every operation — those entries have no inline `name`.
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
        '/orgs/{org}/rules': {
          post: {
            operationId: 'createRule',
            parameters: [
              { $ref: '#/components/parameters/org' },
              { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            ],
          },
        },
      },
    });

    const scanned = scanOpenApiJson({ source: doc });
    const refWarnings = scanned.warnings.filter((w) => w.includes('$ref parameter'));

    expect(refWarnings).toHaveLength(1);
    expect(refWarnings[0]).toContain('3 $ref parameter(s) across 2 operation(s)');
    // Inline parameters on the same operation still land in the input.
    const createRule = scanned.actions.find((a) => a.name === 'createRule');
    expect(createRule?.input.map((f) => f.name)).toEqual(['org']);
  });
});
