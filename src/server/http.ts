/**
 * The dashboard server: node:http bound to loopback, a small JSON API under /api, and the built
 * web app from web/dist. State-changing requests must come from the page itself: same-origin
 * Origin header, JSON content type, and the per-process CSRF token fetched from /api/session.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';

import {
  NotFoundError,
  OwnershipError,
  ToolError,
  UsageError,
  ValidationError,
  WorkflowError,
} from '../core/errors.ts';
import { webDistDir } from '../core/paths.ts';
import type { Store } from '../storage/client.ts';
import { act, artifactContent, assertJobId, board, detail, repos } from './api.ts';
import type { ApiError, SessionInfo } from './types.ts';

export const DEFAULT_PORT = 4777;
const HOST = '127.0.0.1';
const BODY_LIMIT = 64 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export interface ServerOptions {
  store: Store;
  port?: number | undefined;
  /** Directory of the built web app; defaults to <install root>/web/dist. */
  webRoot?: string | undefined;
}

export interface RunningServer {
  server: Server;
  url: string;
  port: number;
  csrf: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

function statusFor(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof UsageError) return 400;
  if (err instanceof OwnershipError || err instanceof WorkflowError) return 409;
  if (err instanceof ValidationError) return 422;
  if (err instanceof ToolError) return 502;
  return 500;
}

/** Percent-decode a URL path segment; malformed escapes are the client's fault, not ours. */
function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, 'Malformed URL encoding');
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    let overflow = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Keep draining so the client gets a proper 413 instead of a reset connection.
      if (size > BODY_LIMIT) overflow = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { store } = opts;
  const webRoot = resolve(opts.webRoot ?? webDistDir());
  const csrf = randomBytes(24).toString('hex');
  let allowedOrigins = new Set<string>();

  const isSameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    return origin !== undefined && allowedOrigins.has(origin);
  };

  const guardHost = (req: IncomingMessage) => {
    // Defeats DNS rebinding: the page must have been loaded from this loopback address.
    const host = req.headers.host ?? '';
    if (!allowedOrigins.has(`http://${host}`)) throw new HttpError(400, `Unexpected Host: ${host}`);
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new HttpError(403, 'Cross-site requests are not allowed');
    }
  };

  const guardMutation = (req: IncomingMessage) => {
    if (!isSameOrigin(req)) throw new HttpError(403, 'Missing or foreign Origin header');
    const type = req.headers['content-type'] ?? '';
    if (!type.startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    if (req.headers['x-orch-csrf'] !== csrf) throw new HttpError(403, 'Invalid CSRF token');
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    if (!existsSync(webRoot)) {
      send(res, 503, {
        error: {
          type: 'NotBuilt',
          message: `Dashboard assets not found at ${webRoot}. Run: npm run build`,
        },
      });
      return;
    }
    const decoded = decode(pathname);
    let file = normalize(join(webRoot, decoded));
    const inside = file === webRoot || file.startsWith(webRoot + sep);
    if (!inside) throw new HttpError(404, 'Not found');
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // Single-page app: unknown extension-less paths load the shell.
      if (extname(decoded) !== '') throw new HttpError(404, 'Not found');
      file = join(webRoot, 'index.html');
      if (!existsSync(file)) throw new HttpError(404, 'Not found');
    }
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(readFileSync(file));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      serveStatic(req, res, path);
      return;
    }
    guardHost(req);
    const parts = path.slice(5).split('/').filter(Boolean);
    const [root, id, sub, ...rest] = parts;

    if (method === 'GET') {
      if (root === 'session' && !id) {
        // The token is only useful to the page; a foreign page cannot read this response.
        if (req.headers.origin !== undefined && !isSameOrigin(req)) {
          throw new HttpError(403, 'Foreign origin');
        }
        const info: SessionInfo = { csrf };
        send(res, 200, info);
        return;
      }
      if (root === 'repos' && !id) {
        send(res, 200, repos(store));
        return;
      }
      if (root === 'jobs' && !id) {
        const repo = url.searchParams.get('repo') ?? undefined;
        if (repo !== undefined && repo.length > 200) throw new HttpError(400, 'repo too long');
        send(res, 200, board(store, { repo }));
        return;
      }
      if (root === 'jobs' && id && !sub) {
        send(res, 200, detail(store, assertJobId(id)));
        return;
      }
      if (root === 'jobs' && id && sub === 'artifacts' && rest.length > 0) {
        const rel = rest.map(decode).join('/');
        if (rel.split('/').some((p) => p === '..' || p === '' || p === '.')) {
          throw new HttpError(400, 'Bad artifact path');
        }
        const text = artifactContent(store, assertJobId(id), rel);
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(text);
        return;
      }
      throw new HttpError(404, 'Not found');
    }
    if (method === 'POST') {
      guardMutation(req);
      if (root === 'jobs' && id && sub === 'actions' && rest.length === 0) {
        const body = await readBody(req);
        send(res, 200, act(store, assertJobId(id), body));
        return;
      }
      throw new HttpError(404, 'Not found');
    }
    throw new HttpError(405, 'Method not allowed');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = statusFor(err);
      const body: ApiError = {
        error: {
          type: err instanceof Error ? err.name : 'Error',
          message:
            status === 500 ? 'Internal error' : err instanceof Error ? err.message : String(err),
        },
      };
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, body);
      else res.end();
    });
  });
  server.requestTimeout = 30_000;

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_PORT, HOST, () => {
      const { port } = server.address() as AddressInfo;
      allowedOrigins = new Set([
        `http://${HOST}:${String(port)}`,
        `http://localhost:${String(port)}`,
      ]);
      resolvePromise({
        server,
        port,
        url: `http://${HOST}:${String(port)}/`,
        csrf,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
