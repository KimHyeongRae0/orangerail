import { describe, expect, it } from 'vitest';

import { parsePrismaSchema } from './parse';

describe('parsePrismaSchema', () => {
  it('parses models, fields, and type modifiers', () => {
    const parsed = parsePrismaSchema({
      source: `
        model Product {
          id     String   @id @default(cuid())
          title  String
          price  Float
          items  OrderItem[]
          note   String?
        }
      `,
    });

    expect(parsed.models).toHaveLength(1);
    const product = parsed.models[0];
    expect(product?.name).toBe('Product');

    const byName = new Map(product?.fields.map((f) => [f.name, f]));
    expect(byName.get('id')?.type).toBe('String');
    expect(byName.get('items')?.type).toBe('OrderItem');
    expect(byName.get('items')?.list).toBe(true);
    expect(byName.get('note')?.optional).toBe(true);
    expect(byName.get('price')?.list).toBe(false);
  });

  it('parses enum blocks in declared order', () => {
    const parsed = parsePrismaSchema({
      source: `enum ProductStatus { DRAFT\nACTIVE\nARCHIVED }`,
    });

    expect(parsed.enums).toEqual([
      { name: 'ProductStatus', values: ['DRAFT', 'ACTIVE', 'ARCHIVED'] },
    ]);
  });

  it('flags Unsupported(...) fields without crashing', () => {
    const parsed = parsePrismaSchema({
      source: `model Geo { id String @id\n area Unsupported("polygon")? }`,
    });

    const area = parsed.models[0]?.fields.find((f) => f.name === 'area');
    expect(area?.unsupported).toBe(true);
    expect(area?.optional).toBe(true);
  });

  it('keeps hostile strings in @map / @default / @@map inert (AC-9)', () => {
    const parsed = parsePrismaSchema({
      source: `
        model AuditNote {
          id     String @id @default(cuid())
          body   String @default("she said \\"hi\\" — \`tick\` */ end")
          legacy String @map("weird \\"column\\" */ name")
          @@map("audit */ \`notes\`")
        }
      `,
    });

    const fields = parsed.models[0]?.fields.map((f) => f.name);
    // The hostile string content never derails field parsing; @@map is ignored.
    expect(fields).toEqual(['id', 'body', 'legacy']);
  });

  it('records view block names in declared order without parsing their bodies', () => {
    const parsed = parsePrismaSchema({
      source: `
        view UserStats {
          id        Int @id
          postCount Int
        }
        view PostStats {
          id    Int @id
          views Int
        }
      `,
    });

    expect(parsed.views).toEqual(['UserStats', 'PostStats']);
    // Views are read models, not scanned into objects in v0.
    expect(parsed.models).toHaveLength(0);
  });

  it('keeps hostile strings/braces inside a view body inert and still parses later models', () => {
    const parsed = parsePrismaSchema({
      source: `
        view UserStats {
          id    Int    @id
          label String @map("stats */ \`drop\` \\"table\\" { }")
        }
        model Post {
          id    String @id @default(cuid())
          title String
        }
      `,
    });

    expect(parsed.views).toEqual(['UserStats']);
    // A model declared after a view still parses (the view body never leaked).
    expect(parsed.models.map((m) => m.name)).toEqual(['Post']);
    expect(parsed.models[0]?.fields.map((f) => f.name)).toEqual(['id', 'title']);
  });

  it('strips // comments but not string content with slashes', () => {
    const parsed = parsePrismaSchema({
      source: `
        // a leading comment
        model A {
          id String @id // trailing comment
          url String @default("http://example.com")
        }
      `,
    });

    const url = parsed.models[0]?.fields.find((f) => f.name === 'url');
    expect(url?.type).toBe('String');
    expect(parsed.models[0]?.fields.map((f) => f.name)).toEqual(['id', 'url']);
  });
});
