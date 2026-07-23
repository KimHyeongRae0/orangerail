/**
 * ONT-016 e2e driver — studio server hardening (ticket section 5, plan section 7).
 *
 * Pure Node stdlib only. NO agent-browser, NO Playwright: every ONT-016 defense
 * is observable at the HTTP layer, so this driver speaks raw HTTP/1.1 over the
 * `net` module. Raw sockets are used (rather than `http.request`) so the driver
 * has full control of the `Host` header — the browser sets `Host` to the page
 * origin and JS cannot override it, so the DNS-rebind vector is exactly a request
 * whose `Host` is the attacker's hostname while the connection lands on the
 * loopback port. Reproducing that requires writing the header by hand.
 *
 * It launches the SHIPPED `orangerail studio --no-open --port <fixed> --config …`
 * against the ONT-005 fixture ontology (which serves a non-empty `/api/registry`
 * and a `/api/instances` snapshot) and probes it.
 *
 * ── PHASES (mapped to AC-1..AC-6) ────────────────────────────────────────────
 *   Phase 1 (AC-1, M-DNSREBIND): a `Host: evil.attacker.com` request to
 *     `/api/registry` and `/api/instances` must be 403; a legitimate loopback
 *     Host (`127.0.0.1:<port>`, `localhost:<port>`) must still be 200; a wrong
 *     port, a bare host, and an attacker host with the right port must be 403.
 *   Phase 2 (AC-2, L-SSE-UNBOUNDED): opening more than MAX_SSE_CLIENTS concurrent
 *     `/api/events` connections — the ones past the cap must be 503, the first N
 *     stream, and a slot frees when a client disconnects (self-healing).
 *   Phase 3 (AC-3, L-SSE-PATHLEAK): forcing a reload error — the `reload-error`
 *     SSE payload must contain NO absolute config path.
 *   Phase 4 (AC-4 regression): a path-traversal request still 404s, a POST still
 *     405s, and the server is bound to 127.0.0.1 (a loopback connect + read works).
 *   Phase 5 (AC-5): a legitimate config touch still delivers a `change` event over
 *     `/api/events` to a loopback client (live reload unbroken).
 *
 * ── RED (pre-implementation) ─────────────────────────────────────────────────
 *   Against the current server, Phase 1's `Host: evil.attacker.com` requests
 *   return 200 (no Host allowlist), Phase 2's excess SSE connections all return
 *   200 (no cap), and Phase 3's `reload-error` payload contains the absolute
 *   config path (raw message broadcast). Phases 4 and 5 pass today AND after.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-005', 'config.mjs');
const RUN_DIR = join(ROOT, '.docs', 'scratch', 'ont-016-run');
const RUN_CONFIG = join(RUN_DIR, 'orangerail.config.mjs');

const PORT = 4893;
const BASE = `http://127.0.0.1:${PORT}`;

// Must match the server's SSE cap (plan Decision 2, MAX_SSE_CLIENTS = 16). The
// driver opens MAX + OVERFLOW connections and expects the first MAX to stream
// and the OVERFLOW past the cap to be refused with 503.
const MAX_SSE_CLIENTS = 16;
const SSE_OVERFLOW = 4;

const fail = ({ message }) => {
  console.error(`ONT-016 e2e FAIL: ${message}`);
  throw new Error(message);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse the numeric status code out of an HTTP/1.x status line. */
const parseStatus = ({ line }) => {
  const match = (line ?? '').match(/HTTP\/1\.[01]\s+(\d{3})/);
  return match ? Number(match[1]) : 0;
};

/**
 * One raw HTTP/1.1 request with a caller-controlled Host header, returning the
 * full response once the connection closes. `host: undefined` omits the Host
 * header entirely (the missing-Host case); any string is sent verbatim so the
 * attacker/spoofed cases can be reproduced exactly.
 */
const httpOnce = ({ method = 'GET', path, host }) =>
  new Promise((resolve) => {
    const socket = connect(PORT, '127.0.0.1', () => {
      let message = `${method} ${path} HTTP/1.1\r\n`;

      if (host !== undefined) {
        message += `Host: ${host}\r\n`;
      }

      message += 'Connection: close\r\n\r\n';
      socket.write(message);
    });

    let buffer = '';
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    socket.on('close', () => {
      resolve({ status: parseStatus({ line: buffer.split('\r\n')[0] }), raw: buffer });
    });
    socket.on('error', () => resolve({ status: 0, raw: buffer }));
  });

