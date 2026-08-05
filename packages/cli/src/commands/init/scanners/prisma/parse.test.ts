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

/**
 * ONT-042 F — a block header the grammar could not match was skipped with zero
 * diagnostics: three models next to one valid one reported "1 object(s)" and
 * said nothing about the other three. Prisma rejects those names too, so the
 * skip is correct; the silence was the defect.
 */
describe('parsePrismaSchema invalid block headers (ONT-042 F)', () => {
  const SCHEMA = `
    model Über {
      id String @id
    }
    model 2Fast {
      id String @id
    }
    model Do$llar {
      id String @id
    }
    model OK {
      id String @id
    }
  `;

  it('records every header whose name is not a valid Prisma identifier', () => {
    const parsed = parsePrismaSchema({ source: SCHEMA });

    expect(parsed.invalidBlocks).toEqual(['model Über', 'model 2Fast', 'model Do$llar']);
  });

  it('still parses the valid model, and only the valid model', () => {
    const parsed = parsePrismaSchema({ source: SCHEMA });

    expect(parsed.models.map((m) => m.name)).toEqual(['OK']);
  });

  it('consumes an invalid block body so nothing inside it leaks into the scan', () => {
    const parsed = parsePrismaSchema({
      source: `
        model Bad-Name {
          nested String @id
          enum Leaked {
            A
          }
        }
        model Good {
          id String @id
        }
      `,
    });

    expect(parsed.models.map((m) => m.name)).toEqual(['Good']);
    expect(parsed.enums).toHaveLength(0);
    expect(parsed.invalidBlocks).toEqual(['model Bad-Name']);
  });

  it('reports nothing for a schema whose block names are all valid', () => {
    const parsed = parsePrismaSchema({
      source: `model OK { id String @id }\nenum Role { \n ADMIN \n }`,
    });

    expect(parsed.invalidBlocks).toEqual([]);
  });
});

describe('datasource parsing (ONT-049)', () => {
  it('reads the provider and the connection-URL variable', () => {
    const parsed = parsePrismaSchema({
      source: `
        datasource db {
          provider = "postgresql"
          url      = env("PG_URL")
        }
        model Article { id Int @id }
      `,
    });

    expect(parsed.datasource).toEqual({ provider: 'postgresql', urlEnv: 'PG_URL' });
  });

  it('reads a Prisma 7 datasource, which declares no url at all', () => {
    // Prisma 7 rejects `url` in the schema (P1012); it lives in prisma.config.ts.
    const parsed = parsePrismaSchema({
      source: `datasource db {\n  provider = "sqlite"\n}\nmodel A { id Int @id }`,
    });

    expect(parsed.datasource).toEqual({ provider: 'sqlite' });
  });

  it('names no variable when the url is a literal rather than an env lookup', () => {
    const parsed = parsePrismaSchema({
      source: `datasource db {\n  provider = "sqlite"\n  url = "file:./dev.db"\n}`,
    });

    expect(parsed.datasource).toEqual({ provider: 'sqlite' });
  });

  it('is absent for a schema with no datasource block', () => {
    const parsed = parsePrismaSchema({ source: `model A { id Int @id }` });

    expect(parsed.datasource).toBeUndefined();
  });

  it('does not confuse the generator block for the datasource', () => {
    // Both blocks carry a `provider` key; the generator's is `prisma-client-js`,
    // which maps to no adapter at all.
    const parsed = parsePrismaSchema({
      source: `
        generator client {
          provider = "prisma-client-js"
        }
        datasource db {
          provider = "mysql"
          url      = env("DATABASE_URL")
        }
      `,
    });

    expect(parsed.datasource).toEqual({ provider: 'mysql', urlEnv: 'DATABASE_URL' });
  });
});

