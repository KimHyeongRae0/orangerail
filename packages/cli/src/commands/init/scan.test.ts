import { describe, expect, it } from 'vitest';

import { sanitizeIdentifier } from './codegen/escape';
import type { IrAction, IrObject } from './ir';
import { emptySource } from './ir';
import { allocateNames } from './scan';

const actionNamed = ({ name, rawName }: { name: string; rawName?: string }): IrAction => ({
  name,
  source: 'openapi',
  ...(rawName === undefined ? {} : { rawName }),
  method: 'POST',
  path: `/x/${name}`,
  write: true,
  input: [],
});

const objectNamed = ({ name }: { name: string }): IrObject => ({
  name,
  fields: [
    { name: 'id', kind: 'scalar', scalar: 'string', optional: false, list: false, isId: true },
  ],
  relations: [],
  idField: 'id',
});

const bindingOf = ({ name }: { name: string }): string => sanitizeIdentifier({ value: name });

describe('allocateNames — action-only cases (pre-existing behavior stays green)', () => {
  it('leaves already-unique names untouched, with no warning', () => {
    const source = emptySource();
    source.actions = [actionNamed({ name: 'placeOrder' }), actionNamed({ name: 'issueRefund' })];

    const out = allocateNames({ source });

    expect(out.actions.map((a) => a.name)).toEqual(['placeOrder', 'issueRefund']);
    expect(out.warnings).toEqual([]);
  });

  it('suffixes truncation collisions inside the 64-char budget and warns', () => {
    // Real-world case: GitHub's `…organization-definitions` (PATCH) and
    // `…organization-definition` (PUT) operationIds differ only past the
    // 64-char sanitization cut — the second one silently overwrote the first.
    const collided = 'orgs_custom-properties-for-repos-create-or-update-organization-d';
    const source = emptySource();
    source.actions = [
      actionNamed({
        name: collided,
        rawName: 'orgs/custom-properties-for-repos-create-or-update-organization-definitions',
      }),
      actionNamed({
        name: collided,
        rawName: 'orgs/custom-properties-for-repos-create-or-update-organization-definition',
      }),
    ];

    const out = allocateNames({ source });
    const names = out.actions.map((a) => a.name);

    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe(collided);
    expect(names[1]).toBe(`${collided.slice(0, 62)}_2`);
    expect(names[1]?.length).toBeLessThanOrEqual(64);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('renamed to');
  });

  it('keeps suffixed candidates unique when the suffixed name is itself taken', () => {
    const source = emptySource();
    source.actions = [
      actionNamed({ name: 'syncRepo' }),
      actionNamed({ name: 'syncRepo_2' }),
      actionNamed({ name: 'syncRepo' }),
    ];

    const out = allocateNames({ source });

    expect(out.actions.map((a) => a.name)).toEqual(['syncRepo', 'syncRepo_2', 'syncRepo_3']);
  });
});

describe('allocateNames — object dedup (ONT-015 AC-2)', () => {
  it('de-collides two object names that sanitize to the same identifier into distinct bindings', () => {
    // `A__B` and `A_B` both sanitize to `A_B` (runs of `_` collapse), so they
    // would emit one `ontology/A_B.mjs` and the later write would win.
    const source = emptySource();
    source.objects = [objectNamed({ name: 'A__B' }), objectNamed({ name: 'A_B' })];

    const out = allocateNames({ source });
    const names = out.objects.map((o) => o.name);
    const bindings = names.map((name) => bindingOf({ name }));

    expect(names[0]).toBe('A__B');
    expect(new Set(bindings).size).toBe(2);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('renamed to');
  });

  it('resolves an object-vs-action collision toward the object keeping its slot (AC-2)', () => {
    // Objects are claimed before actions, so the object keeps `Widget`; the
    // action whose binding also sanitizes to `Widget` is renamed.
    const source = emptySource();
    source.objects = [objectNamed({ name: 'Widget' })];
    source.actions = [actionNamed({ name: 'Widget' })];

    const out = allocateNames({ source });

    expect(out.objects[0]?.name).toBe('Widget');
    expect(out.actions[0]?.name).not.toBe('Widget');
    expect(bindingOf({ name: out.objects[0]!.name })).not.toBe(
      bindingOf({ name: out.actions[0]!.name }),
    );
    expect(out.warnings).toHaveLength(1);
  });

  it('composes the reserved-binding suffix with the dedup allocator without a special case', () => {
    // Object `registry` -> binding `registry_` (reserved); a second object
    // `registry_` also maps toward `registry_`, so the allocator de-collides it.
    const source = emptySource();
    source.objects = [objectNamed({ name: 'registry' }), objectNamed({ name: 'registry_' })];

    const out = allocateNames({ source });
    const bindings = out.objects.map((o) => bindingOf({ name: o.name }));

    // The first object keeps its original name; only its binding is suffixed.
    expect(out.objects[0]?.name).toBe('registry');
    expect(bindings[0]).toBe('registry_');
    expect(new Set(bindings).size).toBe(2);
  });
});

describe('allocateNames — determinism + order (ONT-015)', () => {
  it('renders the same allocation for the same input twice (deterministic order)', () => {
    const build = () => {
      const source = emptySource();
      source.objects = [objectNamed({ name: 'A__B' }), objectNamed({ name: 'A_B' })];
      source.actions = [actionNamed({ name: 'A_B' })];
      return allocateNames({ source });
    };

    const a = build();
    const b = build();

    expect(a.objects.map((o) => o.name)).toEqual(b.objects.map((o) => o.name));
    expect(a.actions.map((x) => x.name)).toEqual(b.actions.map((x) => x.name));
    expect(a.warnings).toEqual(b.warnings);
  });

  it('is a strict no-op on non-colliding input (AC-5 byte-identity)', () => {
    const source = emptySource();
    source.objects = [objectNamed({ name: 'Product' }), objectNamed({ name: 'Customer' })];
    source.actions = [actionNamed({ name: 'placeOrder' }), actionNamed({ name: 'issueRefund' })];

    const out = allocateNames({ source });

    expect(out.objects.map((o) => o.name)).toEqual(['Product', 'Customer']);
    expect(out.actions.map((a) => a.name)).toEqual(['placeOrder', 'issueRefund']);
    expect(out.warnings).toEqual([]);
  });
});
