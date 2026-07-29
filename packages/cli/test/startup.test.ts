import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore, createRegistry } from 'orangerail-core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { OrangerailConfig } from '../src/config';
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
