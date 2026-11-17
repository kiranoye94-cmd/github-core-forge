// MCP layer (POST /mcp): JSON-RPC 2.0 over HTTP. Serves server/discover, initialize,
// notifications/initialized, tools/list and tools/call, mapping each tool onto the same
// forge operations the REST and GraphQL layers use.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { repos, namedRepo, makeRepo, createIssue, createPull, mergePull, key, OWNER } from './forge.ts';
import { auth, error, object } from './rest.ts';

/** The tools this forge server exposes over MCP. */
const TOOLS = [
  { name: 'create_repo', description: 'Create a repository',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
] as const;

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Run one tool by name; null means a required argument was missing. */
function toolCall(name: string, a: Record<string, unknown>): unknown {
  const required: Record<string, string[]> = {
    create_repo: ['name'], get_repo: ['owner', 'repo'], create_issue: ['owner', 'repo', 'title'],
    list_issues: ['owner', 'repo'], create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'],
  };
  if (!required[name] || required[name]!.some((x) => a[x] === undefined)) return null;

  if (name === 'create_repo') {
    const n = String(a.name);
    if (repos.has(key(OWNER, n))) return repoView(repos.get(key(OWNER, n))!);
    return repoView(makeRepo(a));
  }
  const r = namedRepo(String(a.owner), String(a.repo));
  if (!r) return { message: 'Not Found' };
  if (name === 'get_repo') return repoView(r);
  if (name === 'create_issue') { const i = createIssue(r, a); return i ? issueView(i) : { message: 'Validation Failed' }; }
  if (name === 'list_issues') return r.issues.filter((i) => !a.state || a.state === 'all' || i.state === a.state).map(issueView);
  if (name === 'create_pull_request') { const p = createPull(r, a); return p ? pullView(r, p) : { message: 'Validation Failed' }; }
  const p = r.pulls.find((x) => x.number === Number(a.pull_number));
  if (!p) return { message: 'Not Found' };
  const m = mergePull(r, p);
  return { merged: m.ok, sha: m.sha, pull_number: p.number };
}

// Thin JSON views for the tool results.
function repoView(r: { id: number; node_id: string; name: string; full_name: string; private: boolean; description: string; default_branch: string; owner: string }): Record<string, unknown> {
  return { id: r.id, node_id: r.node_id, name: r.name, full_name: r.full_name, private: r.private, description: r.description, default_branch: r.default_branch, owner: { login: r.owner } };
}
function issueView(i: { id: number; node_id: string; number: number; title: string; body: string; state: string; labels: unknown[]; comments: unknown[] }): Record<string, unknown> {
  return { id: i.id, node_id: i.node_id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels, comments: i.comments.length };
}
function pullView(r: { full_name: string }, p: { id: number; node_id: string; number: number; title: string; state: string; merged: boolean; merged_at: string | null; merge_commit_sha: string | null; headName: string; baseName: string }): Record<string, unknown> {
  return { id: p.id, node_id: p.node_id, number: p.number, title: p.title, state: p.state, merged: p.merged, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha, head: { ref: p.headName }, base: { ref: p.baseName } };
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** Handle one POST /mcp request. */
export async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let b: Record<string, unknown>;
  try { b = object(JSON.parse(raw)); } catch { return sendJson(res, 400, rpcError(null, -32700, 'Parse error')); }
  const id = b.id;
  const method = String(b.method ?? '');
  const params = object(b.params);

  if (method === 'tools/call' && !auth(req)) return error(res, 401, 'Requires authentication');

  if (method === 'server/discover') {
    return sendJson(res, 200, rpcResult(id, {
      resultType: 'serverInfo',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-forge', version: '1.0.0' } },
    }));
  }
  if (method === 'initialize') {
    return sendJson(res, 200, rpcResult(id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'github-core-forge', version: '1.0.0' } }));
  }
  if (method === 'notifications/initialized') {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }
  if (method === 'tools/list') return sendJson(res, 200, rpcResult(id, { tools: TOOLS }));

  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = object(params.arguments);
    if (!TOOLS.some((t) => t.name === name)) return sendJson(res, 200, rpcError(id, -32602, 'Unknown tool'));
    const result = toolCall(name, args);
    if (result === null) return sendJson(res, 200, rpcError(id, -32602, 'Missing required arguments'));
    return sendJson(res, 200, rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }));
  }

  return sendJson(res, 200, rpcError(id, -32601, 'Method not found'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}
