import {
  createMemoryStore,
  createRegistry,
  type ApprovalRecord,
  type Registry,
} from 'orangerail-core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { approvalsApprove } from '../src/commands/approvals';
import { computeStatus, formatStatusLine, runStatus } from '../src/commands/status';
import type { OrangerailConfig } from '../src/config';
import { coreSkewNotice, reviewCoreSkew } from '../src/core-skew';
import { renderApprovalDetail, renderApprovalList } from '../src/render';

/**
 * The mark's key, written as a literal for the same reason `core-skew.ts`
 * writes it as one: the reader must never take a link-time dependency on the
 * core it is inspecting. `core-skew-resolution.test.ts` is what proves that
 * property across a real module boundary; these tests exercise the verdicts.
 */
const CORE_INSTANCE_KEY = Symbol.for('orangerail.coreInstance');

/**
 * A registry as a SECOND copy of `orangerail-core` would hand it over: the same
 * `Symbol.for` key (the cross-realm registry, so both copies look up the same
 * one) carrying a token that is not this copy's.
 */
const foreignRegistry = (): Registry => {
  const registry = createRegistry();

  Object.defineProperty(registry, CORE_INSTANCE_KEY, {
    value: Object.freeze({ package: 'orangerail-core' }),
    enumerable: false,
    configurable: true,
  });

  return registry;
};

/** A registry as `0.1.0` hands it over: no mark at all. */
const legacyRegistry = (): Registry => {
  const registry = createRegistry();

  delete (registry as unknown as Record<symbol, unknown>)[CORE_INSTANCE_KEY];

  return registry;
};

const configWith = ({ registry }: { registry: Registry }): OrangerailConfig => {
  registry.defineAction({
    name: 'deleteWidget',
    input: z.object({ widgetId: z.string() }),
    policy: { approval: 'required' },
    execute: async () => ({ ok: true }),
  });

  return { registry, store: createMemoryStore() };
};

const record = ({ inputHash }: { inputHash?: string }): ApprovalRecord => ({
  id: 'ap-1',
  actionName: 'deleteWidget',
  input: { widgetId: 'w-1' },
  signatureHash: 'sig',
  ...(inputHash === undefined ? {} : { inputHash }),
  status: 'pending',
  requestedBy: 'agent-1',
  requestedByRoles: [],
  devMode: false,
  createdAt: new Date().toISOString(),
});

describe('core skew — the seam between the config core and the CLI core (ONT-058)', () => {
  it('reports a config built by this very core as aligned, and says nothing', () => {
    const review = reviewCoreSkew({ config: configWith({ registry: createRegistry() }) });

    expect(review).toEqual({ state: 'aligned' });
    expect(coreSkewNotice({ review })).toBe('');
  });

  it('reports an unmarked registry as stale and names cause, consequence and fix', () => {
    const review = reviewCoreSkew({ config: configWith({ registry: legacyRegistry() }) });
    const notice = coreSkewNotice({ review });

    expect(review).toEqual({ state: 'stale' });

    // The cause — and the case where the cause is NOT an upgrade, because an
    // operator told "you upgraded" when they did not stops reading.
    expect(notice).toContain('older than this CLI');
    expect(notice).toContain('If you did NOT just upgrade');
    // The consequence, stated as the thing that actually happens.
    expect(notice).toContain('NO GOVERNED WRITE WILL EVER COMPLETE');
    expect(notice).toContain('stale_approval');
    // The fix, including the half everyone forgets.
    expect(notice).toContain('re-stage');

    // Same voice as the existing startup warnings: every line prefixed, stderr
    // block, no bare wrapping.
    for (const line of notice.trimEnd().split('\n')) {
      expect(line.startsWith('orangerail mcp: ')).toBe(true);
    }
  });

  it('never claims alignment it cannot prove — both tokens come from a registry', () => {
    // The CLI reads ITS OWN token the same way it reads the config's: off a
    // registry, through the global symbol. It never holds core's private token,
    // which is what lets an old core on EITHER side yield a verdict instead of
    // a link error. The `unverifiable` branch (this CLI's own core being the
    // old one) cannot be built in-process — it is covered for real in
    // `core-skew-resolution.test.ts`.
    const aligned = reviewCoreSkew({ config: configWith({ registry: createRegistry() }) });
    const stale = reviewCoreSkew({ config: configWith({ registry: legacyRegistry() }) });

    expect(aligned.state).toBe('aligned');
    expect(stale.state).toBe('stale');
  });

  it('reports two marked copies as duplicated, and keeps them off server start', () => {
    // A latent hazard, not a breakage: both copies stamp the same hash, so
    // writes complete. It rides the status line and the `status` readout and
    // does NOT get a startup banner — a clean install of the packed tarballs
    // lays orangerail-core down twice, and warning about that on every start is
    // how a warning stops being read.
    const review = reviewCoreSkew({ config: configWith({ registry: foreignRegistry() }) });

    expect(review).toEqual({ state: 'duplicated' });
    expect(coreSkewNotice({ review })).toBe('');
  });

  it('carries the skew onto the status readout and the startup line', async () => {
    const config = configWith({ registry: legacyRegistry() });
    const report = await computeStatus({ config, projectRoot: '/nonexistent-project-root' });

    expect(report.skew).toEqual({ state: 'stale' });
    expect(formatStatusLine({ report })).toContain('CORE VERSION SKEW');
  });

  it('makes `orangerail status` print the runtime block and exit 1', async () => {
    const config = configWith({ registry: legacyRegistry() });
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const code = await runStatus({ config, projectRoot: '/nonexistent-project-root' });
    spy.mockRestore();

    const out = written.join('');
    expect(out).toContain('runtime:  CORE VERSION SKEW');
    expect(out).toContain('NO GOVERNED WRITE WILL COMPLETE');
    // A clean chain and live gates must not buy a green exit here.
    expect(code).toBe(1);
  });

  it('stays silent on the readout when the cores agree', async () => {
    const config = configWith({ registry: createRegistry() });
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const code = await runStatus({ config, projectRoot: '/nonexistent-project-root' });
    spy.mockRestore();

    expect(written.join('')).not.toContain('runtime:');
    expect(code).toBe(0);
  });
});

