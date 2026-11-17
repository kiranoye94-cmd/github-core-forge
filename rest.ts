// REST layer (the /api/v3 surface). Mirrors the GitHub REST v3 endpoints the contest
// probes: repo CRUD, contents, refs, issues, comments and pulls, with GitHub's status
// codes, pagination Link header and JSON error shapes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OWNER, NOW, EXPECTED_TOKEN, repos, namedRepo, branchFiles, cloneFiles, latest,
  digest, makeRepo, createIssue, createPull, mergePull, encodeNode, repoNode,
  key as key_, nextCommentId,
  type Repo, type Branch, type Commit, type FileEntry, type Issue, type Pull,
} from './forge.ts';

let requestSeq = 0;

/** Bearer auth: accepts any bearer when no token is set, else the exact token. */
export function auth(req: IncomingMessage): boolean {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
  const got = m === null ? '' : m[1];
  return got !== '' && (EXPECTED_TOKEN === '' || got === EXPECTED_TOKEN);
}

function headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': `FORGE-${++requestSeq}`, ...extra };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { ...headers(extra), 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, headers());
  res.end();
}

export function error(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > 2_000_000) throw new Error('too large');
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/** Coerce any JSON value into a plain object. */
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// JSON views, shaped the way the GitHub REST API returns each entity.
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, node_id: r.node_id, name: r.name, full_name: r.full_name,
    private: r.private, description: r.description, default_branch: r.default_branch,
    owner: { login: r.owner, id: 1000 }, has_issues: true,
  };
}
function commitJson(c: Commit): Record<string, unknown> {
  return {
    sha: c.sha,
    node_id: encodeNode('Commit', c.sha),
    commit: { message: c.message, author: { name: OWNER, date: NOW } },
    author: { login: OWNER },
  };
}
function issueJson(i: Issue): Record<string, unknown> {
  return {
    id: i.id, node_id: i.node_id, number: i.number, title: i.title, body: i.body,
    state: i.state, labels: i.labels, comments: i.comments.length,
    created_at: NOW, updated_at: NOW, user: { login: OWNER },
  };
}
function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  const head = r.branches.get(p.headName);
  const base = r.branches.get(p.baseName);
  return {
    id: p.id, node_id: p.node_id, number: p.number, title: p.title, body: p.body,
    state: p.state, merged: p.merged, merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    head: { ref: p.headName, sha: latest(head!)?.sha ?? digest('empty') },
    base: { ref: p.baseName, sha: latest(base!)?.sha ?? digest('empty') },
    created_at: NOW, updated_at: NOW, user: { login: OWNER },
  };
}
function contentJson(f: FileEntry): Record<string, unknown> {
  return {
    type: 'file', encoding: 'base64', content: f.content, sha: f.sha,
    size: Buffer.from(f.content, 'base64').length,
    name: f.path.split('/').pop(), path: f.path, url: '',
  };
}

