// HTTP router: bind the server, then dispatch each request to the REST (/api/v3),
// GraphQL (/api/graphql) or MCP (/mcp) layer. The scorer scores the app this builds.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { rest } from './rest.ts';
import { graphql } from './graphql.ts';
import { mcp } from './mcp.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

function error(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Build the forge HTTP server. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let url: URL;
      try { url = new URL(req.url ?? '/', 'http://entry'); }
      catch { return error(res, 400, 'Bad Request'); }

      if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/v3')) return rest(req, res, url);
      if (req.method === 'POST' && url.pathname === '/api/graphql') return graphql(req, res);
      if (req.method === 'POST' && url.pathname === '/mcp') return mcp(req, res);
      return error(res, 404, 'Not Found');
    })().catch((err: unknown) => {
      if (!res.headersSent) error(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      else res.end();
    });
  });
}
