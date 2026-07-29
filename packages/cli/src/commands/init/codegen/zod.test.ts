import { createRegistry, notImplemented } from 'orangerail-core';
import { deriveInputSchema } from 'orangerail-mcp';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { diffSync } from '../../sync/diff';
import { actionPostures, diffGovernance } from '../../../governance';
import type { IrAction, IrActionField, IrField } from '../ir';
import { scanOpenApiJson } from '../scanners/openapi/scan';
import { emitActionFile } from './emit-action';
import { actionFieldExpr, fieldExpr, fieldNode } from './zod';

/**
 * ONT-042 A — the structural half. `actionFieldExpr` now renders `z.array(...)`
 * and a nested `z.object({...})`; these cases pin the rendered bytes, the
 * generated file, and the two consumers ONT-037 identified as the ones a
 * structural IR change could disturb: the sync differ and the MCP advisory
 * `inputSchema` (AC-7).
 */

/** A `/things` POST whose single `value` body property is `property`. */
const scanOne = ({ property }: { property: unknown }): IrAction => {
  const scanned = scanOpenApiJson({
    source: JSON.stringify({
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
    }),
  });

  return scanned.actions[0] as IrAction;
};

describe('actionFieldExpr array and object rendering (ONT-042 A)', () => {
  it('renders list and object kinds, with .optional() still outermost', () => {
    const cases: { field: IrActionField; expected: string }[] = [
      {
        field: { name: 'a', kind: 'scalar', scalar: 'string', list: true, optional: false },
        expected: 'z.array(z.string())',
      },
      {
        field: { name: 'a', kind: 'scalar', scalar: 'string', list: true, optional: true },
        expected: 'z.array(z.string()).optional()',
      },
      {
        field: {
          name: 'a',
          kind: 'scalar',
          scalar: 'int',
          list: true,
          optional: true,
          constraints: { min: 0 },
        },
        // The bound belongs to the ITEM; the array wrapper goes outside it.
        expected: 'z.array(z.number().int().min(0)).optional()',
      },
      {
        field: { name: 'a', kind: 'enum', enumValues: ['A', 'B'], list: true, optional: false },
        expected: 'z.array(z.enum(["A", "B"]))',
      },
      {
        field: {
          name: 'a',
          kind: 'object',
          fields: [{ name: 'x', kind: 'scalar', scalar: 'string', optional: false }],
          optional: true,
        },
        expected: 'z.object({ "x": z.string() }).optional()',
      },
      {
        field: { name: 'a', kind: 'object', fields: [], optional: false },
        expected: 'z.object({})',
      },
    ];

    for (const { field, expected } of cases) {
      expect(actionFieldExpr({ field })).toBe(expected);
    }
  });

  it('leaves a plain scalar byte-identical — no `list`, no `fields`, no change', () => {
    const field: IrActionField = { name: 'a', kind: 'scalar', scalar: 'string', optional: true };

    expect(actionFieldExpr({ field })).toBe('z.string().optional()');
  });

  it('escapes a nested object key through the one escaping layer', () => {
    const field: IrActionField = {
      name: 'a',
      kind: 'object',
      fields: [
        { name: 'evil"); import(`fs`); //', kind: 'scalar', scalar: 'string', optional: false },
      ],
      optional: false,
    };

    expect(actionFieldExpr({ field })).toBe(
      'z.object({ "evil\\"); import(`fs`); //": z.string() })',
    );
  });

  it('carries the shape into the generated ontology/<action>.mjs', () => {
    const action = scanOne({
      property: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' } } },
      },
    });

    expect(emitActionFile({ action }).content).toContain(
      '"value": z.array(z.object({ "id": z.string().optional() })),',
    );
  });
});

/**
 * AC-7 — the evidence that the structural change stays out of the differ and
 * the MCP advisory schema, asserted rather than argued. ONT-037's finding was
 * that constraints on `IrActionField` are out of the differ's reach BY
 * CONSTRUCTION; these cases re-verify that for a change that alters the node's
 * type, not just its bounds.
 */