describe('approval surfaces — an unexecutable approval says so first (ONT-058)', () => {
  it('flags the missing binding in `approvals show`, above the payload', () => {
    const detail = renderApprovalDetail({ record: record({}) });

    expect(detail).toContain('binding:      NONE');
    expect(detail).toContain('stale_approval');
    expect(detail.indexOf('binding:')).toBeLessThan(detail.indexOf('input (agent-supplied)'));
  });

  it('leaves a normal approval detail untouched', () => {
    expect(renderApprovalDetail({ record: record({ inputHash: 'abc' }) })).not.toContain(
      'binding:',
    );
  });

  it('marks unexecutable rows in the queue and counts them in the footer', () => {
    const list = renderApprovalList({
      approvals: [record({}), { ...record({ inputHash: 'abc' }), id: 'ap-2' }],
    });

    expect(list).toContain('[UNEXECUTABLE]');
    expect(list).toContain('1 of them cannot execute');
    expect(list.match(/\[UNEXECUTABLE\]/g)).toHaveLength(1);
  });

  it('warns after `approve ok` when the approval it just approved cannot run', async () => {
    // The exact line that made this bug expensive: `approve ok (approved)` is
    // true, and on its own it reads as "the write is cleared to run".
    const config = configWith({ registry: createRegistry() });
    const staged = await config.store.createApproval({
      record: {
        actionName: 'deleteWidget',
        input: { widgetId: 'w-1' },
        signatureHash: 'sig',
        requestedBy: 'agent-1',
        requestedByRoles: [],
        devMode: false,
      },
    });

    const stale: OrangerailConfig = {
      ...config,
      store: {
        ...config.store,
        resolveApproval: async (args) => {
          const result = await config.store.resolveApproval(args);
          if (!result.ok) {
            return result;
          }

          const copy = { ...result.record };
          delete (copy as { inputHash?: string }).inputHash;

          return { ok: true, record: copy };
        },
      },
    };

    const out: string[] = [];
    const errs: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errs.push(String(chunk));
      return true;
    });

    const code = await approvalsApprove({ config: stale, id: staged.id });
    outSpy.mockRestore();
    errSpy.mockRestore();

    expect(out.join('')).toContain('approve ok (approved)');
    expect(errs.join('')).toContain('NO');
    expect(errs.join('')).toContain('stale_approval');
    // The approval really did resolve; a non-zero exit would break scripts over
    // a condition they cannot fix.
    expect(code).toBe(0);
  });
});
