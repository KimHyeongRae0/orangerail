import { describe, expect, it } from 'vitest';

import { buildFileSet } from './codegen';
import type { IrAction, IrObject, ScannedSource } from './ir';
import { emptySource } from './ir';
import { applyFilters, assertSelection, SOURCE_NAMES, unaccountedModels } from './select';
import type { ResolvedInit } from './wizard';

const objectNamed = ({ name }: { name: string }): IrObject => ({
  name,
  sourceModel: name,
  fields: [
    { name: 'id', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: true },
  ],
  relations: [],
  idField: 'id',
});

const crudFor = ({ name }: { name: string }): IrAction[] =>
  (['create', 'update', 'delete'] as const).map((op) => ({
    name: `${op}${name}`,
    source: 'prisma' as const,
    prisma: { model: name, sourceModel: name, op, idField: 'id' },
    write: true,
    input: [{ name: 'id', kind: 'scalar' as const, scalar: 'string' as const, optional: false }],
  }));

const httpAction: IrAction = {
  name: 'placeOrder',
  source: 'openapi',
  method: 'POST',
  path: '/orders',
  write: true,
  input: [],
};

/** A two-model Prisma repo that also has one OpenAPI operation. */
const twoModels = (): ScannedSource => ({
  ...emptySource(),
  objects: [objectNamed({ name: 'A' }), objectNamed({ name: 'B' })],
  actions: [...crudFor({ name: 'A' }), ...crudFor({ name: 'B' }), httpAction],
});

const optionsOf = ({
  sources,
  models,
  exclude,
}: {
  sources?: string[];
  models?: string[];
  exclude?: string[];
}): ResolvedInit => ({
  preset: 'approval-for-writes',
  gate: 'all',
  ...(sources === undefined ? {} : { sources }),
  ...(models === undefined ? {} : { models }),
  ...(exclude === undefined ? {} : { exclude }),
  docs: false,
  studio: false,
  open: false,
});

/**
 * Every `./<stem>.mjs` a generated file imports. A stem with no file behind it
 * is the orphan signature — the project dies at load with `Cannot find module`.
 */
const danglingImports = ({ source }: { source: ScannedSource }): string[] => {
  const files = buildFileSet({ source, preset: 'approval-for-writes', gate: 'all' });
  const written = new Set(files.map((file) => file.path));

  return files.flatMap((file) => {
    const dir = file.path.includes('/') ? `${file.path.slice(0, file.path.lastIndexOf('/'))}/` : '';

    return [...file.content.matchAll(/from '\.\/([^']+)'/g)]
      .map((match) => `${dir}${match[1]}`)
      .filter((target) => !written.has(target));
  });
};

describe('applyFilters — a filtered-out object takes its actions with it (ONT-041 defect B)', () => {
  it('drops the actions of a model --models excluded', () => {
    // The published CLI filtered `objects` and passed `actions` straight
    // through, so `--models=A` wrote createB/updateB/deleteB whose files import
    // `./B.mjs` — a file the run never writes. `--models` was therefore broken
    // for EVERY schema with 2+ models.
    const filtered = applyFilters({
      source: twoModels(),
      options: optionsOf({ models: ['A'] }),
    });

    expect(filtered.objects.map((o) => o.name)).toEqual(['A']);
    expect(filtered.actions.map((a) => a.name).sort()).toEqual([
      'createA',
      'deleteA',
      'placeOrder',
      'updateA',
    ]);
    expect(danglingImports({ source: filtered })).toEqual([]);
  });

  it('reports an honest object/action count for a --models run', () => {
    // "1 object(s), 6 action(s)" was the tell that the counts came from two
    // different sources.
    const filtered = applyFilters({
      source: { ...twoModels(), actions: [...crudFor({ name: 'A' }), ...crudFor({ name: 'B' })] },
      options: optionsOf({ models: ['A'] }),
    });

    expect(filtered.objects).toHaveLength(1);
    expect(filtered.actions).toHaveLength(3);
  });

  it('drops Prisma CRUD actions when --sources excludes the Prisma scanner', () => {
    // `--sources=openapi` on a Prisma repo reproduced the orphan identically:
    // zero objects, but every Prisma CRUD action still emitted.
    const filtered = applyFilters({
      source: twoModels(),
      options: optionsOf({ sources: ['openapi'] }),
    });

    expect(filtered.objects).toEqual([]);
    expect(filtered.actions.map((a) => a.name)).toEqual(['placeOrder']);
    expect(danglingImports({ source: filtered })).toEqual([]);
  });

  it('keeps the Prisma CRUD actions when --sources selects the Prisma scanner', () => {
    // An action is gated by the scanner that produced IT. Gating every action on
    // `openapi` silently dropped the CRUD writes `--sources=prisma` asked for.
    const filtered = applyFilters({
      source: twoModels(),
      options: optionsOf({ sources: ['prisma'] }),
    });

    expect(filtered.objects.map((o) => o.name)).toEqual(['A', 'B']);
    expect(filtered.actions.every((a) => a.source === 'prisma')).toBe(true);
    expect(filtered.actions).toHaveLength(6);
    expect(danglingImports({ source: filtered })).toEqual([]);
  });

  it('is a no-op with no selection at all', () => {
    const source = twoModels();

    expect(applyFilters({ source, options: optionsOf({}) })).toEqual(source);
  });
});

