import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

import type {
  AgentFleetSnapshot,
  GraphSnapshot,
  InstanceSnapshot,
} from 'orangerail-studio/snapshot';

import type { UnrenderableField } from '../../render';

/**
 * The instance snapshot as this server serves it: the rows, plus the list of
 * fields inside them the total renderer could not print as they are (ONT-071).
 *
 * The list is OPTIONAL because this server is generic over its caller — a caller
 * that never walked its rows supplies none, and gets the honest empty answer
 * rather than a claim it did not make. `orangerail studio` always supplies it:
 * `gatherInstances` walks the rows where they enter the CLI, so what arrives
 * here is already JSON-safe and its markers are already in place.
 */
type ServedInstances = InstanceSnapshot & { unrenderable?: UnrenderableField[] };

/** Minimal content-type map for the static assets the app ships (plan 3.6). */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** A live SSE subscriber. */
type SseClient = ServerResponse;

/**
 * Max concurrent `/api/events` SSE connections (ONT-016 L-SSE-UNBOUNDED, plan
 * Decision 2). Normal use is one browser tab (occasionally a few); a small
 * double-digit cap refuses a local resource-exhaustion attempt to pin unbounded
 * file descriptors/memory while never blocking real use. Self-heals via the
 * per-connection `req.on('close')` cleanup that frees a slot on disconnect.
 */
const MAX_SSE_CLIENTS = 16;

/** The loopback hostnames a legitimate studio fetch may carry (ONT-016). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * ONT-016 M-DNSREBIND — decide whether a request's `Host` header is a legitimate
 * same-origin loopback fetch for this server. Returns `true` iff `host` is
 * present and parses into `<hostname>:<port>` (or, for IPv6, `[<address>]:<port>`)
 * where the lower-cased hostname is one of the loopback names
 * (`127.0.0.1` / `localhost` / `::1`) AND the port is a strictly all-digit string
 * whose integer value equals `port` (the port the connection actually landed on,
 * read by the caller from `req.socket.localPort`).
 *
 * A missing `Host`, a bare host with no port, a spoofed hostname
 * (`evil.attacker.com`, even with the correct port), a wrong port, or a
 * non-numeric/garbage-suffixed port (`127.0.0.1:PORTevil.com`) all return
 * `false`. The check fails closed: any input it cannot confidently accept is
 * rejected, closing the DNS-rebinding data-exfiltration vector without adding
 * CORS, tokens, or auth (plan Decision 1).
 */
export const isAllowedHost = ({
  host,
  port,
}: {
  host: string | undefined;
  port: number;
}): boolean => {
  if (host === undefined) {
    return false;
  }

  let hostname: string;
  let portPart: string;

  if (host.startsWith('[')) {
    const closing = host.lastIndexOf(']:');

    if (closing === -1) {
      return false;
    }

    hostname = host.slice(1, closing);
    portPart = host.slice(closing + 2);
  } else {
    const colon = host.lastIndexOf(':');

    if (colon === -1) {
      return false;
    }

    hostname = host.slice(0, colon);
    portPart = host.slice(colon + 1);
  }

  if (!LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())) {
    return false;
  }

  if (!/^\d+$/.test(portPart)) {
    return false;
  }

  return Number(portPart) === port;
};

/**
 * Resolve a request path to an absolute file inside `appDir`, or `null` if the
 * (decoded) path would escape the directory — strict containment against
 * traversal (`/../…`), the read-only server posture (AC-7).
 */
export const resolveStaticPath = ({
  appDir,
  urlPath,
}: {
  appDir: string;
  urlPath: string;
}): string | null => {
  let decoded: string;

  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }

  const root = resolve(appDir);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = resolve(root, relative);

  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }

  return resolved;
};

const writeJson = ({
  res,
  status,
  body,
}: {
  res: ServerResponse;
  status: number;
  body: string;
}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
};

/**
 * Serialize a snapshot for a data route without letting it end the process
 * (ONT-071).
 *
 * The instance rows come from a live datasource, and `JSON.stringify` throws on
 * several things a real row carries — a `BigInt` column, a structure that points
 * at itself, a `toJSON` that fails. Thrown from inside a request handler that is
 * an uncaught exception, and an uncaught exception ends `orangerail studio`: a
 * browsable map of the ontology killed by one column of one row.
 *
 * The fix for the instance route is upstream, in `gatherInstances`, which walks
 * the rows through the total renderer as they enter the CLI — so by the time
 * they reach here they are JSON-safe and their markers are already in place, and
 * this catch is unreachable for them. It stays because the two other routes and
 * every other caller of this server have made no such promise, and because "the
 * renderer has no defect" is not something a serving loop should have to assume.
 */
const jsonBody = ({ value }: { value: unknown }): { status: number; body: string } => {
  try {
    return { status: 200, body: JSON.stringify(value) };
  } catch (error) {
    return {
      status: 500,
      body: JSON.stringify({
        error: 'this snapshot could not be serialized',
        reason: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};

/**
 * Build the local studio server: static serving of the prebuilt app with strict
 * path containment, `GET /api/registry` returning the snapshot JSON, and
 * `GET /api/events` as an SSE stream. Any non-GET/HEAD method is 405 — no write
 * route exists at all (AC-7). Bound by the caller to 127.0.0.1 only (plan 3.6).
 * Returns the server plus a `broadcast` for the watcher to push reload events.
 */
export const createStudioServer = ({
  appDir,
  getSnapshot,
  getInstances,
  getFleet,
}: {
  appDir: string;
  getSnapshot: () => GraphSnapshot;
  getInstances: () => ServedInstances;
  getFleet: () => AgentFleetSnapshot;
}): { server: Server; broadcast: (args: { event: string; data: string }) => void } => {
  const clients = new Set<SseClient>();

  const broadcast = ({ event, data }: { event: string; data: string }) => {
    for (const client of clients) {
      client.write(`event: ${event}\ndata: ${data}\n\n`);
    }
  };

  const handleStatic = ({ req, res }: { req: IncomingMessage; res: ServerResponse }) => {
    const filePath = resolveStaticPath({ appDir, urlPath: req.url ?? '/' });

    if (filePath === null || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const type = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    createReadStream(filePath).pipe(res);
  };

  const server = createServer((req, res) => {
    if (!isAllowedHost({ host: req.headers.host, port: req.socket.localPort ?? -1 })) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }

    const path = (req.url ?? '/').split('?')[0];

    if (path === '/api/registry') {
      writeJson({ res, ...jsonBody({ value: getSnapshot() }) });
      return;
    }

    if (path === '/api/instances') {
      const instances = getInstances();

      // `unrenderable` is served explicitly rather than left to ride along as an
      // own property, so the wire contract states it: the rows above may contain
      // markers, and THIS is the list of which ones, derived from the walk.
      writeJson({
        res,
        ...jsonBody({ value: { ...instances, unrenderable: instances.unrenderable ?? [] } }),
      });
      return;
    }

    if (path === '/api/fleet') {
      writeJson({ res, ...jsonBody({ value: getFleet() }) });
      return;
    }

    if (path === '/api/events') {
      if (clients.size >= MAX_SSE_CLIENTS) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Too many connections');
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(':ok\n\n');

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    handleStatic({ req, res });
  });

  return { server, broadcast };
};