describe('the array/object change does not reach the differ or the MCP schema (ONT-042 AC-7)', () => {
  const ARRAY_SPEC = JSON.stringify({
    openapi: '3.0.3',
    paths: {
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['arr', 'obj', 'plain'],
                  properties: {
                    arr: { type: 'array', items: { type: 'string' } },
                    obj: { type: 'object', properties: { deep: { type: 'string' } } },
                    plain: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  it('emits zero IrObjects, which is the whole reason the differ cannot see it', () => {
    // `diffSync` probes `scanned.objects[].fields` (IrField) and matches actions
    // by NAME only. The OpenAPI scanner produces actions and nothing else, so an
    // action-field change has no path into the comparison at all.
    expect(scanOpenApiJson({ source: ARRAY_SPEC }).objects).toEqual([]);
  });

  it('reports no drift for a registry that already holds the action', () => {
    const scanned = scanOpenApiJson({ source: ARRAY_SPEC });
    const registry = createRegistry();

    registry.defineAction({
      name: 'createThing',
      // Deliberately NOT the shape the scan would produce: a name match is all
      // the differ looks at for an action, so even a wildly different input
      // schema must not surface as drift.
      input: z.object({ somethingElse: z.boolean() }),
      execute: notImplemented,
    });

    const diff = diffSync({ scanned, registry });

    expect(diff.newActions).toEqual([]);
    expect(diff.fieldDrifts).toEqual([]);
    expect(diff.newObjects).toEqual([]);
  });

  it('leaves the IrField (object-side) expression and node untouched', () => {
    // The new keys live on `IrActionField` only. The object side, which IS what
    // the differ probes, renders exactly as it did before.
    const field: IrField = {
      name: 'tags',
      kind: 'scalar',
      scalar: 'string',
      optional: false,
      list: true,
      isId: false,
    };

    expect(fieldExpr({ field })).toBe('z.array(z.string())');
    expect(fieldNode({ field }).safeParse(['a']).success).toBe(true);
  });

  it('gives the MCP advisory schema an honest gap instead of a false `type: string`', () => {
    const action = scanOpenApiJson({ source: ARRAY_SPEC }).actions[0] as IrAction;
    const entries = action.input
      .map((field) => `${JSON.stringify(field.name)}: ${actionFieldExpr({ field })}`)
      .join(', ');
    const schema = new Function('z', `return z.object({ ${entries} });`)(z) as z.ZodType;

    const derived = deriveInputSchema({ schema });

    // Before the fix these were `{ type: 'string' }` — the advisory schema
    // repeated the emitter's lie. `deriveInputSchema` leaves a non-primitive
    // unconstrained by design, so the array and the object now say nothing
    // rather than something false, and the primitive sibling is unchanged.
    expect(derived.properties['arr']).toEqual({});
    expect(derived.properties['obj']).toEqual({});
    expect(derived.properties['plain']).toEqual({ type: 'string' });
    expect(derived.type).toBe('object');
  });

  it('produces no governance drift — ONT-043 reads posture, never the input shape', () => {
    // ONT-043's governance differ is a NEW consumer of the live registry, so the
    // AC-7 claim has to hold against it too. `actionPostures` reads approval,
    // roles, where and target and deliberately NOT the input shape, so a field
    // that changes from `z.string()` to `z.array(z.string())` must be invisible.
    const postureFor = ({ input }: { input: z.ZodType }) => {
      const registry = createRegistry();
      registry.defineAction({
        name: 'createThing',
        input,
        policy: { approval: 'required' },
        execute: notImplemented,
      });

      return actionPostures({ registry });
    };

    // The pre-fix emitter's shape, and the shape this PR emits for the same spec.
    const before = postureFor({ input: z.object({ arr: z.string(), plain: z.string() }) });
    const after = postureFor({
      input: z.object({ arr: z.array(z.string()), plain: z.string() }),
    });

    expect(diffGovernance({ baseline: before, current: after })).toEqual([]);
  });
});