describe('assertSelection — garbage fails loudly like --preset does (ONT-041 defect E)', () => {
  it('refuses a --sources value that is not a known scanner, naming the valid set', () => {
    expect(() =>
      assertSelection({ source: twoModels(), options: optionsOf({ sources: ['nonsense'] }) }),
    ).toThrow(/unknown source "nonsense" — expected one of prisma, openapi/);
  });

  it('refuses a --models value that matches nothing, naming what the repo has', () => {
    expect(() =>
      assertSelection({ source: twoModels(), options: optionsOf({ models: ['Typo'] }) }),
    ).toThrow(/unknown model "Typo" — expected one of A, B/);
  });

  it('names every offending value, not just the first', () => {
    expect(() =>
      assertSelection({ source: twoModels(), options: optionsOf({ models: ['Typo', 'Nope'] }) }),
    ).toThrow(/"Typo", "Nope"/);
  });

  it('accepts a selection that matches, and an absent selection', () => {
    const source = twoModels();

    expect(() =>
      assertSelection({ source, options: optionsOf({ sources: SOURCE_NAMES, models: ['A'] }) }),
    ).not.toThrow();
    expect(() => assertSelection({ source, options: optionsOf({}) })).not.toThrow();
  });
});

/**
 * `--exclude` (ONT-059). The tests below are about the two things that separate
 * a recorded refusal from a filter: it has to be TRUE when it is written (so an
 * unknown or self-contradicting name is refused before a byte is written), and
 * it must never be inferred from an allow-list.
 */
describe('--exclude — the deny-list front door (ONT-059)', () => {
  it('refuses an unknown name, naming it and the scanned set, before anything is written', () => {
    expect(() =>
      assertSelection({ source: twoModels(), options: optionsOf({ exclude: ['Typo'] }) }),
    ).toThrow(/unknown model "Typo" in --exclude — expected one of A, B/);
  });

  it('refuses a name given to both --models and --exclude instead of picking a winner', () => {
    expect(() =>
      assertSelection({
        source: twoModels(),
        options: optionsOf({ models: ['A'], exclude: ['A'] }),
      }),
    ).toThrow(/"A" appears in both --models and --exclude/);
  });

  it('refuses an --exclude that would leave nothing to govern', () => {
    expect(() =>
      assertSelection({ source: twoModels(), options: optionsOf({ exclude: ['A', 'B'] }) }),
    ).toThrow(/names every scanned model/);
  });

  it('accepts a valid refusal and drops the model, its relations and its actions', () => {
    const options = optionsOf({ exclude: ['B'] });

    assertSelection({ source: twoModels(), options });

    const filtered = applyFilters({ source: twoModels(), options });

    expect(filtered.objects.map((object) => object.name)).toEqual(['A']);
    expect(filtered.actions.map((action) => action.name)).toEqual([
      'createA',
      'updateA',
      'deleteA',
      'placeOrder',
    ]);
  });

  it('composes with --models rather than overriding it', () => {
    const source: ScannedSource = {
      ...emptySource(),
      objects: [objectNamed({ name: 'A' }), objectNamed({ name: 'B' }), objectNamed({ name: 'C' })],
      actions: [...crudFor({ name: 'A' }), ...crudFor({ name: 'B' }), ...crudFor({ name: 'C' })],
    };
    const options = optionsOf({ models: ['A', 'B'], exclude: ['C'] });

    assertSelection({ source, options });

    expect(applyFilters({ source, options }).objects.map((object) => object.name)).toEqual([
      'A',
      'B',
    ]);
  });
});

/**
 * The complement of an allow-list is NOT a refusal. `init` names what it left
 * behind and hands back the command that would record it; it never records it
 * itself, because nobody enumerated those models and said no to them.
 */
describe('unaccountedModels — what --models left behind (ONT-059)', () => {
  it('names the scanned models an allow-list neither kept nor refused', () => {
    const source: ScannedSource = {
      ...emptySource(),
      objects: [objectNamed({ name: 'A' }), objectNamed({ name: 'B' }), objectNamed({ name: 'C' })],
      actions: [],
    };

    expect(unaccountedModels({ source, options: optionsOf({ models: ['A'] }) })).toEqual([
      'B',
      'C',
    ]);
    expect(
      unaccountedModels({ source, options: optionsOf({ models: ['A'], exclude: ['B'] }) }),
    ).toEqual(['C']);
  });

  it('reports nothing without an allow-list — every model was generated or refused', () => {
    const source = twoModels();

    expect(unaccountedModels({ source, options: optionsOf({}) })).toEqual([]);
    expect(unaccountedModels({ source, options: optionsOf({ exclude: ['B'] }) })).toEqual([]);
  });
});
