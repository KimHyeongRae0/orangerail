import { describe, expect, it } from 'vitest';

import type { IrAction, IrObject, ScannedSource } from '../ir';
import { emptySource } from '../ir';
import { buildFileSet } from './index';
import { buildResolveDiagnostic, emitObjectFile, wrapResolveError } from './emit-object';
import { emitActionFile } from './emit-action';

const product: IrObject = {
  name: 'Product',
  idField: 'id',
  provenance: 'Prisma model Product',
  relations: [{ field: 'items', target: 'OrderItem', cardinality: 'many' }],
  fields: [
    { name: 'id', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: true },
    { name: 'title', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: false },
    { name: 'price', kind: 'scalar', scalar: 'float', optional: false, list: false, isId: false },
    {
      name: 'status',
      kind: 'enum',
      enumValues: ['DRAFT', 'ACTIVE'],
      optional: false,
      list: false,
      isId: false,
    },
  ],
};

const orderItem: IrObject = {
  name: 'OrderItem',
  idField: 'id',
  relations: [],
  fields: [
    { name: 'id', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: true },
  ],
};

const coupon: IrAction = {
  name: 'grant_import_fs_coupon',
  rawName: "grant'); import(`fs`); /* coupon",
  method: 'POST',
  path: '/coupons',
  write: true,
  description: 'Hostile summary */ terminator',
  input: [{ name: 'customerId', kind: 'scalar', scalar: 'string', optional: false }],
};

const sourceOf = ({
  objects,
  actions,
}: {
  objects: IrObject[];
  actions: IrAction[];
}): ScannedSource => ({
  ...emptySource(),
  objects,
  actions,
});

describe('emitObjectFile', () => {
  it('emits a working resolve and a lazy prisma import (D6)', () => {
    const { content, filename } = emitObjectFile({ object: product });

    expect(filename).toBe('Product.mjs');
    expect(content).toContain('registry.defineObject({');
    expect(content).toContain('name: "Product"');
    expect(content).toContain('z.enum(["DRAFT", "ACTIVE"])');
    expect(content).toContain("await import('@prisma/client')");
    expect(content).toContain('prisma.product.findUnique');
    expect(content).toContain('prisma.product.findMany({ take: 50 })');
    // user-owned: ownership line present, do-not-edit ABSENT (AC-6)
    expect(content).toMatch(/orangerail sync/);
    expect(content).not.toMatch(/do[ -]?not[ -]?edit/i);
  });

  it('wraps the resolve in an actionable no-client diagnostic (AC-3 / I4)', () => {
    const { content } = emitObjectFile({ object: product });

    // The resolve body is guarded and rethrows through the diagnostic wrapper.
    expect(content).toContain('} catch (error) {');
    expect(content).toContain('throw wrapPrismaError(error);');

    // The wrapper branches on both module-resolution error codes and, when
    // matched, throws a diagnostic naming the object + the exact fix commands.
    expect(content).toContain('ERR_MODULE_NOT_FOUND');
    expect(content).toContain('MODULE_NOT_FOUND');
    expect(content).toContain('object \\"Product\\"');
    expect(content).toContain('@prisma/client');
    expect(content).toContain('npx prisma generate');
    expect(content).toContain('DATABASE_URL');
    expect(content).toContain('Original error');
  });
});

describe('wrapResolveError (I4 — resolve-time diagnostic logic)', () => {
  it('rethrows a module-resolution failure as the actionable diagnostic with the original detail', () => {
    const raw = Object.assign(new Error("Cannot find module '.prisma/client/default'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });

    const wrapped = wrapResolveError({ objectName: 'Post', error: raw }) as Error;

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).not.toBe(raw);
    for (const needle of ['Post', '@prisma/client', 'prisma generate', 'DATABASE_URL']) {
      expect(wrapped.message).toContain(needle);
    }
    // The raw module error is preserved as a detail, not the headline.
    expect(wrapped.message).toContain("Cannot find module '.prisma/client/default'");
  });

  it('also matches the CJS MODULE_NOT_FOUND code', () => {
    const raw = Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' });
    const wrapped = wrapResolveError({ objectName: 'Post', error: raw }) as Error;

    expect(wrapped.message).toContain(buildResolveDiagnostic({ objectName: 'Post' }));
  });

  it('rethrows a non-module error untouched (never masks a real runtime failure)', () => {
    const raw = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(wrapResolveError({ objectName: 'Post', error: raw })).toBe(raw);
  });
});

describe('emitActionFile', () => {
  it('emits approval:required + notImplemented and keeps hostile raw as inert data', () => {
    const { content } = emitActionFile({ action: coupon });

    expect(content).toContain('name: "grant_import_fs_coupon"');
    expect(content).toMatch(/approval:\s*'required'/);
    expect(content).toContain('execute: notImplemented');
    // hostile original kept only in a comment, terminator neutralized
    expect(content).not.toContain('*/ end');
    expect(content.split('\n').filter((l) => l.includes('*/')).length).toBe(1); // only the JSDoc close
  });

  it('emits a legal JS binding when the MCP-safe name contains hyphens', () => {
    // Real-world case: GitHub-style operationIds like
    // `actions/create-workflow-dispatch` sanitize to a hyphenated MCP name,
    // which is charset-legal for tools but not a valid JS identifier.
    const dispatch: IrAction = {
      ...coupon,
      name: 'actions_create-workflow-dispatch',
      rawName: 'actions/create-workflow-dispatch',
    };

    const { content, filename } = emitActionFile({ action: dispatch });
    const exported = content.match(/export const (\S+) =/)?.[1];

    expect(exported).toBe('actions_create_workflow_dispatch');
    expect(exported).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    // The registry/MCP tool name keeps the hyphenated form (a legal MCP name),
    // but the filename stem is re-sanitized at the sink (ONT-015, AC-4) so it
    // agrees with the export binding by an identical rule.
    expect(content).toContain('name: "actions_create-workflow-dispatch"');
    expect(filename).toBe('actions_create_workflow_dispatch.mjs');
  });
});

describe('buildFileSet', () => {
  it('is byte-deterministic across two renders (AC-9)', () => {
    const source = sourceOf({ objects: [product, orderItem], actions: [coupon] });

    const a = buildFileSet({ source, preset: 'approval-for-writes' });
    const b = buildFileSet({ source, preset: 'approval-for-writes' });

    expect(a).toEqual(b);
  });

  it('emits config + registry + one link + object + action files', () => {
    const source = sourceOf({ objects: [product, orderItem], actions: [coupon] });
    const paths = buildFileSet({ source, preset: 'approval-for-writes' })
      .map((f) => f.path)
      .sort();

    expect(paths).toContain('orangerail.config.mjs');
    expect(paths).toContain('ontology/_registry.mjs');
    expect(paths).toContain('ontology/_links.mjs');
    expect(paths).toContain('ontology/Product.mjs');
    expect(paths).toContain('ontology/grant_import_fs_coupon.mjs');
  });
});
