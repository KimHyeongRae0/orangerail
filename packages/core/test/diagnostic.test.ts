import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  markPublicDiagnostic,
  PUBLIC_DIAGNOSTIC_KEY,
  readPublicDiagnostic,
} from '../src/diagnostic';
import { createEngine } from '../src/lifecycle/engine';
import { createRegistry } from '../src/registry';
import { createMemoryStore } from '../src/store/memory';
import type { Identity } from '../src/types';

/**
 * ONT-045 — the public-diagnostic channel.
 *
 * The property under test is not "the happy path works". It is that the channel
 * cannot become a text channel: everything crossing it is revalidated against a
 * closed code set and an identifier shape, and anything else fails CLOSED to
 * "no diagnostic", which is full redaction.
 */

const caller: Identity = { subject: 'agent', roles: [], devMode: true };

/** An error marked by hand the way a generated ontology file marks one. */
const tagged = ({ value }: { value: unknown }): Error => {
  const error = new Error('driver text that must never travel');
  Object.defineProperty(error, PUBLIC_DIAGNOSTIC_KEY, { value, configurable: true });

  return error;
};

describe('core — readPublicDiagnostic revalidates everything', () => {
  it('round-trips a marked code and subject', () => {
    const error = markPublicDiagnostic({
      error: new Error('boom'),
      code: 'datasource_model_missing',
      subject: 'Post',
    });

    expect(readPublicDiagnostic({ error })).toEqual({
      code: 'datasource_model_missing',
      subject: 'Post',
    });
  });

  it('leaves the error message untouched — the mark changes nothing about the text', () => {
    const error = markPublicDiagnostic({
      error: new Error('Environment variable not found: DATABASE_URL'),
      code: 'datasource_not_configured',
    });

    expect(error.message).toBe('Environment variable not found: DATABASE_URL');
    expect(readPublicDiagnostic({ error })).toEqual({ code: 'datasource_not_configured' });
  });

  it('does not enumerate, so the mark never lands in JSON or a spread', () => {
    const error = markPublicDiagnostic({
      error: new Error('boom'),
      code: 'datasource_client_missing',
    });

    expect(Object.keys(error)).not.toContain(String(PUBLIC_DIAGNOSTIC_KEY));
    expect(JSON.stringify({ ...error })).not.toContain('datasource_client_missing');
  });

  it('returns undefined for an unmarked error, a non-object, and null', () => {
    expect(readPublicDiagnostic({ error: new Error('plain') })).toBeUndefined();
    expect(readPublicDiagnostic({ error: 'a string' })).toBeUndefined();
    expect(readPublicDiagnostic({ error: null })).toBeUndefined();
    expect(readPublicDiagnostic({ error: undefined })).toBeUndefined();
  });

  it('rejects a code outside the closed set — a forger cannot invent a class', () => {
    expect(readPublicDiagnostic({ error: tagged({ value: { code: 'anything_goes' } }) })).toBe(
      undefined,
    );
    expect(readPublicDiagnostic({ error: tagged({ value: { code: 42 } }) })).toBeUndefined();
    expect(readPublicDiagnostic({ error: tagged({ value: 'datasource_not_configured' }) })).toBe(
      undefined,
    );
    expect(readPublicDiagnostic({ error: tagged({ value: null }) })).toBeUndefined();
  });

  it('drops a subject that is not an identifier — the field cannot carry a payload', () => {
    // Every one of these is something a hostile datasource would want to smuggle
    // out through a field that reaches the agent verbatim.
    const hostile = [
      'postgres://admin:hunter2@db.internal:5432/prod',
      '/srv/app/src/db/orders.ts',
      'Order_customerId_fkey (index)\nat Object.<anonymous>',
      'a b',
      '',
      'x'.repeat(65),
      '1LeadingDigit',
      'has-a-hyphen',
    ];

    for (const subject of hostile) {
      const read = readPublicDiagnostic({
        error: tagged({ value: { code: 'datasource_not_configured', subject } }),
      });

      expect(read).toEqual({ code: 'datasource_not_configured' });
      expect(read?.subject).toBeUndefined();
    }
  });

  it('accepts the identifier shapes a real object or model name takes', () => {
    for (const subject of ['Post', '_internal', 'User_2', 'a', 'x'.repeat(64)]) {
      expect(
        readPublicDiagnostic({
          error: tagged({ value: { code: 'datasource_client_missing', subject } }),
        }),
      ).toEqual({ code: 'datasource_client_missing', subject });
    }
  });

  it('keys on the GLOBAL symbol registry, so a second copy of core still reads it', () => {
    // A generated ontology file marks with a `Symbol.for(...)` literal and no
    // import. If the key were a module-local symbol, that mark would be
    // invisible here and the classification would silently vanish.
    const error = new Error('boom');
    Object.defineProperty(error, Symbol.for('orangerail.publicDiagnostic'), {
      value: { code: 'datasource_not_configured' },
      configurable: true,
    });

    expect(readPublicDiagnostic({ error })).toEqual({ code: 'datasource_not_configured' });
  });
});

describe('core — the engine carries the diagnostic, never instead of the text', () => {
  const engineWith = ({ thrown }: { thrown: unknown }) => {
    const registry = createRegistry();
    registry.defineAction({
      name: 'createNote',
      input: z.object({ title: z.string() }),
      execute: async () => {
        throw thrown;
      },
    });

    return createEngine({ registry, store: createMemoryStore() });
  };

  it('attaches the diagnostic to a failed execute alongside the full error', async () => {
    const engine = engineWith({
      thrown: markPublicDiagnostic({
        error: new Error('Environment variable not found: DATABASE_URL'),
        code: 'datasource_not_configured',
      }),
    });

    const result = await engine.stage({ actionName: 'createNote', input: { title: 't' }, caller });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.diagnostic).toEqual({ code: 'datasource_not_configured' });
    // The operator half is unchanged — the diagnostic is additive, not a swap.
    expect(result.error).toBe('Environment variable not found: DATABASE_URL');
  });

  it('leaves an unclassifiable failure with no diagnostic at all (fails closed)', async () => {
    const engine = engineWith({ thrown: new Error('Unique constraint failed on `email`') });

    const result = await engine.stage({ actionName: 'createNote', input: { title: 't' }, caller });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.diagnostic).toBeUndefined();
    expect(result.error).toBe('Unique constraint failed on `email`');
  });

  it('carries a diagnostic out of a throwing where-target resolve too', async () => {
    const registry = createRegistry();
    const note = registry.defineObject({
      name: 'Note',
      schema: z.object({ id: z.string() }),
      resolve: {
        get: async () => {
          throw markPublicDiagnostic({
            error: new Error('Cannot find module .prisma/client/default'),
            code: 'datasource_client_missing',
            subject: 'Note',
          });
        },
      },
    });
    registry.defineAction({
      name: 'archiveNote',
      input: z.object({ id: z.string() }),
      target: note,
      targetIdFrom: 'id',
      policy: { where: { field: 'id', op: 'eq', value: 'n1' } },
      execute: async () => ({ ok: true }),
    });

    const engine = createEngine({ registry, store: createMemoryStore() });
    const result = await engine.stage({
      actionName: 'archiveNote',
      input: { id: 'n1' },
      caller,
    });

    expect(result.status).toBe('resolve_error');
    if (result.status !== 'resolve_error') return;
    expect(result.diagnostic).toEqual({ code: 'datasource_client_missing', subject: 'Note' });
  });
});
