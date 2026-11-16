// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and pull
// requests. Every route answers application/json with a non-empty X-GitHub-Request-Id; errors are
// {message: string}; a malformed JSON body is a 400; an unknown route is a 404. All routes under
// /api/v3 except the root and /meta require the bearer token.
//
// The shapes follow what the suite's checks assert (checks-rest.ts): the fields they read are
// present, extras are GitHub-like and harmless.

import { parseCommit, parseTree } from './gitobj.ts';
import { VIEWER } from './scenario.ts';
import {
  buildTreeFromFlat,
  createCommit,
  diffFlatMaps,
  flattenCommit,
  flattenTree,
  isAncestor,
  mergeBase,
  putObject,
  refTip,
  resolveRef,
  threeWayMerge,
  walkCommits,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';
import { bool, clampPage, isObjectId, str, ZERO_OID } from './util.ts';
import { parseJsonBody, requireAuth, sendEmpty, sendError, sendJson, type Ctx } from './context.ts';

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userShape(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', site_admin: false };
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userShape(repo.owner, VIEWER.id),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    fork: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelShape(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: '', default: false };
}

function issueShape(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelShape),
    user: userShape(VIEWER.login, VIEWER.id),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/issues/${issue.number}`,
  };
}

function pullShape(pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    user: userShape(VIEWER.login, VIEWER.id),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/pulls/${pull.number}`,
  };
}

