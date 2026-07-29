import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore, createRegistry, type Registry } from 'orangerail-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { OrangerailConfig } from '../src/config';
import { actionPostures, GOVERNANCE_FILE, writeBaseline } from '../src/governance';
import { runMcp } from '../src/commands/mcp';
import { boundPortOf } from '../src/commands/studio';

describe('studio — the URL reports the port actually bound (ONT-044 D)', () => {
  it('reports the ephemeral port the OS picked for --port 0, not the 0 we asked for', async () => {
    const server = createServer();

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

      const bound = boundPortOf({ server, requested: 0 });

      // Pre-fix the URL was built from `port`, printing http://127.0.0.1:0 for a
      // server that was genuinely listening somewhere else.
      expect(bound).not.toBe(0);
      expect(bound).toBeGreaterThan(0);
      expect(bound).toBeLessThan(65536);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports an explicitly requested port unchanged', async () => {
    const server = createServer();

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const bound = boundPortOf({ server, requested: 0 });
      await new Promise<void>((resolve) => server.close(() => resolve()));

      const again = createServer();
      await new Promise<void>((resolve) => again.listen(bound, '127.0.0.1', resolve));
      expect(boundPortOf({ server: again, requested: bound })).toBe(bound);
      await new Promise<void>((resolve) => again.close(() => resolve()));
    } finally {
      server.close();
    }
  });

  it('falls back to the requested port for a non-inet address shape', () => {
    expect(boundPortOf({ server: { address: () => '/tmp/sock' }, requested: 4820 })).toBe(4820);
    expect(boundPortOf({ server: { address: () => null }, requested: 4820 })).toBe(4820);
  });
});

describe('mcp — a server that fails to start claims nothing (ONT-044 E)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A config whose action name is illegal as an MCP tool name, so
   * `createMcpServer` throws before anything can serve.
   */
  const doomedConfig = (): OrangerailConfig => {
    const root = mkdtempSync(join(tmpdir(), 'orangerail-mcp-'));
    dirs.push(root);

    const registry = createRegistry();
    registry.defineAction({
      name: `delete${'ExtremelyLongDomain'.repeat(8)}`,
      input: z.object({ id: z.string() }),
      policy: { approval: 'required' },
      execute: async () => ({ ok: true }),
    });

    return { registry, store: createFileStore({ dir: join(root, 'store') }) };
  };

  /** Capture stderr; the confidence line is written straight to the stream. */
  const captureStderr = (): { text: () => string; restore: () => void } => {
    let text = '';
    const real = process.stderr.write.bind(process.stderr);

    process.stderr.write = ((chunk: string) => {
      text += chunk;
      return true;
    }) as typeof process.stderr.write;

    return {
      text: () => text,
      restore: () => {
        process.stderr.write = real;
      },
    };
  };

  it('writes neither the "serving" line nor a heartbeat when the server cannot be built', async () => {
    const config = doomedConfig();
    const stderr = captureStderr();

    let thrown: unknown;
    try {
      await runMcp({ config });
    } catch (err) {
      thrown = err;
    } finally {
      stderr.restore();
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/invalid MCP tool name/);

    // Pre-fix, the confidence line was written BEFORE createMcpServer, so a
    // host's log read as a healthy start followed by a mysterious crash.
    expect(stderr.text()).not.toContain('serving');
    expect(stderr.text()).toBe('');

    // The liveness heartbeat is equally a claim, and equally must not survive a
    // failed start: `orangerail status` reads it as "a server is enforcing".
    const serversDir = join(dirs[0] ?? '', 'servers');
    let entries: string[] = [];
    try {
      entries = readdirSync(serversDir);
    } catch {
      entries = [];
    }
    expect(entries).toEqual([]);
  });
});

/**
 * ONT-050 — the reproduction. With a recorded baseline and a gate deleted from
 * the ontology, `sync` correctly said `deleteOrder — approval gate removed` and
 * exited 1, and then `orangerail mcp` started, printed
 * `18 action(s) approval-gated`, and ran `deleteOrder({id:8})` with no approval.
 * Because the action was legitimately un-gated the audit chain recorded nothing
 * anomalous, so `audit verify` stayed green: only a `sync` someone remembered to
 * run could ever catch it.
 */
