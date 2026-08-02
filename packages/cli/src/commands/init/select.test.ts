import { describe, expect, it } from 'vitest';

import { buildFileSet } from './codegen';
import type { IrAction, IrObject, ScannedSource } from './ir';
import { emptySource } from './ir';
import { applyFilters, resolveSelection, SOURCE_NAMES, unaccountedModels } from './select';
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

describe('resolveSelection — garbage fails loudly like --preset does (ONT-041 defect E)', () => {
  it('refuses a --sources value that is not a known scanner, naming the valid set', () => {
    expect(() =>
      resolveSelection({ source: twoModels(), options: optionsOf({ sources: ['nonsense'] }) }),
    ).toThrow(/unknown source "nonsense" — expected one of prisma, openapi/);
  });

  it('refuses a --models value that matches nothing, naming what the repo has', () => {
    expect(() =>
      resolveSelection({ source: twoModels(), options: optionsOf({ models: ['Typo'] }) }),
    ).toThrow(/unknown model "Typo" — expected one of A, B/);
  });

  it('names every offending value, not just the first', () => {
    expect(() =>
      resolveSelection({ source: twoModels(), options: optionsOf({ models: ['Typo', 'Nope'] }) }),
    ).toThrow(/"Typo", "Nope"/);
  });

  it('accepts a selection that matches, and an absent selection', () => {
    const source = twoModels();

    expect(() =>
      resolveSelection({ source, options: optionsOf({ sources: SOURCE_NAMES, models: ['A'] }) }),
    ).not.toThrow();
    expect(() => resolveSelection({ source, options: optionsOf({}) })).not.toThrow();
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
      resolveSelection({ source: twoModels(), options: optionsOf({ exclude: ['Typo'] }) }),
    ).toThrow(/unknown model "Typo" in --exclude — expected one of A, B/);
  });

  it('refuses a name given to both --models and --exclude instead of picking a winner', () => {
    expect(() =>
      resolveSelection({
        source: twoModels(),
        options: optionsOf({ models: ['A'], exclude: ['A'] }),
      }),
    ).toThrow(/"A" appears in both --models and --exclude/);
  });

  it('refuses an --exclude that would leave nothing to govern', () => {
    expect(() =>
      resolveSelection({ source: twoModels(), options: optionsOf({ exclude: ['A', 'B'] }) }),
    ).toThrow(/names every scanned model/);
  });

  it('accepts a valid refusal and drops the model, its relations and its actions', () => {
    const options = optionsOf({ exclude: ['B'] });

    resolveSelection({ source: twoModels(), options });

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

    resolveSelection({ source, options });

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

/**
 * ONT-063 — the typed name is resolved to the scanned one, and only the scanned
 * one survives.
 *
 * The assertions below are all one claim: `resolveSelection` returns a
 * selection, and its names are the SCANNED spellings. A lenient comparison that
 * let `payment` through while keeping the typed string would satisfy "the flag
 * works" and still write `"excluded": ["payment"]` into a committed
 * `orangerail.governance.json`, where `sync` compares it exactly and matches
 * nothing — the ONT-059 defect back again, this time with a file that looks
 * right.
 */
describe('--models / --exclude are resolved to the scanned casing (ONT-063)', () => {
  /** A Prisma-shaped scan: the model is `Payment`, the table is `payment`. */
  const shop = (): ScannedSource => ({
    ...emptySource(),
    objects: [objectNamed({ name: 'Customer' }), objectNamed({ name: 'Payment' })],
    actions: [...crudFor({ name: 'Customer' }), ...crudFor({ name: 'Payment' })],
  });

  /**
   * What `scanRepo` really hands over for a schema declaring `Order` AND
   * `order`: the allocator (ONT-041) has already renamed the second one,
   * because both would claim `ontology/Order.mjs`. Folding only the emitted
   * names would see no collision here at all — which is the trap, since typing
   * `order` would then land on `Order`.
   */
  const collidingCase = (): ScannedSource => ({
    ...emptySource(),
    objects: [
      objectNamed({ name: 'Order' }),
      { ...objectNamed({ name: 'order_2' }), sourceModel: 'order' },
    ],
    actions: [],
  });

  it('AC-1: --exclude payment behaves exactly as --exclude Payment does', () => {
    const typed = resolveSelection({
      source: shop(),
      options: optionsOf({ exclude: ['payment'] }),
    });
    const exact = resolveSelection({
      source: shop(),
      options: optionsOf({ exclude: ['Payment'] }),
    });

    expect(typed).toEqual(exact);
    expect(applyFilters({ source: shop(), options: typed })).toEqual(
      applyFilters({ source: shop(), options: exact }),
    );
  });

  it('AC-2: the surviving name is the scanned one, which is what gets recorded', () => {
    // Read as: this is the array that reaches `writeBaseline`. Anything but
    // `Payment` here is a deny-list that `excluded.has(name)` never matches.
    expect(
      resolveSelection({ source: shop(), options: optionsOf({ exclude: ['PAYMENT'] }) }).exclude,
    ).toEqual(['Payment']);
  });

  it('AC-3: --models resolves the same way, and the emitted filenames do not move', () => {
    const typed = resolveSelection({ source: shop(), options: optionsOf({ models: ['payment'] }) });

    expect(typed.models).toEqual(['Payment']);

    const paths = ({ options }: { options: ResolvedInit }): string[] =>
      buildFileSet({
        source: applyFilters({ source: shop(), options }),
        preset: 'approval-for-writes',
        gate: 'all',
      })
        .map((file) => file.path)
        .sort();

    expect(paths({ options: typed })).toEqual(
      paths({
        options: resolveSelection({ source: shop(), options: optionsOf({ models: ['Payment'] }) }),
      }),
    );
    expect(paths({ options: typed })).toContain('ontology/Payment.mjs');
  });

  it('AC-4: a name that matches nothing case-insensitively keeps the existing refusal', () => {
    expect(() =>
      resolveSelection({ source: shop(), options: optionsOf({ exclude: ['paymnet'] }) }),
    ).toThrow(/unknown model "paymnet" in --exclude — expected one of Customer, Payment/);

    // No plural rule, no prefix rule, no edit distance. Each of these is one
    // keystroke from a real model and none of them is that model: a flag that
    // decides which tables an agent can reach cannot guess.
    for (const near of ['payments', 'pay', 'paymentss']) {
      expect(() =>
        resolveSelection({ source: shop(), options: optionsOf({ exclude: [near] }) }),
      ).toThrow(/unknown model/);
    }
  });

  it('AC-5: differing casing cannot smuggle one model into both flags', () => {
    expect(() =>
      resolveSelection({
        source: shop(),
        options: optionsOf({ models: ['Payment'], exclude: ['payment'] }),
      }),
    ).toThrow(/"Payment" appears in both --models and --exclude/);
  });

  it('AC-6: two models whose source names differ only in case are refused, not picked between', () => {
    expect(() =>
      resolveSelection({ source: collidingCase(), options: optionsOf({ exclude: ['order'] }) }),
    ).toThrow(
      /ambiguous model "order" in --exclude — it could mean Order or order_2, whose source names differ only in case/,
    );

    // Including when the typed name IS one of them. `--exclude Order` on this
    // schema reads as "refuse the orders table", and half of it would stay
    // reachable without a word said.
    expect(() =>
      resolveSelection({ source: collidingCase(), options: optionsOf({ models: ['ORDER'] }) }),
    ).toThrow(/ambiguous model "ORDER" in --models/);
    expect(() =>
      resolveSelection({ source: collidingCase(), options: optionsOf({ exclude: ['Order'] }) }),
    ).toThrow(/ambiguous model/);

    // The de-collided name the scan warning hands the operator is the way
    // through: it names exactly one model, so it resolves.
    expect(
      resolveSelection({ source: collidingCase(), options: optionsOf({ exclude: ['order_2'] }) })
        .exclude,
    ).toEqual(['order_2']);

    // A model NOT in the colliding pair still resolves — the refusal is about
    // the name that has two answers, not about the whole schema.
    expect(
      resolveSelection({
        source: {
          ...collidingCase(),
          objects: [...collidingCase().objects, objectNamed({ name: 'Refund' })],
        },
        options: optionsOf({ exclude: ['refund'] }),
      }).exclude,
    ).toEqual(['Refund']);
  });

  it('counts models rather than typed strings when --exclude covers everything', () => {
    // `--exclude PAYMENT,payment` is one model. Refusing this run for naming
    // "every scanned model" would be a refusal over an arithmetic accident.
    const resolved = resolveSelection({
      source: shop(),
      options: optionsOf({ exclude: ['PAYMENT', 'payment'] }),
    });

    expect(resolved.exclude).toEqual(['Payment']);

    // And the guard still fires when the resolved set really is everything.
    expect(() =>
      resolveSelection({
        source: shop(),
        options: optionsOf({ exclude: ['customer', 'PAYMENT'] }),
      }),
    ).toThrow(/names every scanned model/);
  });

  it('leaves a selection whose casing already matches byte-identical', () => {
    const options = optionsOf({ models: ['Customer'], exclude: ['Payment'] });

    expect(resolveSelection({ source: shop(), options })).toEqual(options);
  });

  it('reports what an allow-list left behind under its scanned name', () => {
    const resolved = resolveSelection({
      source: shop(),
      options: optionsOf({ models: ['customer'] }),
    });

    expect(unaccountedModels({ source: shop(), options: resolved })).toEqual(['Payment']);
  });
});
