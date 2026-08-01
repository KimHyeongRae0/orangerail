import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRegistry, DECIMAL_INTEGER_SOURCE, typeNameOf } from 'orangerail-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { IrField, IrObject, IrScalar } from '../ir';
import { emptySource } from '../ir';
import { diffSync } from '../../sync/diff';
import { emitObjectFile } from './emit-object';
import { fieldExpr, fieldNode } from './zod';

/**
 * ONT-068 — a `BigInt` column travels as a decimal string, from the emitted zod
 * node through the generated resolver.
 *
 * RED against `752ff7b`: `zod.ts` mapped `bigint` to `z.bigint()`, which no JSON
 * value satisfies, so `update` and `delete` were uncallable on a `BigInt` key
 * and the emitted resolver handed Prisma the id unchecked and returned rows
 * carrying JS BigInts that `JSON.stringify` refuses.
 */

const scalarField = ({
  name,
  scalar,
  isId = false,
}: {
  name: string;
  scalar: IrScalar;
  isId?: boolean;
}): IrField => ({ name, kind: 'scalar', scalar, optional: false, list: false, isId });

/** Rails/Laravel shape: a `BigInt` primary key. */
const signed: IrObject = {
  name: 'Signed',
  idField: 'id',
  relations: [],
  fields: [
    scalarField({ name: 'id', scalar: 'bigint', isId: true }),
    scalarField({ name: 'name', scalar: 'string' }),
  ],
};

/** An `Int` primary key whose model still carries a `BigInt` foreign key. */
const fk: IrObject = {
  name: 'Fk',
  idField: 'id',
  relations: [],
  fields: [
    scalarField({ name: 'id', scalar: 'int', isId: true }),
    scalarField({ name: 'signedId', scalar: 'bigint' }),
    scalarField({ name: 'label', scalar: 'string' }),
  ],
};

/** No `BigInt` anywhere — the byte-identity control. */
const plain: IrObject = {
  name: 'Plain',
  idField: 'id',
  relations: [],
  fields: [
    scalarField({ name: 'id', scalar: 'int', isId: true }),
    scalarField({ name: 'label', scalar: 'string' }),
  ],
};

describe('the emitted zod node for a BigInt column', () => {
  it('is a decimal string, in the expression and in the node the differ builds', () => {
    const field = scalarField({ name: 'id', scalar: 'bigint' });

    expect(fieldExpr({ field })).toBe('z.string().regex(new RegExp("^-?\\\\d+$"))');
    expect(typeNameOf({ node: fieldNode({ field }) })).toBe('string');
    expect(fieldNode({ field }).safeParse('9007199254740993').success).toBe(true);
  });

  it('refuses at the gate what would otherwise be a driver throw (section 4)', () => {
    const node = fieldNode({ field: scalarField({ name: 'id', scalar: 'bigint' }) });

    for (const value of ['not-a-number', '', '1.5', '0x10', ' 1']) {
      expect(node.safeParse(value).success).toBe(false);
    }
    // A number never satisfies it either, so no `update`/`delete` can be reached
    // with an id `JSON.parse` has already rounded.
    expect(node.safeParse(9007199254740993).success).toBe(false);
    expect(node.safeParse(9007199254740993n).success).toBe(false);
  });

  it('accepts a negative id, "-0" and leading zeros', () => {
    const node = fieldNode({ field: scalarField({ name: 'id', scalar: 'bigint' }) });

    for (const value of ['-1', '-0', '007', '0']) {
      expect(node.safeParse(value).success).toBe(true);
    }
  });

  it('reports no drift against a registry built from the emitted expression (AC-7)', () => {
    // `zod.ts` is the single source of truth for both sides; the hand-patched
    // ontology that carried ids as strings failed exactly here, forever.
    const registry = createRegistry();

    registry.defineObject({
      name: 'Signed',
      schema: z.object({
        id: z.string().regex(new RegExp(DECIMAL_INTEGER_SOURCE)),
        name: z.string(),
      }),
      resolve: { get: async () => null },
    });

    const diff = diffSync({ scanned: { ...emptySource(), objects: [signed] }, registry });

    expect(diff.fieldDrifts).toEqual([]);
    expect(diff.newObjects).toEqual([]);
  });
});

