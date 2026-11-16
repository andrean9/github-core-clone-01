// The forge's store: everything in memory, one process, no disk. A repository holds its git
// objects and refs plus its REST resources (labels, issues, pull requests, comments). Git helpers
// live here too: flat tree maps, commit creation, ancestry walks, merge-base, the three-way merge
// a squash merge needs, and the diff a pull request's files list needs.
//
// Determinism: every id is a counter, every timestamp comes from MAKEFUN_TRIAL_NOW, and every
// commit timestamp is the trial now plus a monotonic sequence, so two runs build byte-identical
// objects for identical requests.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';
import { VIEWER } from './scenario.ts';
import { isoOf, trialNowMs, trialNowSec, ZERO_OID } from './util.ts';

export { ZERO_OID };

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

/** The identity REST-created commits carry. */
export const FORGE_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly comments: IssueComment[];
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  headSha: string;
  readonly baseRef: string;
  baseSha: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  readonly fullName: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly createdSeq: number;
  /** Git objects by id. */
  readonly objects: Map<string, GitObject>;
  /** Refs by full name (`refs/heads/main`, `refs/tags/v1`). */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  nextNumber: number;
}

export class ForgeStore {
  /** Repositories by `owner/name`, in creation order. */
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextLabelId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextSeq = 0;
  /** Monotonic commit sequence: commit timestamps are trialNow + seq, so no two commits collide. */
  private commitSeq = 0;
  /** The trial's fixed now, parsed once: the env never changes it mid-process. */
  private readonly fixedNowSec = trialNowSec();
  private readonly fixedNowIso = isoOf(trialNowMs());

  /** The trial's fixed now, as an ISO timestamp for created_at/updated_at fields. */
  nowIso(): string {
    return this.fixedNowIso;
  }

  /** The next commit timestamp: trial now plus a monotonic sequence. */
  nextCommitTimestamp(): number {
    this.commitSeq += 1;
    return this.fixedNowSec + this.commitSeq;
  }

  nextSequence(): number {
    this.nextSeq += 1;
    return this.nextSeq;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  /** All repositories of one owner, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: this.nowIso(),
      createdSeq: this.nextSequence(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { id: this.nextLabelId++, name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
      createdSeq: this.nextSequence(),
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): PullRequest {
    const now = this.nowIso();
    const pull: PullRequest = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      createdAt: now,
      updatedAt: now,
      createdSeq: this.nextSequence(),
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  createComment(issue: Issue, body: string, userLogin: string): IssueComment {
    const comment: IssueComment = { id: this.nextCommentId++, body, userLogin, createdAt: this.nowIso() };
    issue.comments.push(comment);
    return comment;
  }
}

// ---------------------------------------------------------------------------------------------
// git helpers on a repo
// ---------------------------------------------------------------------------------------------

/** Store one object and answer its id. */
export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The tip of a ref, or undefined when the ref does not exist. */
export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

/** Resolve a ref name the way the REST API does: a branch name, a full ref, or a commit id. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (ref === '') return undefined;
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const head = repo.refs.get(`refs/heads/${ref}`);
  if (head !== undefined) return head;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  if (object !== undefined && object.type === 'tag') {
    const peeled = peelToCommit(repo, ref);
    return peeled ?? undefined;
  }
  return undefined;
}

/** Peel a tag (or a chain of tags) to the commit it names, or null when it names no commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** Whether `ancestor` is reachable from `tip` following parents (or equal to it). */
export function isAncestor(repo: Repo, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/**
 * The merge base of two commits: the first common ancestor found by a breadth-first walk from
 * `a` over the ancestor set of `b`. Exact for the linear histories the suite builds.
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfB = new Set<string>();
  const queueB: string[] = [b];
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  const seen = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length) {
    const oid = queueA.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  return null;
}

/** One flat tree entry: a path and the blob (or submodule) it names. */
export interface FlatEntry {
  readonly mode: string;
  readonly oid: string;
}

/** Flatten a tree into path → entry, walking subdirectories. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The flat file map of a commit's tree, or an empty map for an unborn branch. */
export function flattenCommit(repo: Repo, commitOid: string | undefined): Map<string, FlatEntry> {
  if (commitOid === undefined) return new Map();
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.data).tree);
}

/** Build (and store) the tree objects for a flat path map; answers the root tree id. */
export function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit object (stored) on top of `parents` with `tree`. */
export function createCommit(
  store: ForgeStore,
  repo: Repo,
  tree: string,
  parents: readonly string[],
  message: string,
): string {
  const data = buildCommit({
    tree,
    parents,
    message,
    author: FORGE_IDENTITY,
    committer: FORGE_IDENTITY,
    timestamp: store.nextCommitTimestamp(),
  });
  return putObject(repo, 'commit', data);
}

/** Walk a branch's commits newest-first (breadth-first over parents), deduplicated. */
export function walkCommits(repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// three-way merge and diff
// ---------------------------------------------------------------------------------------------

export interface MergeOutcome {
  /** The merged flat map, when the merge is clean. */
  readonly merged: Map<string, FlatEntry> | null;
  /** Paths both sides changed differently. */
  readonly conflicts: string[];
}

/**
 * A three-way merge of flat maps: `base` is the merge base, `ours` the base branch, `theirs` the
 * head branch. A path both sides changed differently (including modify-vs-delete) is a conflict.
 */
export function threeWayMerge(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): MergeOutcome {
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const bOid = b?.oid;
    const oOid = o?.oid;
    const tOid = t?.oid;
    if (oOid === tOid) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    if (tOid === bOid) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    if (oOid === bOid) {
      if (t !== undefined) merged.set(path, t);
      continue;
    }
    conflicts.push(path);
  }
  return conflicts.length > 0 ? { merged: null, conflicts } : { merged, conflicts };
}

/** One changed file of a diff. */
export interface DiffFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** Count the lines of a blob's bytes (a trailing newline does not start a new line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/**
 * The diff between two flat maps (base → head): added, modified and removed files, with line
 * counts. A modified file's additions/deletions are its new/old line counts — a simple, stable
 * measure the suite's shape checks accept.
 */
export function diffFlatMaps(
  repo: Repo,
  base: ReadonlyMap<string, FlatEntry>,
  head: ReadonlyMap<string, FlatEntry>,
): DiffFile[] {
  const out: DiffFile[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const sorted = [...paths].sort();
  for (const path of sorted) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const blobLines = (oid: string | undefined): number => {
      if (oid === undefined) return 0;
      const object = repo.objects.get(oid);
      return object !== undefined && object.type === 'blob' ? countLines(object.data) : 0;
    };
    if (b === undefined && h !== undefined) {
      const additions = blobLines(h.oid);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const deletions = blobLines(b.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const additions = blobLines(h.oid);
      const deletions = blobLines(b.oid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}