/**
 * Open a persistent `/api/events` connection and resolve as soon as the status
 * line arrives, WITHOUT ending the request — the socket stays open (this is how
 * unbounded SSE connections pin server resources). The returned handle exposes
 * the live receive buffer and the socket for later inspection / teardown.
 */
const openSse = ({ host }) =>
  new Promise((resolve) => {
    const socket = connect(PORT, '127.0.0.1', () => {
      let message = 'GET /api/events HTTP/1.1\r\n';

      if (host !== undefined) {
        message += `Host: ${host}\r\n`;
      }

      // No `Connection: close` — the SSE stream is meant to stay open.
      message += '\r\n';
      socket.write(message);
    });

    let buffer = '';
    let settled = false;

    const settle = ({ status }) => {
      if (!settled) {
        settled = true;
        resolve({ status, socket, getBuffer: () => buffer });
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString();

      if (buffer.includes('\r\n')) {
        settle({ status: parseStatus({ line: buffer.split('\r\n')[0] }) });
      }
    });
    socket.on('close', () => settle({ status: parseStatus({ line: buffer.split('\r\n')[0] }) }));
    socket.on('error', () => settle({ status: 0 }));
  });

/** Poll an SSE handle's receive buffer until the named event arrives; return its data. */
const waitForSseEvent = async ({ sse, event, timeoutMs = 15_000 }) => {
  const pattern = new RegExp(`event: ${event}\\ndata: (.*)`);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const match = sse.getBuffer().match(pattern);

    if (match) {
      return match[1];
    }

    if (Date.now() > deadline) {
      fail({ message: `timed out waiting for SSE event "${event}"` });
    }

    await sleep(250);
  }
};

/** Poll a predicate until it returns truthy or the timeout elapses. */
const waitFor = async ({ label, fn, timeoutMs = 30_000, intervalMs = 500 }) => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let value;

    try {
      value = await fn();
    } catch {
      value = undefined;
    }

    if (value) {
      return value;
    }

    if (Date.now() > deadline) {
      fail({ message: `timed out waiting for: ${label}` });
    }

    await sleep(intervalMs);
  }
};

/** Start the studio server in the run dir; resolve once /api/registry answers 200. */
const startStudio = async () => {
  const child = spawn(
    'node',
    [CLI, 'studio', '--config', 'orangerail.config.mjs', '--port', String(PORT), '--no-open'],
    { cwd: RUN_DIR, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] },
  );

  let exitedEarly = false;
  child.on('exit', () => {
    exitedEarly = true;
  });

  await waitFor({
    label: 'studio /api/registry to answer 200',
    timeoutMs: 30_000,
    fn: async () => {
      if (exitedEarly) {
        fail({ message: 'studio process exited before the server came up' });
      }

      const res = await fetch(`${BASE}/api/registry`).catch(() => undefined);
      return res && res.status === 200;
    },
  });

  return child;
};

const stopStudio = async ({ child }) => {
  child.kill('SIGTERM');
  await waitFor({
    label: 'studio process to exit',
    timeoutMs: 10_000,
    fn: () => child.exitCode !== null || child.signalCode !== null,
  });
};

