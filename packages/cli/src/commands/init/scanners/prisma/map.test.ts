import { describe, expect, it } from 'vitest';

import { mapPrismaToIr } from './map';
import { parsePrismaSchema } from './parse';

const scan = ({ source }: { source: string }) =>
  mapPrismaToIr({ parsed: parsePrismaSchema({ source }) });

describe('mapPrismaToIr', () => {
  it('classifies scalars, enums, relations, and id fields', () => {
    const source = scan({
      source: `
        model Product {
          id     String        @id @default(cuid())
          title  String
          status ProductStatus @default(DRAFT)
          items  OrderItem[]
        }
        model OrderItem {
          id        String  @id
          product   Product @relation(fields: [productId], references: [id])
          productId String
          quantity  Int
        }
        enum ProductStatus {
          DRAFT
          ACTIVE
          ARCHIVED
        }
      `,
    });

    const product = source.objects.find((o) => o.name === 'Product');
    expect(product?.idField).toBe('id');

    const status = product?.fields.find((f) => f.name === 'status');
    expect(status?.kind).toBe('enum');
    expect(status?.enumValues).toEqual(['DRAFT', 'ACTIVE', 'ARCHIVED']);

    // `items` is a relation, not a zod field.
    expect(product?.fields.find((f) => f.name === 'items')).toBeUndefined();
    expect(product?.relations).toEqual([
      { field: 'items', target: 'OrderItem', cardinality: 'many' },
    ]);

    const orderItem = source.objects.find((o) => o.name === 'OrderItem');
    // The FK scalar `productId` stays a field; the `product` relation does not.
    expect(orderItem?.fields.map((f) => f.name).sort()).toEqual(['id', 'productId', 'quantity']);
    expect(orderItem?.fields.find((f) => f.name === 'quantity')?.scalar).toBe('int');
  });

  it('skips Unsupported fields with a warning but keeps the model', () => {
    const source = scan({
      source: `model Geo { id String @id\n area Unsupported("polygon")? }`,
    });

    const geo = source.objects.find((o) => o.name === 'Geo');
    expect(geo).toBeDefined();
    expect(geo?.fields.map((f) => f.name)).toEqual(['id']);
    expect(source.warnings.some((w) => /Unsupported/.test(w) && /Geo\.area/.test(w))).toBe(true);
  });

  it('maps Float to float and Decimal to decimal (distinct for drift)', () => {
    const source = scan({
      source: `model M { id String @id\n a Float\n b Decimal }`,
    });

    const m = source.objects[0];
    expect(m?.fields.find((f) => f.name === 'a')?.scalar).toBe('float');
    expect(m?.fields.find((f) => f.name === 'b')?.scalar).toBe('decimal');
  });
});
