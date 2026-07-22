import { createRegistry } from 'orangerail-core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import type { IrObject, ScannedSource } from '../init/ir';
import { emptySource } from '../init/ir';
import { diffSync } from './diff';

const field = (over: Partial<IrObject['fields'][number]> & { name: string }) => ({
  kind: 'scalar' as const,
  scalar: 'string' as const,
  optional: false,
  list: false,
  isId: false,
  ...over,
});

const objectIr = ({ name, fields }: { name: string; fields: IrObject['fields'] }): IrObject => ({
  name,
  fields,
  relations: [],
});

const scannedOf = ({ objects }: { objects: IrObject[] }): ScannedSource => ({
  ...emptySource(),
  objects,
});

describe('diffSync (table-driven)', () => {
  const registry = createRegistry();
  registry.defineObject({
    name: 'Product',
    schema: z.object({ id: z.string(), title: z.string(), price: z.number() }),
  });

  it('reports clean when the scan matches the registry', () => {
    const scanned = scannedOf({
      objects: [
        objectIr({
          name: 'Product',
          fields: [
            field({ name: 'id', isId: true }),
            field({ name: 'title' }),
            field({ name: 'price', scalar: 'float' }),
          ],
        }),
      ],
    });

    const diff = diffSync({ scanned, registry });
    expect(diff.fieldDrifts).toEqual([]);
    expect(diff.newObjects).toEqual([]);
  });

  it('detects a Float -> Decimal type change (number vs string)', () => {
    const scanned = scannedOf({
      objects: [
        objectIr({
          name: 'Product',
          fields: [
            field({ name: 'id', isId: true }),
            field({ name: 'title' }),
            field({ name: 'price', scalar: 'decimal' }),
          ],
        }),
      ],
    });

    const drift = diffSync({ scanned, registry }).fieldDrifts.find((d) => d.field === 'price');
    expect(drift?.kind).toBe('changed');
  });

  it('detects an optionality flip and a removed field', () => {
    const scanned = scannedOf({
      objects: [
        objectIr({
          name: 'Product',
          fields: [
            field({ name: 'id', isId: true }),
            field({ name: 'title', optional: true }),
            // price removed
          ],
        }),
      ],
    });

    const drifts = diffSync({ scanned, registry }).fieldDrifts;
    expect(drifts.find((d) => d.field === 'title')?.kind).toBe('changed');
    expect(drifts.find((d) => d.field === 'price')?.kind).toBe('removed');
  });

  it('proposes an unknown scanned model as a new object', () => {
    const scanned = scannedOf({
      objects: [objectIr({ name: 'Review', fields: [field({ name: 'id', isId: true })] })],
    });

    const diff = diffSync({ scanned, registry });
    expect(diff.newObjects.map((o) => o.name)).toEqual(['Review']);
    expect(diff.registryOnlyObjects).toEqual(['Product']);
  });
});
