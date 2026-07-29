import { validateToolName } from 'orangerail-mcp';
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

describe('allocateNames — case-insensitive filesystem collisions (ONT-041 defect A)', () => {
  it('de-collides two model names that differ only in case', () => {
    // `model user` + `model User` is legal Prisma. Keying the allocation on the
    // case-SENSITIVE identifier let both through, so init emitted `user.mjs`
    // and `User.mjs` — the same file on macOS/Windows. The second write
    // clobbered the first, `deleteuser.mjs` still imported `./User.mjs`, and
    // Node's URL-keyed ESM loader evaluated the one surviving inode twice, so
    // `defineObject` ran twice and the project died with "duplicate object
    // name" — a message naming neither model nor the word "case".
    const source = emptySource();
    source.objects = [objectNamed({ name: 'user' }), objectNamed({ name: 'User' })];

    const out = allocateNames({ source });
    const names = out.objects.map((o) => o.name);

    expect(names[0]).toBe('user');
    expect(names[1]).not.toBe('User');
    // the emitted filename stems are distinct even compared the way a
    // case-insensitive filesystem compares them.
    const stems = names.map((name) => bindingOf({ name }).toLowerCase());
    expect(new Set(stems).size).toBe(2);
  });

  it('names BOTH colliding models in the warning and says the match is case-insensitive', () => {
    const source = emptySource();
    source.objects = [objectNamed({ name: 'user' }), objectNamed({ name: 'User' })];

    const out = allocateNames({ source });

    expect(out.warnings).toHaveLength(1);
    const warning = out.warnings[0]!;
    expect(warning).toContain("'User'");
    expect(warning).toContain("'user'");
    expect(warning).toContain('case-insensitively');
    expect(warning).toContain('renamed to');
  });

  it('allocates identically regardless of the host filesystem (deterministic, platform-free)', () => {
    // The allocation reads no filesystem at all, so the file set generated on
    // Linux is the file set generated on macOS — the published CLI produced two
    // different projects for the same schema depending on the host.
    const build = () => {
      const source = emptySource();
      source.objects = [objectNamed({ name: 'user' }), objectNamed({ name: 'User' })];
      source.actions = [actionNamed({ name: 'deleteuser' }), actionNamed({ name: 'deleteUser' })];
      return allocateNames({ source });
    };

    expect(build()).toEqual(build());

    const out = build();
    const stems = [
      ...out.objects.map((o) => bindingOf({ name: o.name })),
      ...out.actions.map((a) => bindingOf({ name: a.name })),
    ].map((stem) => stem.toLowerCase());

    expect(new Set(stems).size).toBe(stems.length);
  });
});

describe('allocateNames — object names are MCP tool-name stems (ONT-041 defect C)', () => {
  it('keeps <Object>_get / <Object>_list legal for a 61-char model name', () => {
    // A 61-char model produced a 65-char `<name>_get`, so `orangerail mcp`
    // refused to boot on a project `init` had just reported as a success.
    const long = `Order${'X'.repeat(56)}`;
    expect(long).toHaveLength(61);

    const source = emptySource();
    source.objects = [objectNamed({ name: long })];

    const out = allocateNames({ source });
    const name = out.objects[0]!.name;

    expect(() => validateToolName({ name: `${name}_get` })).not.toThrow();
    expect(() => validateToolName({ name: `${name}_list` })).not.toThrow();
    expect(out.warnings[0]).toContain('MCP tool-name stem');
  });

  it('replaces charset-illegal characters in an object name', () => {
    const source = emptySource();
    source.objects = [objectNamed({ name: 'Order.Line' })];

    const out = allocateNames({ source });
    const name = out.objects[0]!.name;

    expect(() => validateToolName({ name: `${name}_get` })).not.toThrow();
    expect(name).not.toContain('.');
  });

  it('leaves an already-legal object name — including underscore runs — untouched', () => {
    // Legality, not normalization: `my__model` and `_Internal` are legal Prisma
    // models AND legal tool-name stems, so renaming them would churn every
    // existing generated project for nothing.
    const source = emptySource();
    source.objects = [objectNamed({ name: 'my__model' }), objectNamed({ name: '_Internal' })];

    const out = allocateNames({ source });

    expect(out.objects.map((o) => o.name)).toEqual(['my__model', '_Internal']);
    expect(out.warnings).toEqual([]);
  });
});

describe('allocateNames — the source model name never moves (ONT-041 defect D)', () => {
  it('pins sourceModel to the pre-rename name when it renames an object', () => {
    const source = emptySource();
    source.objects = [
      { ...objectNamed({ name: 'User' }), sourceModel: 'User' },
      { ...objectNamed({ name: 'user' }), sourceModel: 'user' },
    ];

    const out = allocateNames({ source });

    expect(out.objects[1]!.name).not.toBe('user');
    expect(out.objects[1]!.sourceModel).toBe('user');
  });

  it('tracks the rename onto a Prisma action model while pinning its sourceModel', () => {
    const source = emptySource();
    source.objects = [
      { ...objectNamed({ name: 'User' }), sourceModel: 'User' },
      { ...objectNamed({ name: 'user' }), sourceModel: 'user' },
    ];
    source.actions = [
      {
        name: 'deleteuser',
        source: 'prisma',
        prisma: { model: 'user', sourceModel: 'user', op: 'delete', idField: 'id' },
        write: true,
        input: [{ name: 'id', kind: 'scalar', scalar: 'string', optional: false }],
      },
    ];

    const out = allocateNames({ source });
    const renamed = out.objects[1]!.name;

    // the import target follows the file that was actually written…
    expect(out.actions[0]!.prisma?.model).toBe(renamed);
    // …while the database accessor keeps following the schema.
    expect(out.actions[0]!.prisma?.sourceModel).toBe('user');
  });

  it('re-points a relation target at the renamed object so its link survives', () => {
    const source = emptySource();
    source.objects = [
      objectNamed({ name: 'A__B' }),
      objectNamed({ name: 'A_B' }),
      {
        ...objectNamed({ name: 'Parent' }),
        relations: [{ field: 'kids', target: 'A_B', cardinality: 'many' as const }],
      },
    ];

    const out = allocateNames({ source });
    const renamed = out.objects[1]!.name;

    expect(renamed).not.toBe('A_B');
    expect(out.objects[2]!.relations[0]!.target).toBe(renamed);
  });
});