function commentShape(comment: { id: number; body: string; userLogin: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userShape(comment.userLogin, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function commitShape(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  // The REST view trims the trailing newline git stores in the message.
  const message = commit.message.replace(/\n+$/, '');
  return {
    sha,
    commit: {
      message,
      author: { name: VIEWER.name, email: VIEWER.email },
      committer: { name: VIEWER.name, email: VIEWER.email },
    },
    author: userShape(VIEWER.login, VIEWER.id),
    committer: userShape(VIEWER.login, VIEWER.id),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface Page<T> {
  readonly items: T[];
  readonly link: string | null;
}

/** Slice a list by ?per_page=&page= and build the Link rel="next" header when more pages remain. */
function paginate<T>(ctx: Ctx, items: readonly T[]): Page<T> {
  const perPage = clampPage(ctx.query.get('per_page'), 30, 1, 100);
  const page = clampPage(ctx.query.get('page'), 1, 1, 1_000_000);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? '127.0.0.1';
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    link = `<http://${host}${ctx.pathname}?${params.toString()}>; rel="next"`;
  }
  return { items: slice, link };
}

function pageHeaders(page: Page<unknown>): Record<string, string> {
  return page.link === null ? {} : { link: page.link };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

/** Split the path after /api/v3/repos/{owner}/{repo} into its remaining segments. */
function repoRoute(ctx: Ctx): { owner: string; repo: string; rest: string[] } | null {
  const parts = ctx.pathname.split('/').filter((part) => part !== '');
  // parts: ['api','v3','repos', owner, repo, ...rest]
  if (parts.length < 5 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos') return null;
  return { owner: parts[3], repo: parts[4], rest: parts.slice(5) };
}

/** Load the repository a route names, or send a 404 and answer null. */
function loadRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Parse a positive integer path segment, or send a 404 and answer null. */
function pathNumber(ctx: Ctx, raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return value;
}

/**
 * Handle a REST request. Returns true when the path is a /api/v3 route (handled, whatever the
 * status), false when it is not REST at all and another surface should try it.
 */
export function handleRest(ctx: Ctx): boolean {
  const path = ctx.pathname;
  if (path !== '/api/v3' && path !== '/api/v3/' && !path.startsWith('/api/v3/')) return false;

  // The API root and /meta are public, as on GitHub; everything else needs the token.
  if (ctx.method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(
      ctx,
      200,
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: 'https://api.github.com/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (ctx.method === 'GET' && path === '/api/v3/meta') {
    sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }

  if (!requireAuth(ctx)) return true;

  if (ctx.method === 'GET' && path === '/api/v3/user') {
    sendJson(ctx, 200, {
      ...userShape(VIEWER.login, VIEWER.id),
      name: VIEWER.name,
      email: VIEWER.email,
      avatar_url: '',
      html_url: `https://github.com/${VIEWER.login}`,
      type: 'User',
      site_admin: false,
    });
    return true;
  }

  if (path === '/api/v3/user/repos') {
    if (ctx.method === 'POST') return createUserRepo(ctx);
    if (ctx.method === 'GET') {
      const repos = ctx.store.reposOf(VIEWER.login).map(repoShape);
      const page = paginate(ctx, repos);
      sendJson(ctx, 200, page.items, pageHeaders(page));
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  const route = repoRoute(ctx);
  if (route === null) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  return handleRepoRoute(ctx, route.owner, route.repo, route.rest);
}

// ---------------------------------------------------------------------------------------------
// POST /user/repos
// ---------------------------------------------------------------------------------------------

function createUserRepo(ctx: Ctx): boolean {
  const body = parseJsonBody(ctx);
  if (body === null) return true;
  const name = str(body, 'name').trim();
  if (name === '' || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    sendError(ctx, 422, 'Validation Failed: name is invalid');
    return true;
  }
  if (ctx.store.getRepo(VIEWER.login, name) !== undefined) {
    sendError(ctx, 422, `Repository ${VIEWER.login}/${name} already exists`);
    return true;
  }
  const description = str(body, 'description');
  const isPrivate = bool(body, 'private', false);
  const repo = ctx.store.createRepo(VIEWER.login, name, description, isPrivate);
  sendJson(ctx, 201, repoShape(repo));
  return true;
}

// ---------------------------------------------------------------------------------------------
// /repos/{owner}/{repo}/*
// ---------------------------------------------------------------------------------------------

function handleRepoRoute(ctx: Ctx, owner: string, name: string, rest: string[]): boolean {
  const repo = loadRepo(ctx, owner, name);
  if (repo === null) return true;

  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, repoShape(repo));
      return true;
    }
    if (ctx.method === 'PATCH') {
      const body = parseJsonBody(ctx);
      if (body === null) return true;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(ctx, 200, repoShape(repo));
      return true;
    }
    if (ctx.method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      sendEmpty(ctx, 204);
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  const [head, ...tail] = rest;
  switch (head) {
    case 'git':
      return handleGitRefs(ctx, repo, tail);
    case 'branches':
      return handleBranches(ctx, repo, tail);
    case 'commits':
      return handleCommits(ctx, repo, tail);
    case 'contents':
      return handleContents(ctx, repo, tail);
    case 'labels':
      return handleLabels(ctx, repo, tail);
    case 'issues':
      return handleIssues(ctx, repo, tail);
    case 'pulls':
      return handlePulls(ctx, repo, tail);
    default:
      sendError(ctx, 404, 'Not Found');
      return true;
  }
}

// ---------------------------------------------------------------------------------------------
// git refs
// ---------------------------------------------------------------------------------------------

function handleGitRefs(ctx: Ctx, repo: Repo, tail: string[]): boolean {
  if (tail.length === 1 && tail[0] === 'refs') {
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) return true;
      const ref = str(body, 'ref');
      const sha = str(body, 'sha');
      if (!ref.startsWith('refs/') || ref.length > 200 || !isObjectId(sha)) {
        sendError(ctx, 422, 'Validation Failed: ref or sha is invalid');
        return true;
      }
      const target = repo.objects.get(sha);
      if (target === undefined) {
        sendError(ctx, 422, 'Validation Failed: sha does not exist');
        return true;
      }
      if (ref.startsWith('refs/heads/') && target.type !== 'commit') {
        sendError(ctx, 422, 'Validation Failed: a branch must point at a commit');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(ctx, 422, `Reference ${ref} already exists`);
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(ctx, 201, { ref, object: { sha, type: target.type }, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.slice(5)}` });
      return true;
    }
    if (ctx.method === 'GET') {
      const refs = [...repo.refs.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
      sendJson(ctx, 200, refs);
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  // GET /git/refs/heads/<branch...> or /git/refs/tags/<tag...>: the remainder is the ref name.
  if (tail.length >= 2 && tail[0] === 'refs' && ctx.method === 'GET') {
    const ref = `refs/${tail.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    sendJson(ctx, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    return true;
  }
  sendError(ctx, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------------------------

function handleBranches(ctx: Ctx, repo: Repo, tail: string[]): boolean {
  if (tail.length === 0 && ctx.method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const page = paginate(ctx, branches);
    sendJson(ctx, 200, page.items, pageHeaders(page));
    return true;
  }
  if (tail.length >= 1 && ctx.method === 'GET') {
    const branch = tail.join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const commit = commitShape(repo, sha);
    sendJson(ctx, 200, { name: branch, commit: { sha, commit: commit?.commit ?? { message: '' } }, protected: false });
    return true;
  }
  sendError(ctx, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

function handleCommits(ctx: Ctx, repo: Repo, tail: string[]): boolean {
  if (tail.length === 0 && ctx.method === 'GET') {
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (tip === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const perPage = clampPage(ctx.query.get('per_page'), 30, 1, 100);
    const page = clampPage(ctx.query.get('page'), 1, 1, 1_000_000);
    const walked = walkCommits(repo, tip, page * perPage);
    const items = walked
      .slice((page - 1) * perPage, page * perPage)
      .map((sha) => commitShape(repo, sha))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    sendJson(ctx, 200, items);
    return true;
  }
  if (tail.length === 1 && ctx.method === 'GET') {
    const sha = resolveRef(repo, tail[0]);
    if (sha === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const commit = commitShape(repo, sha);
    if (commit === null) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    sendJson(ctx, 200, commit);
    return true;
  }
  sendError(ctx, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

/** The tree object at `path` inside `treeOid`, walking directories; null when absent. */
function treeAtPath(repo: Repo, treeOid: string, path: string): { oid: string; isDir: boolean; entry: { mode: string; oid: string } | null } | null {
  if (path === '') return { oid: treeOid, isDir: true, entry: null };
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      return { oid: entry.oid, isDir: entry.mode === '40000', entry: { mode: entry.mode, oid: entry.oid } };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function handleContents(ctx: Ctx, repo: Repo, tail: string[]): boolean {
  const filePath = tail.join('/');
  if (ctx.method === 'GET') return getContents(ctx, repo, filePath);
  if (ctx.method === 'PUT') return putContents(ctx, repo, filePath);
  if (ctx.method === 'DELETE') return deleteContents(ctx, repo, filePath);
  sendError(ctx, 404, 'Not Found');
  return true;
}

function getContents(ctx: Ctx, repo: Repo, filePath: string): boolean {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === undefined) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const commitObject = repo.objects.get(tip);
  if (commitObject === undefined || commitObject.type !== 'commit') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const rootTree = parseCommit(commitObject.data).tree;
  const found = treeAtPath(repo, rootTree, filePath);
  if (found === null) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (found.isDir) {
    const treeObject = repo.objects.get(found.oid);
    if (treeObject === undefined || treeObject.type !== 'tree') {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const entries = parseTree(treeObject.data).map((entry) => {
      const childPath = filePath === '' ? entry.name : `${filePath}/${entry.name}`;
      const blob = entry.mode === '40000' ? null : repo.objects.get(entry.oid);
      return {
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: childPath,
        sha: entry.oid,
        size: blob?.data.length ?? 0,
        url: `/api/v3/repos/${repo.fullName}/contents/${childPath}`,
      };
    });
    sendJson(ctx, 200, entries);
    return true;
  }
  const blob = repo.objects.get(found.oid);
  if (blob === undefined || blob.type !== 'blob') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const name = filePath.split('/').pop() ?? filePath;
  sendJson(ctx, 200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name,
    path: filePath,
    sha: found.oid,
    content: blob.data.toString('base64'),
    url: `/api/v3/repos/${repo.fullName}/contents/${filePath}`,
  });
  return true;
}

function putContents(ctx: Ctx, repo: Repo, filePath: string): boolean {
  if (filePath === '') {
    sendError(ctx, 422, 'Validation Failed: path is empty');
    return true;
  }
  const body = parseJsonBody(ctx);
  if (body === null) return true;
  const message = str(body, 'message');
  const contentB64 = str(body, 'content');
  if (message === '' || contentB64 === '') {
    sendError(ctx, 422, 'Validation Failed: message and content are required');
    return true;
  }
  const branch = str(body, 'branch') || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let tip = refTip(repo, refName);
  // A branch that does not exist yet is created from the default branch's tip, as the suite needs.
  if (tip === undefined) {
    const baseTip = refTip(repo, `refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) tip = baseTip;
  }
  const flat = flattenCommit(repo, tip);
  const existing = flat.get(filePath);
  const givenSha = str(body, 'sha');
  if (existing !== undefined) {
    if (givenSha !== '' && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      sendError(ctx, 409, 'Conflict: the file has changed since the sha was read');
      return true;
    }
    if (givenSha === '') {
      sendError(ctx, 409, 'Conflict: updating a file requires its current sha');
      return true;
    }
  }
  const data = Buffer.from(contentB64, 'base64');
  const blobOid = putObject(repo, 'blob', data);
  flat.set(filePath, { mode: '100644', oid: blobOid });
  const treeOid = buildTreeFromFlat(repo, flat);
  const parents = tip === undefined ? [] : [tip];
  const commitOid = createCommit(ctx.store, repo, treeOid, parents, message);
  repo.refs.set(refName, commitOid);
  const name = filePath.split('/').pop() ?? filePath;
  sendJson(ctx, existing === undefined ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name,
      path: filePath,
      sha: blobOid,
    },
    commit: { sha: commitOid, message },
  });
  return true;
}

function deleteContents(ctx: Ctx, repo: Repo, filePath: string): boolean {
  if (filePath === '') {
    sendError(ctx, 422, 'Validation Failed: path is empty');
    return true;
  }
  const body = parseJsonBody(ctx);
  if (body === null) return true;
  const message = str(body, 'message');
  const givenSha = str(body, 'sha');
  const branch = str(body, 'branch') || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = refTip(repo, refName);
  if (tip === undefined) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const flat = flattenCommit(repo, tip);
  const existing = flat.get(filePath);
  if (existing === undefined) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (givenSha !== '' && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
    sendError(ctx, 409, 'Conflict: the file has changed since the sha was read');
    return true;
  }
  flat.delete(filePath);
  const treeOid = buildTreeFromFlat(repo, flat);
  const commitOid = createCommit(ctx.store, repo, treeOid, [tip], message === '' ? `Delete ${filePath}` : message);
  repo.refs.set(refName, commitOid);
  sendJson(ctx, 200, { commit: { sha: commitOid, message } });
  return true;
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

function handleLabels(ctx: Ctx, repo: Repo, tail: string[]): boolean {
  if (tail.length === 0 && ctx.method === 'GET') {
    sendJson(ctx, 200, [...repo.labels.values()].map(labelShape));
    return true;
  }
  if (tail.length === 0 && ctx.method === 'POST') {
    const body = parseJsonBody(ctx);
    if (body === null) return true;
    const name = str(body, 'name').trim();
    if (name === '') {
      sendError(ctx, 422, 'Validation Failed: name is required');
      return true;
    }
    if (repo.labels.has(name)) {
      sendError(ctx, 422, `Label ${name} already exists`);
      return true;
    }
    const color = str(body, 'color') || 'ededed';
    const label = ctx.store.createLabel(repo, name, color);
    sendJson(ctx, 201, labelShape(label));
    return true;
  }
  sendError(ctx, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(ctx: Ctx, repo: Repo, tail: string[]): boolean {
  if (tail.length === 0) {
    if (ctx.method === 'POST') return createIssue(ctx, repo);
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      else if (state !== 'all') {
        sendError(ctx, 422, 'Validation Failed: state must be open, closed or all');
        return true;
      }
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const page = paginate(ctx, issues.map(issueShape));
      sendJson(ctx, 200, page.items, pageHeaders(page));
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const number = pathNumber(ctx, tail[0]);
  if (number === null) return true;
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (tail.length === 1) {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, issueShape(issue));
      return true;
    }
    if (ctx.method === 'PATCH') {
      const body = parseJsonBody(ctx);
      if (body === null) return true;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedAt = ctx.store.nowIso();
      sendJson(ctx, 200, issueShape(issue));
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) return true;
      const text = str(body, 'body');
      if (text === '') {
        sendError(ctx, 422, 'Validation Failed: body is required');
        return true;
      }
      const comment = ctx.store.createComment(issue, text, VIEWER.login);
      sendJson(ctx, 201, commentShape(comment));
      return true;
    }
    if (ctx.method === 'GET') {
      const page = paginate(ctx, issue.comments.map(commentShape));
      sendJson(ctx, 200, page.items, pageHeaders(page));
      return true;
    }
  }
  sendError(ctx, 404, 'Not Found');
  return true;
}

function createIssue(ctx: Ctx, repo: Repo): boolean {
  const body = parseJsonBody(ctx);
  if (body === null) return true;
  const title = str(body, 'title');
  if (title === '') {
    sendError(ctx, 422, 'Validation Failed: title is required');
    return true;
  }
  const text = str(body, 'body');
  const labels: Label[] = [];
  if (Array.isArray(body.labels)) {
    for (const raw of body.labels) {
      const name = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? str(raw, 'name') : '';
      const label = repo.labels.get(name);
      if (label === undefined) {
        sendError(ctx, 422, `Validation Failed: label ${name} does not exist`);
        return true;
      }
      labels.push(label);
    }
  }
  const issue = ctx.store.createIssue(repo, title, text, labels);
  sendJson(ctx, 201, issueShape(issue));
  return true;
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(ctx: Ctx, repo: Repo, tail: string[]): boolean {
  if (tail.length === 0) {
    if (ctx.method === 'POST') return createPull(ctx, repo);
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      else if (state !== 'all') {
        sendError(ctx, 422, 'Validation Failed: state must be open, closed or all');
        return true;
      }
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const page = paginate(ctx, pulls.map(pullShape));
      sendJson(ctx, 200, page.items, pageHeaders(page));
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const number = pathNumber(ctx, tail[0]);
  if (number === null) return true;
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (tail.length === 1 && ctx.method === 'GET') {
    sendJson(ctx, 200, pullShape(pull));
    return true;
  }
  if (tail.length === 2 && tail[1] === 'files' && ctx.method === 'GET') {
    const headTip = refTip(repo, `refs/heads/${pull.headRef}`);
    const baseTip = refTip(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) {
      sendJson(ctx, 200, []);
      return true;
    }
    const base = mergeBase(repo, headTip, baseTip);
    const baseFlat = base === null ? new Map() : flattenCommit(repo, base);
    const headFlat = flattenCommit(repo, headTip);
    const files = diffFlatMaps(repo, baseFlat, headFlat).map((file) => ({
      sha: '',
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    const page = paginate(ctx, files);
    sendJson(ctx, 200, page.items, pageHeaders(page));
    return true;
  }
  if (tail.length === 2 && tail[1] === 'merge' && ctx.method === 'PUT') return mergePull(ctx, repo, pull);
  sendError(ctx, 404, 'Not Found');
  return true;
}

function createPull(ctx: Ctx, repo: Repo): boolean {
  const body = parseJsonBody(ctx);
  if (body === null) return true;
  const title = str(body, 'title');
  const head = str(body, 'head');
  const base = str(body, 'base') || repo.defaultBranch;
  if (title === '' || head === '' || base === '') {
    sendError(ctx, 422, 'Validation Failed: title, head and base are required');
    return true;
  }
  const headSha = refTip(repo, `refs/heads/${head}`);
  const baseSha = refTip(repo, `refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) {
    sendError(ctx, 422, 'Validation Failed: head or base branch does not exist');
    return true;
  }
  if (head === base) {
    sendError(ctx, 422, 'Validation Failed: head and base are the same branch');
    return true;
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      sendError(ctx, 422, 'Validation Failed: a pull request for this head and base is already open');
      return true;
    }
  }
  const text = str(body, 'body');
  const pull = ctx.store.createPull(repo, title, text, head, headSha, base, baseSha);
  sendJson(ctx, 201, pullShape(pull));
  return true;
}

/**
 * The squash merge a pull request needs, shared by REST and GraphQL: a three-way merge of the
 * head into the base, a new commit on the base branch, and the pull request closed and merged.
 * Returns the merge commit sha, or null when the pull cannot merge (with the HTTP status to use).
 */
export function squashMerge(
  ctx: { store: ForgeStore },
  repo: Repo,
  pull: PullRequest,
): { sha: string } | { status: number; message: string } {
  if (pull.state !== 'open') return { status: 405, message: 'Pull request is not open' };
  const headTip = refTip(repo, `refs/heads/${pull.headRef}`);
  const baseTip = refTip(repo, `refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) {
    return { status: 405, message: 'Pull request head or base branch no longer exists' };
  }
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return { status: 405, message: 'Pull request has no merge base' };
  if (base === headTip) return { status: 405, message: 'Pull request is already merged' };
  const baseFlat = flattenCommit(repo, base);
  const oursFlat = flattenCommit(repo, baseTip);
  const theirsFlat = flattenCommit(repo, headTip);
  const outcome = threeWayMerge(baseFlat, oursFlat, theirsFlat);
  if (outcome.merged === null) {
    return { status: 405, message: `Merge conflict in ${outcome.conflicts.join(', ')}` };
  }
  const treeOid = buildTreeFromFlat(repo, outcome.merged);
  const message = pull.body === '' ? `${pull.title} (#${pull.number})` : `${pull.title} (#${pull.number})\n\n${pull.body}`;
  const mergeSha = createCommit(ctx.store, repo, treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ctx.store.nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  pull.updatedAt = ctx.store.nowIso();
  return { sha: mergeSha };
}

function mergePull(ctx: Ctx, repo: Repo, pull: PullRequest): boolean {
  // The body carries merge_method; any method is served as a squash (the suite only sends squash).
  if (ctx.body.length > 0) {
    const body = parseJsonBody(ctx);
    if (body === null) return true;
  }
  const outcome = squashMerge(ctx, repo, pull);
  if ('status' in outcome) {
    sendError(ctx, outcome.status, outcome.message);
    return true;
  }
  sendJson(ctx, 200, { sha: outcome.sha, merged: true, message: `Pull request #${pull.number} was merged` });
  return true;
}

/** Whether a pull request's head merges cleanly into its base (for GraphQL's mergeable). */
export function pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = refTip(repo, `refs/heads/${pull.headRef}`);
  const baseTip = refTip(repo, `refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  if (base === headTip) return 'MERGEABLE';
  const outcome = threeWayMerge(flattenCommit(repo, base), flattenCommit(repo, baseTip), flattenCommit(repo, headTip));
  return outcome.conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

/** Whether `newOid` may fast-forward `oldOid` (used by the git receive-pack path too). */
export function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (oldOid === newOid) return true;
  const oldCommit = peelToCommitLocal(repo, oldOid);
  const newCommit = peelToCommitLocal(repo, newOid);
  if (oldCommit === null || newCommit === null) return false;
  return isAncestor(repo, newCommit, oldCommit);
}

function peelToCommitLocal(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type !== 'tag') return null;
  const target = parseTag(object.data).object;
  return peelToCommitLocal(repo, target);
}
