import { mkdtempSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GraphSnapshot, InstanceSnapshot } from 'orangerail-studio/snapshot';

import { createStudioServer, isAllowedHost, resolveStaticPath } from './server';

const snapshot: GraphSnapshot = {
  objects: [{ name: 'alpha', fields: [], readAccess: 'authenticated', hasResolve: true }],
  links: [],
  actions: [],
};

const instances: InstanceSnapshot = {
  employees: [
    {
      accountId: 'acc_a',
      displayName: 'Ann',
      active: true,
      ticketCount: 4,
      storyPointsTotal: 12,
      complexityMix: { hi: 1, med: 1, lo: 2 },
      medianCycleDaysFirstHalf: 2,
      medianCycleDaysSecondHalf: 1,
      reopenRate: 'unavailable',
      reassignmentsGiven: 0,
      reassignmentsReceived: 0,
      helpGiven: 3,
      helpReceived: 1,
      weekendOffHoursShare: 5,
    },
  ],
  services: [],
  teams: [],
  incidents: [],
  edges: { helps: [{ from: 'acc_a', to: 'acc_a', weight: 1 }], works_on: [], member_of: [] },
};

describe('resolveStaticPath (AC-7 containment)', () => {
  const appDir = '/srv/app';

  it('maps / to index.html', () => {
    expect(resolveStaticPath({ appDir, urlPath: '/' })).toBe(join(appDir, 'index.html'));
  });

  it('keeps in-dir assets', () => {
    expect(resolveStaticPath({ appDir, urlPath: '/assets/app.js' })).toBe(
      join(appDir, 'assets', 'app.js'),
    );
  });

  it('rejects raw and encoded traversal', () => {
    expect(resolveStaticPath({ appDir, urlPath: '/../../package.json' })).toBeNull();
    expect(resolveStaticPath({ appDir, urlPath: '/%2e%2e%2f%2e%2e%2fpackage.json' })).toBeNull();
  });
});

describe('isAllowedHost (ONT-016 M-DNSREBIND allowlist)', () => {
  const port = 4893;

  it('allows the loopback names on the bound port (case-insensitive, incl. IPv6)', () => {
    expect(isAllowedHost({ host: `127.0.0.1:${port}`, port })).toBe(true);
    expect(isAllowedHost({ host: `localhost:${port}`, port })).toBe(true);
    expect(isAllowedHost({ host: `LocalHost:${port}`, port })).toBe(true);
    expect(isAllowedHost({ host: `[::1]:${port}`, port })).toBe(true);
  });

  it('denies a missing Host header', () => {
    expect(isAllowedHost({ host: undefined, port })).toBe(false);
  });

  it('denies a spoofed hostname regardless of port', () => {
    expect(isAllowedHost({ host: 'evil.attacker.com', port })).toBe(false);
    expect(isAllowedHost({ host: `evil.attacker.com:${port}`, port })).toBe(false);
  });

  it('denies a bare loopback host with no port', () => {
    expect(isAllowedHost({ host: '127.0.0.1', port })).toBe(false);
    expect(isAllowedHost({ host: 'localhost', port })).toBe(false);
  });

  it('denies a loopback host on the wrong port', () => {
    expect(isAllowedHost({ host: `127.0.0.1:1`, port })).toBe(false);
    expect(isAllowedHost({ host: `localhost:${port + 1}`, port })).toBe(false);
  });

  it('denies a non-loopback IPv6 address', () => {
    expect(isAllowedHost({ host: `[2001:db8::1]:${port}`, port })).toBe(false);
  });

  it('denies a garbage-suffixed (non-all-digit) port', () => {
    expect(isAllowedHost({ host: `127.0.0.1:${port}evil.com`, port })).toBe(false);
    expect(isAllowedHost({ host: `127.0.0.1:${port}abc`, port })).toBe(false);
  });
});