const main = async () => {
  // ---- Setup: seed run dir with the shipped ONT-005 fixture ontology ----
  console.log('Setup: seed run dir with the ONT-005 fixture config');
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });

  const goodConfig = readFileSync(FIXTURE, 'utf8');
  writeFileSync(RUN_CONFIG, goodConfig, 'utf8');

  const child = await startStudio();
  const openSockets = [];

  try {
    // ---- Phase 1 (AC-1): Host-header allowlist blocks DNS rebinding ----
    console.log('Phase 1 (AC-1): Host-header allowlist');

    const evilRegistry = await httpOnce({ path: '/api/registry', host: 'evil.attacker.com' });
    assert({
      ok: evilRegistry.status === 403,
      message: `AC-1: GET /api/registry with Host: evil.attacker.com must be 403 (got ${evilRegistry.status}) — DNS-rebind Host allowlist absent`,
    });

    const evilInstances = await httpOnce({ path: '/api/instances', host: 'evil.attacker.com' });
    assert({
      ok: evilInstances.status === 403,
      message: `AC-1: GET /api/instances with Host: evil.attacker.com must be 403 (got ${evilInstances.status}) — DNS-rebind Host allowlist absent`,
    });

    const evilRightPort = await httpOnce({
      path: '/api/registry',
      host: `evil.attacker.com:${PORT}`,
    });
    assert({
      ok: evilRightPort.status === 403,
      message: `AC-1: Host: evil.attacker.com:${PORT} (attacker host, correct port) must be 403 (got ${evilRightPort.status})`,
    });

    const wrongPort = await httpOnce({ path: '/api/registry', host: `127.0.0.1:1` });
    assert({
      ok: wrongPort.status === 403,
      message: `AC-1: Host: 127.0.0.1:1 (loopback host, wrong port) must be 403 (got ${wrongPort.status})`,
    });

    const bareHost = await httpOnce({ path: '/api/registry', host: '127.0.0.1' });
    assert({
      ok: bareHost.status === 403,
      message: `AC-1: Host: 127.0.0.1 (loopback host, no port) must be 403 (got ${bareHost.status})`,
    });

    const missingHost = await httpOnce({ path: '/api/registry', host: undefined });
    assert({
      ok: missingHost.status !== 200,
      message: `AC-1: a request with no Host header must be rejected, not 200 (got ${missingHost.status})`,
    });

    // Legitimate loopback fetches still succeed (the studio's own requests).
    const okRegistry = await httpOnce({ path: '/api/registry', host: `127.0.0.1:${PORT}` });
    assert({
      ok: okRegistry.status === 200,
      message: `AC-1: GET /api/registry with Host: 127.0.0.1:${PORT} must still be 200 (got ${okRegistry.status})`,
    });

    const okInstances = await httpOnce({ path: '/api/instances', host: `127.0.0.1:${PORT}` });
    assert({
      ok: okInstances.status === 200,
      message: `AC-1: GET /api/instances with Host: 127.0.0.1:${PORT} must still be 200 (got ${okInstances.status})`,
    });

    const okLocalhost = await httpOnce({ path: '/api/registry', host: `localhost:${PORT}` });
    assert({
      ok: okLocalhost.status === 200,
      message: `AC-1: GET /api/registry with Host: localhost:${PORT} must still be 200 (got ${okLocalhost.status})`,
    });

    // ---- Phase 2 (AC-2): SSE connections are bounded ----
    console.log(
      `Phase 2 (AC-2): SSE cap — open ${MAX_SSE_CLIENTS + SSE_OVERFLOW} connections, expect ${MAX_SSE_CLIENTS} accepted then 503`,
    );

    const sseStatuses = [];
    for (let i = 0; i < MAX_SSE_CLIENTS + SSE_OVERFLOW; i += 1) {
      const handle = await openSse({ host: `127.0.0.1:${PORT}` });
      openSockets.push(handle.socket);
      sseStatuses.push(handle.status);
    }

    const acceptedPrefix = sseStatuses.slice(0, MAX_SSE_CLIENTS);
    assert({
      ok: acceptedPrefix.every((status) => status === 200),
      message: `AC-2: the first ${MAX_SSE_CLIENTS} SSE connections must stream (200); got [${acceptedPrefix.join(', ')}]`,
    });

    const overflow = sseStatuses.slice(MAX_SSE_CLIENTS);
    assert({
      ok: overflow.every((status) => status === 503),
      message: `AC-2: SSE connections past the cap of ${MAX_SSE_CLIENTS} must be refused with 503; got [${overflow.join(', ')}] — no SSE cap enforced`,
    });

    // Self-healing: closing an admitted client frees a slot for a new connection.
    openSockets[0].destroy();
    await sleep(1000);

    const afterFree = await openSse({ host: `127.0.0.1:${PORT}` });
    openSockets.push(afterFree.socket);
    assert({
      ok: afterFree.status === 200,
      message: `AC-2: a new SSE connection must succeed after a slot frees (got ${afterFree.status})`,
    });

    // Release every Phase-2 socket so the cap does not starve later phases.
    for (const socket of openSockets) {
      socket.destroy();
    }
    openSockets.length = 0;
    await sleep(1000);

    // ---- Phase 3 (AC-3): reload errors do not leak filesystem paths ----
    console.log('Phase 3 (AC-3): reload-error payload carries no absolute path');

    const errorSse = await openSse({ host: `127.0.0.1:${PORT}` });
    openSockets.push(errorSse.socket);
    assert({
      ok: errorSse.status === 200,
      message: `AC-3: could not open a loopback SSE client (got ${errorSse.status})`,
    });

    // Break the config so the watcher's reload throws with the absolute path in
    // its message (`config <abs path> must default-export { registry }`).
    writeFileSync(RUN_CONFIG, 'export default {};\n', 'utf8');

    const reloadErrorData = await waitForSseEvent({ sse: errorSse, event: 'reload-error' });
    assert({
      ok: !reloadErrorData.includes(RUN_DIR),
      message: `AC-3: reload-error payload must not contain the absolute config path; leaked run dir in: ${reloadErrorData}`,
    });
    assert({
      ok: !/\.mjs/.test(reloadErrorData),
      message: `AC-3: reload-error payload must not contain a config file path; leaked ".mjs" in: ${reloadErrorData}`,
    });

    errorSse.socket.destroy();
    openSockets.length = 0;

    // Restore the good config so live reload works for Phase 5.
    writeFileSync(RUN_CONFIG, goodConfig, 'utf8');
    await sleep(500);

    // ---- Phase 4 (AC-4 regression): sound defenses preserved ----
    console.log('Phase 4 (AC-4): traversal 404, POST 405, 127.0.0.1 bind');

    const traversalEncoded = await httpOnce({
      path: '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      host: `127.0.0.1:${PORT}`,
    });
    assert({
      ok: traversalEncoded.status === 404,
      message: `AC-4: URL-encoded traversal path must still be 404 (got ${traversalEncoded.status})`,
    });

    const traversalRaw = await httpOnce({
      path: '/../../../etc/passwd',
      host: `127.0.0.1:${PORT}`,
    });
    assert({
      ok: traversalRaw.status === 404,
      message: `AC-4: raw traversal path must still be 404 (got ${traversalRaw.status})`,
    });

    const post = await httpOnce({
      method: 'POST',
      path: '/api/registry',
      host: `127.0.0.1:${PORT}`,
    });
    assert({
      ok: post.status === 405,
      message: `AC-4: POST /api/registry must still be 405 (got ${post.status})`,
    });

    // The server is bound to 127.0.0.1: a loopback connect + read succeeds.
    const boundCheck = await httpOnce({ path: '/api/registry', host: `127.0.0.1:${PORT}` });
    assert({
      ok: boundCheck.status === 200,
      message: `AC-4: the server must be reachable on 127.0.0.1 (got ${boundCheck.status})`,
    });

    // ---- Phase 5 (AC-5): live reload still works ----
    console.log('Phase 5 (AC-5): a legitimate config touch delivers a change event');

    const reloadSse = await openSse({ host: `localhost:${PORT}` });
    openSockets.push(reloadSse.socket);
    assert({
      ok: reloadSse.status === 200,
      message: `AC-5: could not open a loopback SSE client for live reload (got ${reloadSse.status})`,
    });

    writeFileSync(RUN_CONFIG, `${goodConfig}\n// touch ${Date.now()}\n`, 'utf8');

    const changeData = await waitForSseEvent({
      sse: reloadSse,
      event: 'change',
      timeoutMs: 25_000,
    });
    assert({
      ok: typeof changeData === 'string',
      message: 'AC-5: a legitimate config touch must deliver a change event over /api/events',
    });

    reloadSse.socket.destroy();
    openSockets.length = 0;

    console.log('Phase 6: clean shutdown');
    await stopStudio({ child });
  } catch (err) {
    for (const socket of openSockets) {
      socket.destroy();
    }
    child.kill('SIGKILL');
    throw err;
  }

  rmSync(RUN_DIR, { recursive: true, force: true });
  console.log('ONT-016 studio server-hardening scenario: all assertions passed');
};

await main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
