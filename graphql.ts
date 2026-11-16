// GitHub GraphQL v4: a small dependency-free parser and executor for the documents gh and
// github-mcp-server send (checks-graphql.ts's GRAPHQL_DOCUMENTS). It handles queries and
// mutations, variables, aliases, inline fragments, inline input objects and enums, operation
// batching (a JSON array of documents in one body), and the __type introspection probes gh
// feature-detects with. An unknown field is a 200 with an errors array naming it, as GitHub
// answers; an unknown repository is data.repository = null with no errors.
//
// Global ids are opaque and stable: base64url of `Type:ids` (e.g. `Repository:5000`), so node()
// and the mutation inputs round-trip without a lookup table.

import { pullMergeable, squashMerge } from './rest.ts';
import { VIEWER } from './scenario.ts';
import {
  diffFlatMaps,
  flattenCommit,
  mergeBase,
  refTip,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { b64url, unb64url } from './util.ts';
import { requireAuth, sendError, sendJson, type Ctx } from './context.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'float'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (token: Token): void => {
    tokens.push(token);
  };
  while (index < input.length) {
    const char = input[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '﻿') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < input.length && input[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && input.slice(index, index + 3) === '...') {
      push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(char)) {
      push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      // A block string is not expected in the suite's documents; treat """ as an empty string start.
      if (input.slice(index, index + 3) === '"""') {
        const end = input.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        push({ kind: 'string', value: input.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let value = '';
      index += 1;
      let closed = false;
      while (index < input.length) {
        const c = input[index];
        if (c === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (c === '\\' && index + 1 < input.length) {
          const escaped = input[index + 1];
          if (escaped === 'u' && index + 5 < input.length) {
            value += String.fromCharCode(Number.parseInt(input.slice(index + 2, index + 6), 16));
            index += 6;
            continue;
          }
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          value += map[escaped] ?? escaped;
          index += 2;
          continue;
        }
        value += c;
        index += 1;
      }
      if (!closed) throw new Error('unterminated string');
      push({ kind: 'string', value });
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(index));
      if (match === null) throw new Error(`bad number at offset ${index}`);
      const text = match[0];
      push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: text } : { kind: 'int', value: text });
      index += text.length;
      continue;
    }
    if ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_') {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(index));
      const text = match![0];
      push({ kind: 'name', value: text });
      index += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} at offset ${index}`);
  }
  push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export type GqlValue =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'literal'; readonly value: unknown };

export interface GqlField {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyMap<string, GqlValue>;
  readonly selection: readonly GqlSelection[];
}

export interface GqlFragment {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selection: readonly GqlSelection[];
}

export type GqlSelection = GqlField | GqlFragment;

export interface GqlOperation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: ReadonlyMap<string, unknown>;
  readonly selection: readonly GqlSelection[];
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (this.index < this.tokens.length - 1) this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${token.kind === 'eof' ? 'end of document' : JSON.stringify(token.value)}`);
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}, got ${token.kind === 'eof' ? 'end of document' : JSON.stringify(token.value)}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: new Map(), selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const type = token.value === 'subscription' ? 'query' : token.value;
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variables = new Map<string, unknown>();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions(variables);
        this.skipDirectives();
        operations.push({ type: type as 'query' | 'mutation', name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition whole.
        this.next();
        this.expectName('a fragment name');
        this.expectName('on');
        this.expectName('a type condition');
        this.skipDirectives();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected ${token.kind === 'eof' ? 'end of document' : JSON.stringify(token.value)} at the top level`);
    }
    return operations;
  }

  private parseVariableDefinitions(variables: Map<string, unknown>): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated variable definitions');
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        variables.set(name, this.parseValue());
      } else {
        variables.set(name, undefined);
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName('a type condition');
      } else if (this.peek().kind === 'name') {
        // A named fragment spread: the suite never sends one; resolve it as unconditioned.
        this.next();
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    let args: ReadonlyMap<string, GqlValue> = new Map();
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selection: GqlSelection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): ReadonlyMap<string, GqlValue> {
    const args = new Map<string, GqlValue>();
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated arguments');
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated list value');
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'literal', value: items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated input object');
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        object[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'literal', value: object };
    }
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'int') return { kind: 'literal', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'literal', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value }; // an enum value, read as its name
    }
    throw new Error(`unexpected value ${token.kind === 'eof' ? 'end of document' : JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

/** A resolved node: its GraphQL type name plus the store objects it reads. */
interface Node {
  readonly __typename: string;
  readonly [key: string]: unknown;
}

type Resolver = (source: Node, args: Record<string, unknown>, exec: Executor) => unknown;

interface FieldTable {
  readonly [typeName: string]: Readonly<Record<string, Resolver>>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

/** The opaque global id of a repository, issue, pull request or comment. */
export function globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', repoId: number, number: number): string {
  return b64url(`${kind}:${repoId}:${number}`);
}

function repositoryGlobalId(repo: Repo): string {
  return b64url(`Repository:${repo.id}`);
}

/** Decode a global id into its kind and numeric parts, or null when it is not one. */
function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  const decoded = unb64url(id);
  if (decoded === null) return null;
  const parts = decoded.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0];
  const repoId = Number(parts[1]);
  const number = parts.length >= 3 ? Number(parts[2]) : 0;
  if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
  return { kind, repoId, number };
}

/** The static introspection surface gh feature-detects. */
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'url', 'labels', 'closed', 'locked', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'author', 'headRef', 'baseRef', 'isDraft', 'reviewDecision'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'isPrivate', 'url', 'forkCount', 'stargazerCount'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Ref: ['name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};
const TYPE_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

class Executor {
  readonly errors: Array<{ message: string }> = [];
  private readonly ctx: Ctx;
  private readonly variables: Readonly<Record<string, unknown>>;

  constructor(ctx: Ctx, variables: Readonly<Record<string, unknown>>) {
    this.ctx = ctx;
    this.variables = variables;
  }

  /** Resolve an argument value: variables from the request, literals as parsed. */
  resolveValue(value: GqlValue): unknown {
    if (value.kind === 'variable') return this.variables[value.name] ?? null;
    const literal = value.value;
    if (Array.isArray(literal)) return literal.map((entry) => (typeof entry === 'object' && entry !== null && 'kind' in entry ? this.resolveValue(entry as GqlValue) : entry));
    if (typeof literal === 'object' && literal !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(literal)) {
        out[key] = typeof entry === 'object' && entry !== null && 'kind' in entry ? this.resolveValue(entry as GqlValue) : entry;
      }
      return out;
    }
    return literal;
  }

  resolveArgs(field: GqlField): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const [name, value] of field.args) args[name] = this.resolveValue(value);
    return args;
  }

  /** Execute one operation and answer its data object. */
  execute(operation: GqlOperation): Record<string, unknown> {
    const root: Node = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
    return this.executeSelection(root, operation.selection) as Record<string, unknown>;
  }

  private executeSelection(source: Node, selections: readonly GqlSelection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== source.__typename) continue;
        Object.assign(out, this.executeSelection(source, selection.selection));
        continue;
      }
      const key = selection.alias ?? selection.name;
      const table = FIELDS[source.__typename];
      const resolver = table?.[selection.name];
      if (resolver === undefined) {
        this.errors.push({ message: `Cannot query field "${selection.name}" on type "${source.__typename}".` });
        out[key] = null;
        continue;
      }
      let value: unknown;
      try {
        value = resolver(source, this.resolveArgs(selection), this);
      } catch (err) {
        this.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
        continue;
      }
      if (value === null || value === undefined) {
        out[key] = null;
        continue;
      }
      if (selection.selection.length === 0) {
        if (typeof value === 'object') {
          this.errors.push({ message: `Field "${selection.name}" of type "${source.__typename}" must have a selection of subfields.` });
          out[key] = null;
          continue;
        }
        out[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        out[key] = value.map((entry) => {
          if (entry !== null && typeof entry === 'object' && '__typename' in entry) {
            return this.executeSelection(entry as Node, selection.selection);
          }
          return entry;
        });
        continue;
      }
      if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        out[key] = this.executeSelection(value as Node, selection.selection);
        continue;
      }
      this.errors.push({ message: `Field "${selection.name}" of type "${source.__typename}" must not have a selection of subfields.` });
      out[key] = null;
    }
    return out;
  }

  findRepoById(databaseId: number): Repo | undefined {
    for (const repo of this.ctx.store.repos.values()) if (repo.id === databaseId) return repo;
    return undefined;
  }

  findRepo(owner: string, name: string): Repo | undefined {
    return this.ctx.store.getRepo(owner, name);
  }

  store(): import('./store.ts').ForgeStore {
    return this.ctx.store;
  }

  repoOf(source: Node): Repo {
    return source.repo as Repo;
  }
}