describe('generator parsing (ONT-067)', () => {
  it('reads the provider and output of the block `prisma init` writes', () => {
    const parsed = parsePrismaSchema({
      source: `
        generator client {
          provider = "prisma-client"
          output   = "../generated/prisma"
        }
        model A { id Int @id }
      `,
    });

    expect(parsed.generator).toEqual({
      provider: 'prisma-client',
      output: '../generated/prisma',
    });
  });

  it('reads the legacy generator, which declares no output', () => {
    const parsed = parsePrismaSchema({
      source: `generator client {\n  provider = "prisma-client-js"\n}`,
    });

    expect(parsed.generator).toEqual({ provider: 'prisma-client-js' });
  });

  it('is absent for a schema with no generator block', () => {
    const parsed = parsePrismaSchema({ source: `model A { id Int @id }` });

    expect(parsed.generator).toBeUndefined();
  });

  it('ignores a generator that does not produce a client', () => {
    // Prisma allows several generator blocks. An ERD renderer's `output` is a
    // diagram directory — reading it as the client's would send the emitted
    // import at a PNG.
    const parsed = parsePrismaSchema({
      source: `
        generator erd {
          provider = "prisma-erd-generator"
          output   = "../docs/erd.svg"
        }
        generator client {
          provider = "prisma-client"
          output   = "../generated/prisma"
        }
      `,
    });

    expect(parsed.generator).toEqual({
      provider: 'prisma-client',
      output: '../generated/prisma',
    });
  });

  it('keeps the first client generator when a second one follows', () => {
    const parsed = parsePrismaSchema({
      source: `
        generator client {
          provider = "prisma-client"
          output   = "../generated/prisma"
        }
        generator browser {
          provider = "prisma-client"
          output   = "../generated/browser"
        }
      `,
    });

    expect(parsed.generator?.output).toBe('../generated/prisma');
  });

  it('records an env() output as an expression rather than a path', () => {
    const parsed = parsePrismaSchema({
      source: `generator client {\n  provider = "prisma-client"\n  output = env("GEN_OUT")\n}`,
    });

    expect(parsed.generator).toEqual({
      provider: 'prisma-client',
      outputExpression: 'env("GEN_OUT")',
    });
  });

  it('records an interpolated output as an expression rather than a path', () => {
    const parsed = parsePrismaSchema({
      source: `generator client {\n  provider = "prisma-client"\n  output = "\${ROOT}/client"\n}`,
    });

    expect(parsed.generator?.output).toBeUndefined();
    expect(parsed.generator?.outputExpression).toBe('"${ROOT}/client"');
  });

  it('carries a malformed generator block into invalidBlocks instead of throwing', () => {
    const parsed = parsePrismaSchema({
      source: `
        generator Über {
          provider = "prisma-client"
          output   = "../generated/prisma"
        }
        model A { id Int @id }
      `,
    });

    expect(parsed.invalidBlocks).toEqual(['generator Über']);
    expect(parsed.generator).toBeUndefined();
    expect(parsed.models.map((m) => m.name)).toEqual(['A']);
  });

  it('ignores a generator body that names no provider', () => {
    const parsed = parsePrismaSchema({
      source: `generator client {\n  output = "../generated/prisma"\n}\nmodel A { id Int @id }`,
    });

    expect(parsed.generator).toBeUndefined();
  });

  it('records a model carrying `@@ignore` by name and keeps it out of models (ONT-113)', () => {
    const parsed = parsePrismaSchema({
      source: `
        model events {
          id BigInt @default(autoincrement())

          @@ignore
        }
        model users { id Int @id }
      `,
    });

    expect(parsed.ignoredModels).toEqual(['events']);
    expect(parsed.models.map((m) => m.name)).toEqual(['users']);
  });

  it('leaves every other block attribute skipped, exactly as before (ONT-113)', () => {
    const parsed = parsePrismaSchema({
      source: `
        model Order {
          id     Int @id
          userId Int

          @@map("orders")
          @@unique([userId])
          @@index([userId])
          @@id([id, userId])
        }
      `,
    });

    expect(parsed.ignoredModels).toEqual([]);
    expect(parsed.models.map((m) => m.name)).toEqual(['Order']);
  });

  it('does not read `@@ignoreCase` as `@@ignore` (ONT-113)', () => {
    const parsed = parsePrismaSchema({
      source: `model A {\n  id Int @id\n\n  @@ignoreCase\n}`,
    });

    expect(parsed.ignoredModels).toEqual([]);
    expect(parsed.models.map((m) => m.name)).toEqual(['A']);
  });

  it('reads `@@ignore` through a trailing comment, which is stripped upstream (ONT-113)', () => {
    const parsed = parsePrismaSchema({
      source: `model A {\n  id Int @default(1)\n\n  @@ignore // added by db pull\n}`,
    });

    expect(parsed.ignoredModels).toEqual(['A']);
    expect(parsed.models).toEqual([]);
  });

  it('accepts a model literally named `ignore` (ONT-113)', () => {
    const parsed = parsePrismaSchema({ source: `model ignore { id Int @id }` });

    expect(parsed.ignoredModels).toEqual([]);
    expect(parsed.models.map((m) => m.name)).toEqual(['ignore']);
  });
});
