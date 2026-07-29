import { describe, expect, it } from 'vitest';

import type { IrField, IrObject } from '../../ir';
import { synthesizePrismaActions } from './actions';

const field = ({
  name,
  scalar = 'string',
  optional = false,
  list = false,
  isId = false,
  hasDefault = false,
  updatedAt = false,
}: {
  name: string;
  scalar?: IrField['scalar'];
  optional?: boolean;
  list?: boolean;
  isId?: boolean;
  hasDefault?: boolean;
  updatedAt?: boolean;
}): IrField => ({ name, kind: 'scalar', scalar, optional, list, isId, hasDefault, updatedAt });

const note: IrObject = {
  name: 'Note',
  idField: 'id',
  relations: [],
  fields: [
    field({ name: 'id', scalar: 'int', isId: true, hasDefault: true }),
    field({ name: 'title' }),
    field({ name: 'body' }),
    field({ name: 'done', scalar: 'boolean', hasDefault: true }),
    field({ name: 'tags', list: true }),
    field({ name: 'updatedAt', scalar: 'datetime', updatedAt: true }),
  ],
};

const inputNames = (fields: { name: string }[]): string[] => fields.map((f) => f.name);
const optionalOf = (fields: { name: string; optional: boolean }[]): Record<string, boolean> =>
  Object.fromEntries(fields.map((f) => [f.name, f.optional]));

describe('synthesizePrismaActions', () => {
  it('emits create/update/delete for a model with a single @id, in a fixed order', () => {
    const warnings: string[] = [];
    const actions = synthesizePrismaActions({ objects: [note], warnings });

    expect(actions.map((a) => a.name)).toEqual(['createNote', 'updateNote', 'deleteNote']);
    expect(actions.every((a) => a.source === 'prisma')).toBe(true);
    expect(actions.every((a) => a.write)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('excludes list fields and @updatedAt from every write input (D1)', () => {
    const [create, update] = synthesizePrismaActions({ objects: [note], warnings: [] });

    for (const action of [create!, update!]) {
      expect(inputNames(action.input)).not.toContain('tags');
      expect(inputNames(action.input)).not.toContain('updatedAt');
    }
  });

  it('create marks a field optional iff it is Prisma-optional or has @default', () => {
    const [create] = synthesizePrismaActions({ objects: [note], warnings: [] });
    const opt = optionalOf(create!.input);

    expect(opt).toEqual({
      id: true, // @default(autoincrement)
      title: false, // required, no default
      body: false,
      done: true, // @default(false)
    });
  });

  it('update requires the id and forces every other writable field optional', () => {
    const [, update] = synthesizePrismaActions({ objects: [note], warnings: [] });
    const opt = optionalOf(update!.input);

    expect(opt.id).toBe(false);
    expect(opt.title).toBe(true);
    expect(opt.body).toBe(true);
    expect(opt.done).toBe(true);
    expect(update!.prisma).toEqual({
      model: 'Note',
      sourceModel: 'Note',
      op: 'update',
      idField: 'id',
    });
  });

  it('delete carries only the required identifier', () => {
    const [, , del] = synthesizePrismaActions({ objects: [note], warnings: [] });

    expect(inputNames(del!.input)).toEqual(['id']);
    expect(del!.input[0]!.optional).toBe(false);
    expect(del!.prisma).toEqual({
      model: 'Note',
      sourceModel: 'Note',
      op: 'delete',
      idField: 'id',
    });
  });

  it('a model with no single @id gets create only, with a surfaced warning (D2)', () => {
    const keyless: IrObject = {
      name: 'Reading',
      relations: [],
      fields: [field({ name: 'sensor' }), field({ name: 'value', scalar: 'float' })],
    };
    const warnings: string[] = [];
    const actions = synthesizePrismaActions({ objects: [keyless], warnings });

    expect(actions.map((a) => a.name)).toEqual(['createReading']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("model 'Reading' has no single @id");
  });

  it('is a pure function — same models synthesize identical actions twice', () => {
    const a = synthesizePrismaActions({ objects: [note], warnings: [] });
    const b = synthesizePrismaActions({ objects: [note], warnings: [] });
    expect(a).toEqual(b);
  });
});
