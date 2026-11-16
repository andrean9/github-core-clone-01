// The per-request context every surface handler shares: the raw request, the parsed route, the
// store, the expected bearer token, and the JSON answer helpers. All JSON replies carry the
// deterministic X-GitHub-Request-Id header; errors are always {message: string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeStore } from './store.ts';
import { nextRequestId } from './util.ts';

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  /** The decoded request path (no query string). */
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly store: ForgeStore;
  /** The bearer token the env expects (MAKEFUN_SHOP_TOKEN; '' when unset in local runs). */
  readonly token: string;
  /** The raw request body, already read. */
  readonly body: Buffer;
  readonly requestId: string;
}

export function makeCtx(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  store: ForgeStore,
  token: string,
  body: Buffer,
): Ctx {
  return {
    req,
    res,
    method: req.method ?? 'GET',
    pathname,
    query,
    store,
    token,
    body,
    requestId: nextRequestId(),
  };
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body. `headers` go beside the JSON ones and the request id. */
export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(text);
}

/** Answer with an empty body and a status (204): still carries the request id. */
export function sendEmpty(ctx: Ctx, status: number, headers: Readonly<Record<string, string>> = {}): void {
  ctx.res.writeHead(status, { 'x-github-request-id': ctx.requestId, ...headers });
  ctx.res.end();
}

/** Answer with a GitHub-shaped JSON error body. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/**
 * Whether the request carries the expected bearer token. When the env set no token (a local run),
 * any non-empty bearer token is accepted — the 401 checks still exercise the missing-token path.
 */
export function isAuthorized(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (ctx.token === '') return true;
  return presented === ctx.token;
}

/** Send the 401 a missing or wrong token earns, and answer false; true when authorized. */
export function requireAuth(ctx: Ctx): boolean {
  if (isAuthorized(ctx)) return true;
  sendError(ctx, 401, 'Bad credentials');
  return false;
}

/**
 * Parse the request body as JSON. An empty body is {}; malformed JSON sends a 400 and answers null.
 */
export function parseJsonBody(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendError(ctx, 400, 'Problems parsing JSON');
    return null;
  }
}
