// The forge's HTTP server: one process, Node's http module, no dependencies. It reads the request
// body once (capped), decodes the path, and hands the request to the surface that owns it — REST
// v3, GraphQL v4, MCP, or git smart HTTP — in that order. /healthz is the env's boot probe and
// takes no token; every other surface requires the bearer token from MAKEFUN_SHOP_TOKEN. Anything
// unrouted is a JSON 404, and a handler that throws is a JSON 500 that leaves the server alive.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { makeCtx, sendError, sendJson, type Ctx } from './context.ts';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { ForgeStore } from './store.ts';

/** The largest request body accepted (a push pack is at most a few hundred KiB). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The path of a request URL, decoded, with trailing slashes stripped (except the root). */
function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // A malformed escape stays raw; no route matches it, so it answers a 404.
    }
    while (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return { pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

/** Read the request body whole, up to MAX_BODY_BYTES; null when it is past the cap. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new ForgeStore();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { pathname, query } = pathOf(req);
      const body = await readBody(req);
      const ctx: Ctx = makeCtx(req, res, pathname, query, store, token, body ?? Buffer.alloc(0));
      try {
        if (body === null) {
          sendError(ctx, 413, 'Request body too large');
          return;
        }
        // The env's boot check calls this twice: 200 {"ok":true}, no token.
        if (ctx.method === 'GET' && pathname === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (handleRest(ctx)) return;
        if (handleGraphQL(ctx)) return;
        if (handleMcp(ctx)) return;
        if (handleGit(ctx)) return;
        sendError(ctx, 404, 'Not Found');
      } catch (err) {
        // A handler must never take the server down: answer 500 and stay up.
        if (!res.headersSent) {
          try {
            sendError(ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
          } catch {
            // The peer went away; nothing to write to.
          }
        } else {
          try {
            res.end();
          } catch {
            // Already gone.
          }
        }
      }
    })().catch(() => {
      // The body read itself failed (a dropped connection): nothing to answer.
      try {
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"message":"Bad Request"}\n');
      } catch {
        // Already gone.
      }
    });
  });
}
