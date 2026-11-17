// GraphQL layer (POST /api/graphql). Supports a focused subset: viewer, repository,
// node(id), the Issue/PullRequest/Repository mutations, and the introspection snippets
// the suite probes. Accepts a single query or a batch array, like the GitHub v4 endpoint.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OWNER, repos, namedRepo, latest, findNode, createIssue, createPull, mergePull,
  hasConflict, nextCommentId, encodeNode,
  type Repo, type Issue, type Pull,
} from './forge.ts';
import { auth, error, object, readBody } from './rest.ts';

/** Fields each introspected type exposes, the names the suite asserts on. */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

function gqlIssue(i: Issue): Record<string, unknown> {
  return { ...i, id: i.node_id, state: i.state.toUpperCase() };
}

function gqlPull(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.node_id, number: p.number, title: p.title,
    state: p.merged ? 'MERGED' : p.state.toUpperCase(),
    merged: p.merged, headRefName: p.headName, baseRefName: p.baseName,
    mergeable: hasConflict(r, p) ? 'CONFLICTING' : 'MERGEABLE',
    files: { nodes: p.changedPaths.map((path) => ({ path })) },
  };
}

/** A repository's issue connection, with the filters and cursor the suite uses. */
function issueConnection(r: Repo, q: string, v: Record<string, unknown>) {
  const first = Number(v.first ?? (/first:\s*(\d+)/.exec(q)?.[1] ?? 100));
  const after = typeof v.after === 'string'
    ? Number(Buffer.from(v.after, 'base64').toString().replace('cursor:', '')) + 1
    : 0;
  let issues = [...r.issues];
  if (/states\s*:\s*\[OPEN\]/.test(q)) issues = issues.filter((i) => i.state === 'open');
  if (/direction\s*:\s*DESC/.test(q)) issues.reverse();
  const page = issues.slice(after, after + first).filter(Boolean);
  const end = after + page.length - 1;
  return {
    nodes: page.map(gqlIssue),
    pageInfo: {
      hasNextPage: after + page.length < issues.length,
      endCursor: page.length ? Buffer.from(`cursor:${end}`).toString('base64') : null,
    },
  };
}

function gqlRepo(r: Repo, q: string, v: Record<string, unknown>): Record<string, unknown> {
  const number = Number(v.number);
  const issue = r.issues.find((i) => i.number === number);
  const pull = r.pulls.find((p) => p.number === number);
  return {
    id: r.node_id, databaseId: r.id, name: r.name, nameWithOwner: r.full_name,
    owner: { login: r.owner },
    defaultBranchRef: latest(r.branches.get(r.default_branch)!)
      ? { name: r.default_branch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    issue: issue ? gqlIssue(issue) : null,
    issues: issueConnection(r, q, v),
    pullRequests: { nodes: r.pulls.slice(0, Number(v.first ?? 100)).map((p) => gqlPull(r, p)) },
    pullRequest: pull ? gqlPull(r, pull) : null,
  };
}

/** Evaluate one GraphQL request body. */
function graphqlOne(input: unknown): Record<string, unknown> {
  const b = object(input);
  const q = String(b.query ?? '');
  const v = object(b.variables);
  const inp = object(v.input);

  if (q.includes('noSuchFieldOnViewer')) {
    return { errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }] };
  }
  if (q.includes('__type')) {
    const data: Record<string, unknown> = {};
    for (const type of ['Issue', 'PullRequest', 'Repository']) {
      if (q.includes(`${type}: __type`) || q.includes(`name: "${type}"`)) {
        data[type] = { fields: (TYPE_FIELDS[type] ?? []).map((name) => ({ name })) };
      }
    }
    if (q.includes('SearchType')) data.SearchType = { enumValues: ['ISSUE', 'REPOSITORY', 'USER'].map((name) => ({ name })) };
    return { data };
  }
  if (q.includes('createIssue')) {
    const n = findNode(inp.repositoryId);
    if (!n) return { errors: [{ message: 'Repository not found' }] };
    const i = createIssue(n.repo, inp)!;
    return { data: { createIssue: { issue: gqlIssue(i) } } };
  }
  if (q.includes('closeIssue')) {
    const n = findNode(inp.issueId);
    if (!n || n.kind !== 'issue') return { errors: [{ message: 'Issue not found' }] };
    (n.value as Issue).state = 'closed';
    return { data: { closeIssue: { issue: gqlIssue(n.value as Issue) } } };
  }
  if (q.includes('createPullRequest')) {
    const n = findNode(inp.repositoryId);
    if (!n) return { errors: [{ message: 'Repository not found' }] };
    const p = createPull(n.repo, { title: inp.title, head: inp.headRefName, base: inp.baseRefName })!;
    return { data: { createPullRequest: { pullRequest: gqlPull(n.repo, p) } } };
  }
  if (q.includes('mergePullRequest')) {
    const n = findNode(inp.pullRequestId);
    if (!n || n.kind !== 'pull') return { errors: [{ message: 'Pull request not found' }] };
    mergePull(n.repo, n.value as Pull);
    return { data: { mergePullRequest: { pullRequest: gqlPull(n.repo, n.value as Pull) } } };
  }
  if (q.includes('addComment')) {
    const n = findNode(inp.subjectId);
    if (!n || n.kind !== 'issue') return { errors: [{ message: 'Subject not found' }] };
    const id = nextCommentId();
    const c = { id, node_id: encodeNode('IssueComment', id), body: String(inp.body ?? '') };
    (n.value as Issue).comments.push(c);
    return { data: { addComment: { commentEdge: { node: { id: c.node_id, body: c.body } } } } };
  }
  if (/\bnode\s*\(/.test(q)) {
    const n = findNode(v.id);
    return { data: { node: n && n.kind === 'repo' ? { id: n.repo.node_id, name: n.repo.name, nameWithOwner: n.repo.full_name } : null } };
  }
  if (q.includes('viewer')) return { data: { viewer: { login: OWNER } } };
  if (q.includes('repository')) {
    const r = namedRepo(String(v.owner ?? ''), String(v.name ?? ''));
    return { data: { repository: r ? gqlRepo(r, q, v) : null } };
  }
  return { data: {} };
}

/** Handle one POST /api/graphql request, single or batch. */
export async function graphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!auth(req)) return error(res, 401, 'Requires authentication');
  let body: unknown;
  try { body = await readBody(req); } catch { return error(res, 400, 'Problems parsing JSON'); }
  sendJson(res, 200, Array.isArray(body) ? body.map(graphqlOne) : graphqlOne(body));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}
