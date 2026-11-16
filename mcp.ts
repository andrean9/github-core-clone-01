// Model Context Protocol over streamable HTTP: JSON-RPC 2.0 on POST /mcp, answered as plain JSON
// (the client's SSE reader is never needed). The modern era (2026-07-28) is served: server/discover
// first, no handshake, no session; the legacy initialize handshake is answered too, for a client
// that asks for it. Six tools, github-mcp-server's names, over the same store the REST surface
// reads — a repository or issue created here is the same object over REST, with the same stable id.
//
// A parse error is HTTP 400 with JSON-RPC -32700; an unknown tool is -32602; a missing required
// argument is -32602; a request without the bearer token is HTTP 401.

import { squashMerge } from './rest.ts';
import { VIEWER } from './scenario.ts';
import { refTip, type Repo } from './store.ts';
import { requireAuth, sendError, sendJson, type Ctx } from './context.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description?: string }>>;
    readonly required: readonly string[];
  };
}

/**
 * The six tools, fixed: the same array serializes byte-identically on every tools/list call, and
 * every `required` property is one the suite can fill from its documented argument names.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch to another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

type JsonRpcId = string | number | null;

function rpcResult(ctx: Ctx, id: JsonRpcId, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(ctx: Ctx, id: JsonRpcId, code: number, message: string, httpStatus = 200): void {
  sendJson(ctx, httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

/** A tool result: structuredContent first, the same object as JSON text beside it. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** A tool failure: isError true, with the reason as text. */
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function argNumber(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    html_url: `https://github.com/${repo.fullName}`,
  };
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcError: { code: number; message: string } } {
  const tool = TOOLS.find((candidate) => candidate.name === name)
    ?? TOOLS.find((candidate) => name.toLowerCase().endsWith(candidate.name));
  if (tool === undefined) return { rpcError: { code: JSON_RPC_INVALID_PARAMS, message: `Unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return { rpcError: { code: JSON_RPC_INVALID_PARAMS, message: `Missing required argument: ${required}` } };
    }
  }

  switch (tool.name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (ctx.store.getRepo(VIEWER.login, repoName) !== undefined) {
        return toolError(`Repository ${VIEWER.login}/${repoName} already exists`);
      }
      const repo = ctx.store.createRepo(VIEWER.login, repoName, argString(args, 'description'), args.private === true);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = ctx.store.getRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === undefined) return toolError('Not Found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = ctx.store.getRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === undefined) return toolError('Not Found');
      const issue = ctx.store.createIssue(repo, argString(args, 'title'), argString(args, 'body'), []);
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      });
    }
    case 'list_issues': {
      const repo = ctx.store.getRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === undefined) return toolError('Not Found');
      const state = argString(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      const list = issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      }));
      return toolResult({ issues: list });
    }
    case 'create_pull_request': {
      const repo = ctx.store.getRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === undefined) return toolError('Not Found');
      const head = argString(args, 'head');
      const base = argString(args, 'base') || repo.defaultBranch;
      const headSha = refTip(repo, `refs/heads/${head}`);
      const baseSha = refTip(repo, `refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return toolError('Validation Failed: head or base branch does not exist');
      }
      const pull = ctx.store.createPull(repo, argString(args, 'title'), argString(args, 'body'), head, headSha, base, baseSha);
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
      });
    }
    case 'merge_pull_request': {
      const repo = ctx.store.getRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === undefined) return toolError('Not Found');
      const number = argNumber(args, 'pull_number');
      const pull = number === null ? undefined : repo.pulls.get(number);
      if (pull === undefined) return toolError('Not Found');
      const outcome = squashMerge(ctx, repo, pull);
      if ('status' in outcome) return toolError(outcome.message);
      return toolResult({
        number: pull.number,
        merged: true,
        sha: outcome.sha,
        state: pull.state,
        merge_commit_sha: pull.mergeCommitSha,
        message: `Pull request #${pull.number} was merged`,
      });
    }
    default:
      return { rpcError: { code: JSON_RPC_INVALID_PARAMS, message: `Unknown tool: ${name}` } };
  }
}

/** Handle POST /mcp. Returns true when the path is the MCP route. */
export function handleMcp(ctx: Ctx): boolean {
  if (ctx.pathname !== '/mcp') return false;
  if (ctx.method === 'DELETE') {
    // A session termination for a session this server never hands out: nothing to end.
    sendJson(ctx, 200, {});
    return true;
  }
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (!requireAuth(ctx)) return true;
  let body: unknown;
  try {
    body = ctx.body.length === 0 ? null : JSON.parse(ctx.body.toString('utf8'));
  } catch {
    rpcError(ctx, null, JSON_RPC_PARSE_ERROR, 'Parse error', 400);
    return true;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    rpcError(ctx, null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
    return true;
  }
  const request = body as Record<string, unknown>;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    rpcError(ctx, null, JSON_RPC_INVALID_REQUEST, 'Invalid Request: method is required');
    return true;
  }
  // A notification carries no id: it is answered with an empty 202, never a result.
  const hasId = 'id' in request && request.id !== undefined && request.id !== null;
  const id = (hasId ? request.id : null) as JsonRpcId;
  if (!hasId) {
    sendJson(ctx, 202, {});
    return true;
  }
  const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      rpcResult(ctx, id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' && params.protocolVersion !== ''
        ? params.protocolVersion
        : PROTOCOL_VERSION;
      rpcResult(ctx, id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'ping': {
      rpcResult(ctx, id, {});
      return true;
    }
    case 'tools/list': {
      rpcResult(ctx, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
      if (name === '') {
        rpcError(ctx, id, JSON_RPC_INVALID_PARAMS, 'Missing required argument: name');
        return true;
      }
      const outcome = callTool(ctx, name, args);
      if ('rpcError' in outcome) {
        rpcError(ctx, id, outcome.rpcError.code, outcome.rpcError.message);
        return true;
      }
      rpcResult(ctx, id, outcome);
      return true;
    }
    default: {
      rpcError(ctx, id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
      return true;
    }
  }
}