// ---------------------------------------------------------------------------------------------
// field resolvers
// ---------------------------------------------------------------------------------------------

function issueNode(repo: Repo, issue: Issue): Node {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: PullRequest): Node {
  return { __typename: 'PullRequest', repo, pull };
}

function userNode(): Node {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null): Node {
  return { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: null };
}

/** The issues connection of a repository, with states/orderBy/after/first applied. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): Node {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  const orderBy = asRecord(args.orderBy);
  const field = asString(orderBy.field) || 'CREATED_AT';
  const direction = asString(orderBy.direction) || 'ASC';
  let issues = [...repo.issues.values()];
  if (states !== null) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const descending = field === 'CREATED_AT' && direction === 'DESC';
  issues.sort((a, b) => (descending ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  const after = asString(args.after);
  if (after !== '') {
    const decoded = unb64url(after);
    const cursorNumber = decoded !== null && decoded.startsWith('cursor:') ? Number(decoded.slice('cursor:'.length)) : NaN;
    if (Number.isInteger(cursorNumber)) {
      issues = issues.filter((issue) => (descending ? issue.number < cursorNumber : issue.number > cursorNumber));
    }
  }
  const first = asInt(args.first, 30);
  const page = first >= 0 ? issues.slice(0, first) : issues;
  const hasNextPage = issues.length > page.length;
  const last = page[page.length - 1];
  const endCursor = last === undefined ? null : b64url(`cursor:${last.number}`);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: pageInfoNode(hasNextPage, endCursor),
    totalCount: issues.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Node {
  const first = asInt(args.first, 30);
  const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
  const page = first >= 0 ? pulls.slice(0, first) : pulls;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(repo, pull)),
    pageInfo: pageInfoNode(pulls.length > page.length, null),
    totalCount: pulls.length,
  };
}

function prFilesConnection(repo: Repo, pull: PullRequest, args: Record<string, unknown>): Node {
  const headTip = refTip(repo, `refs/heads/${pull.headRef}`);
  const baseTip = refTip(repo, `refs/heads/${pull.baseRef}`);
  let paths: string[] = [];
  if (headTip !== undefined && baseTip !== undefined) {
    const base = mergeBase(repo, headTip, baseTip);
    const baseFlat = base === null ? new Map() : flattenCommit(repo, base);
    paths = diffFlatMaps(repo, baseFlat, flattenCommit(repo, headTip)).map((file) => file.filename);
  }
  const first = asInt(args.first, 30);
  const page = first >= 0 ? paths.slice(0, first) : paths;
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: page.map((path) => ({ __typename: 'PullRequestChangedFile', path })),
    pageInfo: pageInfoNode(paths.length > page.length, null),
  };
}

const FIELDS: FieldTable = {
  Query: {
    viewer: () => userNode(),
    repository: (_source, args, exec) => {
      const owner = asString(args.owner);
      const name = asString(args.name);
      const found = exec.findRepo(owner, name);
      return found === undefined ? null : { __typename: 'Repository', repo: found };
    },
    node: (_source, args, exec) => {
      const decoded = decodeGlobalId(asString(args.id));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = exec.findRepoById(decoded.repoId);
        return repo === undefined ? null : { __typename: 'Repository', repo };
      }
      if (decoded.kind === 'Issue') {
        const repo = exec.findRepoById(decoded.repoId);
        const issue = repo?.issues.get(decoded.number);
        return issue === undefined || repo === undefined ? null : issueNode(repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = exec.findRepoById(decoded.repoId);
        const pull = repo?.pulls.get(decoded.number);
        return pull === undefined || repo === undefined ? null : pullNode(repo, pull);
      }
      return null;
    },
    __type: (_source, args) => {
      const name = asString(args.name);
      const fields = TYPE_FIELDS[name];
      const enumValues = TYPE_ENUM_VALUES[name];
      if (fields === undefined && enumValues === undefined) return null;
      return {
        __typename: '__Type',
        name,
        kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
        fields: fields ?? [],
        enumValues: enumValues ?? [],
      };
    },
  },
  Mutation: {
    createIssue: (_source, args, exec) => {
      const input = asRecord(args.input);
      const decoded = decodeGlobalId(asString(input.repositoryId));
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createIssue: unknown repositoryId');
      const repo = exec.findRepoById(decoded.repoId);
      if (repo === undefined) throw new Error('createIssue: unknown repositoryId');
      const title = asString(input.title);
      if (title === '') throw new Error('createIssue: title is required');
      const issue = exec.store().createIssue(repo, title, asString(input.body), []);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    closeIssue: (_source, args, exec) => {
      const input = asRecord(args.input);
      const decoded = decodeGlobalId(asString(input.issueId));
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('closeIssue: unknown issueId');
      const repo = exec.findRepoById(decoded.repoId);
      const issue = repo?.issues.get(decoded.number);
      if (repo === undefined || issue === undefined) throw new Error('closeIssue: unknown issueId');
      issue.state = 'closed';
      issue.updatedAt = exec.store().nowIso();
      return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
    },
    createPullRequest: (_source, args, exec) => {
      const input = asRecord(args.input);
      const decoded = decodeGlobalId(asString(input.repositoryId));
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createPullRequest: unknown repositoryId');
      const repo = exec.findRepoById(decoded.repoId);
      if (repo === undefined) throw new Error('createPullRequest: unknown repositoryId');
      const headRef = asString(input.headRefName);
      const baseRef = asString(input.baseRefName);
      const headSha = refTip(repo, `refs/heads/${headRef}`);
      const baseSha = refTip(repo, `refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) throw new Error('createPullRequest: head or base branch does not exist');
      const title = asString(input.title);
      if (title === '') throw new Error('createPullRequest: title is required');
      const pull = exec.store().createPull(repo, title, asString(input.body), headRef, headSha, baseRef, baseSha);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    mergePullRequest: (_source, args, exec) => {
      const input = asRecord(args.input);
      const decoded = decodeGlobalId(asString(input.pullRequestId));
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('mergePullRequest: unknown pullRequestId');
      const repo = exec.findRepoById(decoded.repoId);
      const pull = repo?.pulls.get(decoded.number);
      if (repo === undefined || pull === undefined) throw new Error('mergePullRequest: unknown pullRequestId');
      const outcome = squashMerge({ store: exec.store() }, repo, pull);
      if ('status' in outcome) throw new Error(outcome.message);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    addComment: (_source, args, exec) => {
      const input = asRecord(args.input);
      const decoded = decodeGlobalId(asString(input.subjectId));
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('addComment: unknown subjectId');
      const repo = exec.findRepoById(decoded.repoId);
      const issue = repo?.issues.get(decoded.number);
      if (repo === undefined || issue === undefined) throw new Error('addComment: unknown subjectId');
      const body = asString(input.body);
      if (body === '') throw new Error('addComment: body is required');
      const comment = exec.store().createComment(issue, body, VIEWER.login);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'IssueComment', id: globalId('IssueComment', repo.id, comment.id), body: comment.body },
        },
      };
    },
  },
  Repository: {
    id: (source) => repositoryGlobalId(source.repo as Repo),
    databaseId: (source) => (source.repo as Repo).id,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => (source.repo as Repo).fullName,
    description: (source) => (source.repo as Repo).description,
    owner: () => userNode(),
    defaultBranchRef: (source) => {
      const repo = source.repo as Repo;
      const tip = refTip(repo, `refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      const repo = source.repo as Repo;
      const issue = repo.issues.get(asInt(args.number, -1));
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (source, args) => issuesConnection(source.repo as Repo, args),
    pullRequests: (source, args) => pullsConnection(source.repo as Repo, args),
    pullRequest: (source, args) => {
      const repo = source.repo as Repo;
      const pull = repo.pulls.get(asInt(args.number, -1));
      return pull === undefined ? null : pullNode(repo, pull);
    },
  },
  User: {
    id: (source) => b64url(`User:${asInt(source.id, 0)}`),
    login: (source) => asString(source.login),
    name: (source) => asString(source.name),
    email: (source) => asString(source.email),
  },
  Ref: {
    name: (source) => asString(source.name),
  },
  Issue: {
    id: (source) => globalId('Issue', (source.repo as Repo).id, (source.issue as Issue).number),
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    state: (source) => ((source.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (source) => (source.issue as Issue).body,
    createdAt: (source) => (source.issue as Issue).createdAt,
    updatedAt: (source) => (source.issue as Issue).updatedAt,
    author: () => userNode(),
    repository: (source) => ({ __typename: 'Repository', repo: source.repo as Repo }),
  },
  IssueConnection: {
    nodes: (source) => source.nodes as Node[],
    pageInfo: (source) => source.pageInfo as Node,
    totalCount: (source) => asInt(source.totalCount, 0),
  },
  PullRequestConnection: {
    nodes: (source) => source.nodes as Node[],
    pageInfo: (source) => source.pageInfo as Node,
    totalCount: (source) => asInt(source.totalCount, 0),
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage === true,
    hasPreviousPage: (source) => source.hasPreviousPage === true,
    startCursor: (source) => (source.startCursor as string | null) ?? null,
    endCursor: (source) => (source.endCursor as string | null) ?? null,
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source.repo as Repo).id, (source.pull as PullRequest).number),
    number: (source) => (source.pull as PullRequest).number,
    title: (source) => (source.pull as PullRequest).title,
    body: (source) => (source.pull as PullRequest).body,
    state: (source) => {
      const pull = source.pull as PullRequest;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (source) => (source.pull as PullRequest).merged,
    headRefName: (source) => (source.pull as PullRequest).headRef,
    baseRefName: (source) => (source.pull as PullRequest).baseRef,
    mergeable: (source) => pullMergeable(source.repo as Repo, source.pull as PullRequest),
    files: (source, args) => prFilesConnection(source.repo as Repo, source.pull as PullRequest, args),
    createdAt: (source) => (source.pull as PullRequest).createdAt,
    author: () => userNode(),
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => source.nodes as Node[],
    pageInfo: (source) => source.pageInfo as Node,
  },
  PullRequestChangedFile: {
    path: (source) => asString(source.path),
    additions: () => 0,
    deletions: () => 0,
  },
  __Type: {
    name: (source) => asString(source.name),
    kind: (source) => asString(source.kind),
    fields: (source) => (source.fields as string[]).map((name) => ({ __typename: '__Field', name })),
    enumValues: (source) => (source.enumValues as string[]).map((name) => ({ __typename: '__EnumValue', name })),
  },
  __Field: {
    name: (source) => asString(source.name),
  },
  __EnumValue: {
    name: (source) => asString(source.name),
  },
  CreateIssuePayload: {
    issue: (source) => source.issue as Node,
  },
  CloseIssuePayload: {
    issue: (source) => source.issue as Node,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as Node,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as Node,
  },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge as Node,
  },
  CommentEdge: {
    node: (source) => source.node as Node,
  },
  IssueComment: {
    id: (source) => asString(source.id),
    body: (source) => asString(source.body),
    author: () => userNode(),
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP entry
// ---------------------------------------------------------------------------------------------

/** Run one operation document and answer its {data, errors} envelope. */
function runOperation(ctx: Ctx, query: unknown, variables: unknown, operationName: unknown): Record<string, unknown> {
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  let operations: GqlOperation[];
  try {
    operations = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) {
    return { errors: [{ message: 'Must provide an operation.' }] };
  }
  let operation: GqlOperation | undefined;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const vars = typeof variables === 'object' && variables !== null && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  const exec = new Executor(ctx, vars);
  const data = exec.execute(operation);
  if (exec.errors.length > 0) return { data, errors: exec.errors };
  return { data };
}

/** Handle POST /api/graphql. Returns true when the path is the GraphQL route. */
export function handleGraphQL(ctx: Ctx): boolean {
  if (ctx.pathname !== '/api/graphql') return false;
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (!requireAuth(ctx)) return true;
  let body: unknown;
  try {
    body = ctx.body.length === 0 ? {} : JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  if (Array.isArray(body)) {
    // GitHub's operation batching: one response per operation, in order.
    const responses = body.map((entry) => {
      const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
      return runOperation(ctx, record.query, record.variables, record.operationName);
    });
    sendJson(ctx, 200, responses);
    return true;
  }
  if (typeof body !== 'object' || body === null) {
    sendJson(ctx, 400, { errors: [{ message: 'Must provide query string.' }] });
    return true;
  }
  const record = body as Record<string, unknown>;
  sendJson(ctx, 200, runOperation(ctx, record.query, record.variables, record.operationName));
  return true;
}