describe('createStudioServer (plan section 3.6)', () => {
  let server: Server;
  let broadcast: (args: { event: string; data: string }) => void;
  let base: string;

  beforeAll(async () => {
    const appDir = mkdtempSync(join(tmpdir(), 'ont-005-app-'));
    writeFileSync(join(appDir, 'index.html'), '<h1>studio ok</h1>', 'utf8');

    const built = createStudioServer({
      appDir,
      getSnapshot: () => snapshot,
      getInstances: () => instances,
    });
    server = built.server;
    broadcast = built.broadcast;

    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  const raw = ({ method, path }: { method: string; path: string }) =>
    new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((resolve, reject) => {
      const url = new URL(base);
      const req = request({ host: url.hostname, port: url.port, method, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('serves the registry snapshot as JSON', async () => {
    const res = await raw({ method: 'GET', path: '/api/registry' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).objects[0].name).toBe('alpha');
  });

  it('rejects any write method with 405', async () => {
    const res = await raw({ method: 'POST', path: '/api/registry' });
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
  });

  it('serves the instance snapshot as JSON', async () => {
    const res = await raw({ method: 'GET', path: '/api/instances' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.employees[0].accountId).toBe('acc_a');
    expect(body.edges.helps.length).toBe(1);
  });

  it('rejects a non-GET to the instances route with 405 (read-only)', async () => {
    const res = await raw({ method: 'POST', path: '/api/instances' });
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
  });

  it('serves the static index with a content type', async () => {
    const res = await raw({ method: 'GET', path: '/' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('studio ok');
  });

  it('404s an unknown or traversal path', async () => {
    expect((await raw({ method: 'GET', path: '/missing.js' })).status).toBe(404);
    expect((await raw({ method: 'GET', path: '/%2e%2e%2fpackage.json' })).status).toBe(404);
  });

  it('opens an SSE stream and delivers a broadcast', async () => {
    const url = new URL(base);

    const received = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, method: 'GET', path: '/api/events' },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');

          res.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            if (text.includes('event: change')) {
              req.destroy();
              resolve(text);
            }
          });
        },
      );
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
          reject(err);
        }
      });
      req.end();

      setTimeout(() => broadcast({ event: 'change', data: '1' }), 100);
    });

    expect(received).toContain('event: change');
  });

  const rawWithHost = ({ path, host }: { path: string; host: string }) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const url = new URL(base);
      const req = request(
        { host: url.hostname, port: url.port, method: 'GET', path, headers: { host } },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('rejects a spoofed Host with 403 on /api/registry and /api/instances (M-DNSREBIND)', async () => {
    expect((await rawWithHost({ path: '/api/registry', host: 'evil.attacker.com' })).status).toBe(
      403,
    );
    expect((await rawWithHost({ path: '/api/instances', host: 'evil.attacker.com' })).status).toBe(
      403,
    );
  });

  it('rejects a loopback Host on the wrong port with 403', async () => {
    expect((await rawWithHost({ path: '/api/registry', host: '127.0.0.1:1' })).status).toBe(403);
  });

  it('still serves loopback fetches (localhost + 127.0.0.1) with 200', async () => {
    const url = new URL(base);
    expect(
      (await rawWithHost({ path: '/api/registry', host: `127.0.0.1:${url.port}` })).status,
    ).toBe(200);
    expect(
      (await rawWithHost({ path: '/api/registry', host: `localhost:${url.port}` })).status,
    ).toBe(200);
  });

  it('caps SSE connections: the (MAX+1)th /api/events connection is 503 (L-SSE-UNBOUNDED)', async () => {
    const MAX_SSE_CLIENTS = 16;
    const url = new URL(base);

    const openSse = () =>
      new Promise<{ status: number; req: ReturnType<typeof request> }>((resolve, reject) => {
        const req = request(
          { host: url.hostname, port: url.port, method: 'GET', path: '/api/events' },
          (res) => {
            res.on('data', () => {});
            resolve({ status: res.statusCode ?? 0, req });
          },
        );
        req.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
            reject(err);
          }
        });
        req.end();
      });

    const opened: Array<ReturnType<typeof request>> = [];

    try {
      for (let i = 0; i < MAX_SSE_CLIENTS; i += 1) {
        const handle = await openSse();
        opened.push(handle.req);
        expect(handle.status).toBe(200);
      }

      const overflow = await openSse();
      overflow.req.destroy();
      expect(overflow.status).toBe(503);
    } finally {
      for (const req of opened) {
        req.destroy();
      }
    }

    // Self-healing: after releasing the admitted clients a new connection is 200.
    await new Promise((done) => setTimeout(done, 200));
    const afterFree = await openSse();
    expect(afterFree.status).toBe(200);
    afterFree.req.destroy();
  });
});
