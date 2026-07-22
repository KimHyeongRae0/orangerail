import { describe, expect, it } from 'vitest';

import type { IrAction, IrObject, ScannedSource } from '../ir';
import { emptySource } from '../ir';
import { buildFileSet } from './index';
import { emitObjectFile } from './emit-object';
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