describe('mcp — a posture the baseline contradicts is not served (ONT-050)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  /** A project root plus a config with one gated and one un-gated action. */
  const project = ({
    gateDelete,
  }: {
    gateDelete: boolean;
  }): { root: string; config: OrangerailConfig } => {
    const root = mkdtempSync(join(tmpdir(), 'orangerail-gov-serve-'));
    dirs.push(root);

    const registry = createRegistry();
    registry.defineObject({
      name: 'Order',
      schema: z.object({ id: z.string() }),
      resolve: { get: async ({ id }: { id: string }) => ({ id }) },
    });
    registry.defineAction({
      name: 'deleteOrder',
      input: z.object({ id: z.string() }),
      ...(gateDelete ? { policy: { approval: 'required' as const } } : {}),
      execute: async () => ({ ok: true }),
    });
    registry.defineAction({
      name: 'archiveOrder',
      input: z.object({ id: z.string() }),
      policy: { approval: 'required' },
      execute: async () => ({ ok: true }),
    });

    return { root, config: { registry, store: createFileStore({ dir: join(root, 'store') }) } };
  };

  /**
   * Drive `runMcp` without a real stdio transport: it is the CLI-side review and
   * the registry it hands to `createMcpServer` that are under test, and a
   * connected transport would hold the process open.
   */
  const serve = async ({
    config,
    root,
  }: {
    config: OrangerailConfig;
    root: string;
  }): Promise<{ served: Registry; line: string }> => {
    let served: Registry | undefined;
    const mcp = await import('orangerail-mcp');
    vi.spyOn(mcp, 'createMcpServer').mockImplementation((args) => {
      served = args.registry;
      return { server: {} as never, serve: async () => {} };
    });

    let line = '';
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      line += chunk;
      return true;
    }) as typeof process.stderr.write;

    try {
      await runMcp({ config, projectRoot: root });
    } finally {
      process.stderr.write = real;
    }

    if (served === undefined) {
      throw new Error('createMcpServer was never called');
    }

    return { served, line };
  };

  it('withholds only the weakened action, and says so instead of claiming a clean count', async () => {
    const { root, config } = project({ gateDelete: true });
    writeBaseline({
      projectRoot: root,
      postures: actionPostures({ registry: config.registry }),
      recordedBy: 'sync',
    });

    const ungated = project({ gateDelete: false });
    const { served, line } = await serve({ config: ungated.config, root });

    // The tool is not exposed...
    expect(served.listActions().map((action) => action.name)).toEqual(['archiveOrder']);
    // ...and the engine cannot resolve it by name either, so a client that
    // already knew the name cannot execute it.
    expect(served.getAction({ name: 'deleteOrder' })).toBeUndefined();
    // Read tools and every other action are untouched.
    expect(served.listObjects().map((object) => object.name)).toEqual(['Order']);

    expect(line).toContain('GOVERNANCE DRIFT');
    expect(line).toContain('WITHHOLDING deleteOrder');
    expect(line).toContain('Everything else is served normally');
    // Pre-fix this line read `serving · governance active · 1 action(s)
    // approval-gated` while serving the un-gated one. The count now describes
    // what is served AND the clause names what is not.
    expect(line).toContain('serving');
    expect(line).toContain('1 action(s) approval-gated');
    expect(line).toContain('1 action(s) WITHHELD');
  });

  it('serves everything and reports when no baseline is recorded — upgrading never locks you out', async () => {
    const { root, config } = project({ gateDelete: false });

    const { served, line } = await serve({ config, root });

    expect(served.listActions()).toHaveLength(2);
    expect(line).toContain('no governance baseline');
    expect(line).not.toContain('WITHHOLDING');
  });

  it('serves and reports rather than failing closed on a baseline it cannot read', async () => {
    const { root, config } = project({ gateDelete: false });
    writeFileSync(join(root, GOVERNANCE_FILE), '{ not json', 'utf8');

    const { served, line } = await serve({ config, root });

    // Failing closed here buys nothing: deleting the file is always an available
    // downgrade, so it would only cost an operator their server over a typo.
    expect(served.listActions()).toHaveLength(2);
    expect(line).toContain('could not be read');
    expect(line).toContain('CANNOT verify');
  });

  it('serves normally against a matching baseline and adds no noise', async () => {
    const { root, config } = project({ gateDelete: true });
    writeBaseline({
      projectRoot: root,
      postures: actionPostures({ registry: config.registry }),
      recordedBy: 'sync',
    });

    const { served, line } = await serve({ config, root });

    expect(served.listActions()).toHaveLength(2);
    expect(line).not.toContain('DRIFT');
    expect(line).toContain('matches the recorded baseline');
  });
});