/** Handle one REST request; every path is under /api/v3. */
export async function rest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && path === '/api/v3/meta') return sendJson(res, 200, { installed_version: 'forge-1.0' });
  if (!auth(req)) return error(res, 401, 'Requires authentication');
  if (method === 'GET' && path === '/api/v3/user') {
    return sendJson(res, 200, { login: OWNER, id: 1000, node_id: encodeNode('User', OWNER) });
  }

  let body: Record<string, unknown> = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    try { body = object(await readBody(req)); } catch { return error(res, 400, 'Problems parsing JSON'); }
  }

  // Repo collection under /user/repos.
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const name = String(body.name ?? '').trim();
    if (!name) return error(res, 422, 'Validation Failed');
    const k = key_(OWNER, name);
    if (repos.has(k)) return error(res, 422, 'Repository already exists');
    return sendJson(res, 201, repoJson(makeRepo(body)));
  }
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const all = [...repos.values()].filter((x) => x.owner === OWNER);
    const per = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30)));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const slice = all.slice((page - 1) * per, page * per);
    const extra: Record<string, string> = {};
    if (page * per < all.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      next.searchParams.set('per_page', String(per));
      extra.link = `<${next.toString()}>; rel="next"`;
    }
    return sendJson(res, 200, slice.map(repoJson), extra);
  }

  const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!m) return error(res, 404, 'Not Found');
  const owner = decodeURIComponent(m[1]!), name = decodeURIComponent(m[2]!), tail = m[3] ?? '';
  const r = namedRepo(owner, name);
  if (!r) return error(res, 404, 'Not Found');

  if (!tail) {
    if (method === 'GET') return sendJson(res, 200, repoJson(r));
    if (method === 'PATCH') { if (typeof body.description === 'string') r.description = body.description; return sendJson(res, 200, repoJson(r)); }
    if (method === 'DELETE') { repos.delete(key_(owner, name)); return sendEmpty(res, 204); }
  }

  if (tail === 'labels' && method === 'POST') {
    const label = { name: String(body.name ?? ''), color: String(body.color ?? 'ededed') };
    r.labels.set(label.name, label);
    return sendJson(res, 201, label);
  }
  if (tail === 'git/refs' && method === 'POST') {
    const ref = String(body.ref ?? ''), bn = ref.replace(/^refs\/heads\//, '');
    let source: Branch | undefined;
    for (const b of r.branches.values()) if (latest(b)?.sha === body.sha) source = b;
    if (!source) return error(res, 422, 'Object does not exist');
    const b: Branch = { name: bn, commits: [...source.commits], forkFiles: cloneFiles(branchFiles(source)) };
    r.branches.set(bn, b);
    return sendJson(res, 201, { ref: `refs/heads/${bn}`, object: { sha: String(body.sha), type: 'commit' } });
  }

  let rm = /^git\/refs\/heads\/(.+)$/.exec(tail);
  if (rm && method === 'GET') {
    const b = r.branches.get(decodeURIComponent(rm[1]!));
    if (!b) return error(res, 404, 'Not Found');
    return sendJson(res, 200, { ref: `refs/heads/${b.name}`, object: { sha: latest(b)?.sha ?? digest('empty'), type: 'commit' } });
  }
  if (tail === 'branches' && method === 'GET') {
    return sendJson(res, 200, [...r.branches.values()].map((b) => ({ name: b.name, commit: { sha: latest(b)?.sha ?? digest('empty') } })));
  }
  rm = /^branches\/(.+)$/.exec(tail);
  if (rm && method === 'GET') {
    const b = r.branches.get(decodeURIComponent(rm[1]!));
    if (!b) return error(res, 404, 'Not Found');
    return sendJson(res, 200, { name: b.name, commit: { sha: latest(b)?.sha ?? digest('empty') } });
  }
  if (tail === 'commits' && method === 'GET') {
    const b = r.branches.get(url.searchParams.get('sha') ?? r.default_branch);
    if (!b) return error(res, 404, 'Not Found');
    return sendJson(res, 200, [...b.commits].reverse().map(commitJson));
  }

  const cm = /^contents(?:\/(.*))?$/.exec(tail);
  if (cm) {
    const filePath = decodeURIComponent(cm[1] ?? '');
    const bn = String(body.branch ?? url.searchParams.get('ref') ?? r.default_branch);
    const b = r.branches.get(bn);
    if (!b) return error(res, 404, 'Not Found');
    const files = branchFiles(b);
    if (method === 'GET') {
      const f = files.get(filePath);
      if (f) return sendJson(res, 200, contentJson(f));
      const prefix = filePath ? `${filePath.replace(/\/$/, '')}/` : '';
      const children = new Map<string, Record<string, unknown>>();
      for (const [p, e] of files) {
        if (!p.startsWith(prefix)) continue;
        const rest_ = p.slice(prefix.length), first = rest_.split('/')[0]!;
        if (rest_.includes('/')) children.set(first, { type: 'dir', name: first, path: `${prefix}${first}`, sha: digest('dir', prefix, first) });
        else children.set(first, contentJson(e));
      }
      if (children.size) return sendJson(res, 200, [...children.values()]);
      return error(res, 404, 'Not Found');
    }
    if (method === 'PUT') {
      const old = files.get(filePath);
      const given = typeof body.sha === 'string' ? body.sha : undefined;
      if (old && given !== old.sha) return error(res, 409, 'sha does not match');
      if (!old && given) return error(res, 409, 'sha does not match');
      const content = String(body.content ?? '');
      const sha = digest(Buffer.from(content, 'base64').toString('binary'));
      const next = cloneFiles(files);
      next.set(filePath, { path: filePath, content, sha });
      const csha = digest(r.full_name, bn, String(b.commits.length), String(body.message ?? ''), sha);
      b.commits.push({ sha: csha, message: String(body.message ?? ''), files: next });
      return sendJson(res, old ? 200 : 201, { content: { ...contentJson(next.get(filePath)!), encoding: 'base64' }, commit: { sha: csha, message: String(body.message ?? '') } });
    }
    if (method === 'DELETE') {
      const old = files.get(filePath);
      if (!old) return error(res, 404, 'Not Found');
      if (body.sha !== old.sha) return error(res, 409, 'sha does not match');
      const next = cloneFiles(files);
      next.delete(filePath);
      const csha = digest(r.full_name, bn, 'delete', filePath, String(b.commits.length));
      b.commits.push({ sha: csha, message: String(body.message ?? ''), files: next });
      return sendJson(res, 200, { content: null, commit: { sha: csha } });
    }
  }

  if (tail === 'issues' && method === 'POST') {
    const i = createIssue(r, body);
    if (!i) return error(res, 422, 'Validation Failed');
    return sendJson(res, 201, issueJson(i));
  }
  if (tail === 'issues' && method === 'GET') {
    const state = url.searchParams.get('state') ?? 'open';
    let list = r.issues.filter((i) => state === 'all' || i.state === state);
    if ((url.searchParams.get('direction') ?? 'desc') === 'desc') list = [...list].reverse();
    return sendJson(res, 200, list.map(issueJson));
  }
  let im = /^issues\/(\d+)$/.exec(tail);
  if (im) {
    const i = r.issues.find((x) => x.number === Number(im![1]));
    if (!i) return error(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, issueJson(i));
    if (method === 'PATCH') {
      if (body.state === 'closed' || body.state === 'open') i.state = body.state;
      if (typeof body.title === 'string') i.title = body.title;
      if (typeof body.body === 'string') i.body = body.body;
      return sendJson(res, 200, issueJson(i));
    }
  }
  im = /^issues\/(\d+)\/comments$/.exec(tail);
  if (im) {
    const i = r.issues.find((x) => x.number === Number(im![1]));
    if (!i) return error(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, i.comments);
    if (method === 'POST') {
      const id = nextCommentId();
      const c = { id, node_id: encodeNode('IssueComment', id), body: String(body.body ?? '') };
      i.comments.push(c);
      return sendJson(res, 201, c);
    }
  }

  if (tail === 'pulls' && method === 'POST') {
    const p = createPull(r, body);
    if (!p) return error(res, 422, 'Validation Failed');
    return sendJson(res, 201, pullJson(r, p));
  }
  if (tail === 'pulls' && method === 'GET') {
    const state = url.searchParams.get('state') ?? 'open';
    return sendJson(res, 200, r.pulls.filter((p) => state === 'all' || p.state === state).map((p) => pullJson(r, p)));
  }
  let pm = /^pulls\/(\d+)$/.exec(tail);
  if (pm) {
    const p = r.pulls.find((x) => x.number === Number(pm![1]));
    if (!p) return error(res, 404, 'Not Found');
    return sendJson(res, 200, pullJson(r, p));
  }
  pm = /^pulls\/(\d+)\/files$/.exec(tail);
  if (pm && method === 'GET') {
    const p = r.pulls.find((x) => x.number === Number(pm![1]));
    if (!p) return error(res, 404, 'Not Found');
    return sendJson(res, 200, p.changedPaths.map((filename) => ({
      filename, status: 'added',
      additions: Math.max(1, Buffer.from(branchFiles(r.branches.get(p.headName)!).get(filename)?.content ?? '', 'base64').toString().split('\n').length),
      deletions: 0, changes: 1,
    })));
  }
  pm = /^pulls\/(\d+)\/merge$/.exec(tail);
  if (pm && method === 'PUT') {
    const p = r.pulls.find((x) => x.number === Number(pm![1]));
    if (!p) return error(res, 404, 'Not Found');
    const result = mergePull(r, p);
    if (!result.ok) return error(res, 405, 'Pull Request is not mergeable');
    return sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return error(res, 404, 'Not Found');
}