describe('the generated resolver for a BigInt key', () => {
  const content = emitObjectFile({ object: signed }).content;

  it('hands Prisma the decimal string, never a Number', () => {
    expect(content).toContain('findUnique({ where: { "id": id } })');
    expect(content).not.toContain('Number(id)');
    expect(content).not.toContain('Number(cursor)');
    expect(content).toContain('cursor: { "id": cursor }');
  });

  it('turns a malformed id into the not-found path and a malformed cursor into an empty page', () => {
    expect(content).toContain('if (!DECIMAL_ID.test(id)) {\n          return null;');
    expect(content).toContain(
      'if (cursor !== undefined && !DECIMAL_ID.test(cursor)) {\n          return { items: [] };',
    );
  });

  it('renders rows, and keeps the await inside the try block (ONT-045)', () => {
    expect(content).toContain('return renderBigInts(await prisma.signed.findUnique(');
    expect(content).toContain('const items = renderBigInts(hasMore ? rows.slice(0, take) : rows);');
  });
});

describe('a BigInt foreign key on an Int-keyed model (AC-5)', () => {
  const content = emitObjectFile({ object: fk }).content;

  it('renders rows even though the key itself is numeric', () => {
    // One `BigInt` column is enough to make every row of this model
    // unserializable, which is what took the model out of service.
    expect(content).toContain('const key = Number(id);');
    expect(content).toContain('return renderBigInts(await prisma.fk.findUnique(');
    expect(content).not.toContain('DECIMAL_ID');
  });
});

describe('a schema with no BigInt column (AC-6)', () => {
  it('emits none of the helpers, so its bytes cannot move', () => {
    const content = emitObjectFile({ object: plain }).content;

    expect(content).not.toContain('renderBigInts');
    expect(content).not.toContain('DECIMAL_ID');
    expect(content).toContain('return await prisma.plain.findUnique({ where: { "id": key } });');
    expect(content).toContain('const items = hasMore ? rows.slice(0, take) : rows;');
  });
});

describe('the emitted helpers, executed', () => {
  it('render nested and array BigInts and match the ids the gate accepts', async () => {
    const content = emitObjectFile({ object: signed }).content;
    const start = content.indexOf('/** The wire form');
    const end = content.indexOf('\nexport const ');
    const helpers = content.slice(start, end);

    const dir = mkdtempSync(join(tmpdir(), 'ont-068-helpers-'));
    const file = join(dir, 'helpers.mjs');

    writeFileSync(file, `${helpers}\nexport { DECIMAL_ID, renderBigInts };\n`, 'utf8');

    const loaded = (await import(pathToFileURL(file).href)) as {
      DECIMAL_ID: RegExp;
      renderBigInts: (value: unknown) => unknown;
    };

    expect(
      loaded.renderBigInts({ id: 9007199254740993n, meta: { refs: [1n, { deep: 2n }] } }),
    ).toEqual({ id: '9007199254740993', meta: { refs: ['1', { deep: '2' }] } });

    const createdAt = new Date('2026-08-02T00:00:00.000Z');
    expect((loaded.renderBigInts({ createdAt }) as { createdAt: Date }).createdAt).toBe(createdAt);

    expect(loaded.DECIMAL_ID.test('9007199254740993')).toBe(true);
    expect(loaded.DECIMAL_ID.test('-1')).toBe(true);
    for (const value of ['not-a-number', '', '1.5', '0x10', ' 1']) {
      expect(loaded.DECIMAL_ID.test(value)).toBe(false);
    }

    rmSync(dir, { recursive: true, force: true });
  });
});
