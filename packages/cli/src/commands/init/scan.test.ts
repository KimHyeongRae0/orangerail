import { describe, expect, it } from 'vitest';

import type { IrAction } from './ir';
import { emptySource } from './ir';
import { dedupeActionNames } from './scan';

const actionNamed = ({ name, rawName }: { name: string; rawName?: string }): IrAction => ({
  name,
  ...(rawName === undefined ? {} : { rawName }),
  method: 'POST',
  path: `/x/${name}`,
  write: true,
  input: [],
});

describe('dedupeActionNames', () => {
  it('leaves already-unique names untouched, with no warning', () => {
    const source = emptySource();
    source.actions = [actionNamed({ name: 'placeOrder' }), actionNamed({ name: 'issueRefund' })];

    const out = dedupeActionNames({ source });

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

    const out = dedupeActionNames({ source });
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

    const out = dedupeActionNames({ source });

    expect(out.actions.map((a) => a.name)).toEqual(['syncRepo', 'syncRepo_2', 'syncRepo_3']);
  });
});
