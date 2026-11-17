// Data layer for the forge: the in-memory store, the shape of every entity, and the
// small helpers the REST / GraphQL / MCP layers share. A sha1 digest stands in for git
// object ids, and a running counter mints numeric ids the way the GitHub API numbers them.
import { createHash } from 'node:crypto';

/** The single org every repository belongs to in this forge. */
export const OWNER = 'adaiversen';
/** A fixed timestamp: the suite reads dates but does not check them. */
export const NOW = '2025-01-01T00:00:00Z';
/** Bearer token the env sets; empty means every request is accepted. */
export const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export const JSON_TYPE = 'application/json; charset=utf-8';

export interface FileEntry { path: string; content: string; sha: string }
export interface Commit { sha: string; message: string; files: Map<string, FileEntry> }
export interface Branch { name: string; commits: Commit[]; forkFiles: Map<string, FileEntry> }
export interface Label { name: string; color: string }
export interface Comment { id: number; node_id: string; body: string }
export interface Issue {
  id: number; node_id: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: Label[]; comments: Comment[];
}
export interface Pull {
  id: number; node_id: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; merged_at: string | null;
  merge_commit_sha: string | null; headName: string; baseName: string; changedPaths: string[];
}
export interface Repo {
  id: number; node_id: string; owner: string; name: string; full_name: string;
  private: boolean; description: string; default_branch: string;
  labels: Map<string, Label>; issues: Issue[]; pulls: Pull[]; branches: Map<string, Branch>;
}

/** Every repository the forge knows about, keyed "owner/name" lowercased. */
export const repos = new Map<string, Repo>();

// Id counters: repos, issues, PRs and comments each get a distinct numeric range.
let repoSeq = 5000;
let issueIdSeq = 10000;
let commentSeq = 20000;
export const nextIssueId = (): number => ++issueIdSeq;
export const nextCommentId = (): number => ++commentSeq;
export const nextRepoId = (): number => ++repoSeq;

/** Mint a stable id from the parts that make an object unique. */
export function digest(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\0')).digest('hex');
}

/** Deep-enough copy of a branch's file map so edits never alias across branches. */
export function cloneFiles(files: Map<string, FileEntry>): Map<string, FileEntry> {
  return new Map([...files].map(([k, v]) => [k, { ...v }]));
}

/** Case-insensitive lookup key for a repository. */
export function key(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

/** base64 node ids, the shape the GraphQL API exposes. */
export function encodeNode(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}
export const repoNode = (id: number): string => encodeNode('Repository', id);
export const issueNode = (id: number): string => encodeNode('Issue', id);
export const pullNode = (id: number): string => encodeNode('PullRequest', id);
export const commentNode = (id: number): string => encodeNode('IssueComment', id);

/** Find a repo, issue or pull by its node id, plus the repo it lives in. */
export function findNode(id: unknown): { kind: string; repo: Repo; value?: Issue | Pull } | null {
  if (typeof id !== 'string') return null;
  for (const repo of repos.values()) {
    if (repo.node_id === id) return { kind: 'repo', repo };
    const issue = repo.issues.find((x) => x.node_id === id);
    if (issue) return { kind: 'issue', repo, value: issue };
    const pull = repo.pulls.find((x) => x.node_id === id);
    if (pull) return { kind: 'pull', repo, value: pull };
  }
  return null;
}

/** Resolve a repo the caller owns by owner+name; undefined when it is not ours. */
export function namedRepo(owner: string, name: string): Repo | undefined {
  if (owner.toLowerCase() !== OWNER) return undefined;
  return repos.get(key(owner, name));
}

export const latest = (b: Branch): Commit | undefined => b.commits[b.commits.length - 1];
export const branchFiles = (b: Branch): Map<string, FileEntry> => latest(b)?.files ?? new Map();

/** Create an empty repo with a single empty "main" branch. */
export function makeRepo(body: Record<string, unknown>): Repo {
  const name = String(body.name ?? '').trim();
  const id = nextRepoId();
  const r: Repo = {
    id,
    node_id: repoNode(id),
    owner: OWNER,
    name,
    full_name: `${OWNER}/${name}`,
    private: body.private === true,
    description: typeof body.description === 'string' ? body.description : '',
    default_branch: 'main',
    labels: new Map(),
    issues: [],
    pulls: [],
    branches: new Map(),
  };
  r.branches.set('main', { name: 'main', commits: [], forkFiles: new Map() });
  repos.set(key(OWNER, name), r);
  return r;
}

/** Create an issue, failing when it names a label the repo does not have. */
export function createIssue(r: Repo, b: Record<string, unknown>): Issue | undefined {
  const labels = Array.isArray(b.labels) ? b.labels.map(String) : [];
  if (labels.some((x) => !r.labels.has(x))) return undefined;
  const id = nextIssueId();
  const i: Issue = {
    id,
    node_id: issueNode(id),
    number: r.issues.length + r.pulls.length + 1,
    title: String(b.title ?? ''),
    body: typeof b.body === 'string' ? b.body : '',
    state: 'open',
    labels: labels.map((x) => ({ ...r.labels.get(x)! })),
    comments: [],
  };
  r.issues.push(i);
  return i;
}

/** Create a pull request between two existing branches. */
export function createPull(r: Repo, b: Record<string, unknown>): Pull | undefined {
  const head = String(b.head ?? b.headRefName ?? '');
  const base = String(b.base ?? b.baseRefName ?? r.default_branch);
  if (!r.branches.has(head) || !r.branches.has(base)) return undefined;
  const h = r.branches.get(head)!;
  const bf = branchFiles(r.branches.get(base)!);
  const changed = [...branchFiles(h).keys()].filter(
    (path) => branchFiles(h).get(path)?.sha !== bf.get(path)?.sha,
  );
  const number = r.issues.length + r.pulls.length + 1;
  const id = 30000 + number + r.id * 100;
  const p: Pull = {
    id,
    node_id: pullNode(id),
    number,
    title: String(b.title ?? ''),
    body: typeof b.body === 'string' ? b.body : '',
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    headName: head,
    baseName: base,
    changedPaths: changed,
  };
  r.pulls.push(p);
  return p;
}

/** A pull conflicts when a changed path differs on both sides since the fork. */
export function hasConflict(r: Repo, p: Pull): boolean {
  const h = r.branches.get(p.headName)!;
  const base = r.branches.get(p.baseName)!;
  const hf = branchFiles(h);
  const bf = branchFiles(base);
  return p.changedPaths.some((path) => {
    const fork = h.forkFiles.get(path)?.sha;
    return bf.get(path)?.sha !== fork && hf.get(path)?.sha !== bf.get(path)?.sha;
  });
}

/** Merge a pull into its base, or report why it cannot merge. */
export function mergePull(r: Repo, p: Pull): { ok: boolean; sha?: string } {
  if (p.merged) return { ok: true, sha: p.merge_commit_sha! };
  if (hasConflict(r, p)) return { ok: false };
  const head = r.branches.get(p.headName)!;
  const base = r.branches.get(p.baseName)!;
  const files = cloneFiles(branchFiles(base));
  for (const path of p.changedPaths) {
    const f = branchFiles(head).get(path);
    if (f) files.set(path, { ...f });
    else files.delete(path);
  }
  const sha = digest(
    r.full_name, p.title, String(p.number),
    ...p.changedPaths.map((x) => files.get(x)?.sha ?? 'delete'),
  );
  base.commits.push({ sha, message: p.title, files });
  p.merged = true;
  p.state = 'closed';
  p.merged_at = NOW;
  p.merge_commit_sha = sha;
  return { ok: true, sha };
}
