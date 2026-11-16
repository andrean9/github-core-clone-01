// git smart HTTP: info/refs advertisements (protocol v2 and v0), upload-pack (v2 ls-refs and
// fetch, v0 fetch) and receive-pack (v0 push with report-status in sideband frames).
//
// The wire rules come from the suite's git-client.ts: pkt-line framing, the v2 section names
// (acknowledgments, shallow-info, packfile), sideband bands 1/2/3, and the packfile format.
// Fetches never emit deltas — a plain pack verifies the same — and the fetch object selection
// honours haves, the client's shallow boundary and depth, so incremental and shallow fetches
// send exactly the new objects.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  parseCommit,
  parseTag,
  readPack,
  writePack,
  type GitObject,
  type GitPacket,
} from './gitobj.ts';
import { isFastForward } from './rest.ts';
import { peelToCommit, type Repo } from './store.ts';
import { isObjectId, ZERO_OID } from './util.ts';
import { requireAuth, sendError, type Ctx } from './context.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Send a raw (non-JSON) body with the request id. */
function sendRaw(ctx: Ctx, status: number, contentType: string, body: Buffer): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(body);
}

/** Parse the /{owner}/{repo}.git/<service-path> route, or null when it is not a git route. */
function gitRoute(ctx: Ctx): { owner: string; repo: string; service: string } | null {
  const parts = ctx.pathname.split('/').filter((part) => part !== '');
  if (parts.length < 3) return null;
  const repoPart = parts[1];
  if (!repoPart.endsWith('.git')) return null;
  const service = parts.slice(2).join('/');
  if (service !== 'info/refs' && service !== 'git-upload-pack' && service !== 'git-receive-pack') return null;
  return { owner: parts[0], repo: repoPart.slice(0, -'.git'.length), service };
}

/** Handle a git smart-HTTP request. Returns true when the path is a git route. */
export function handleGit(ctx: Ctx): boolean {
  const route = gitRoute(ctx);
  if (route === null) return false;
  if (!requireAuth(ctx)) return true;
  const repo = ctx.store.getRepo(route.owner, route.repo);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  try {
    if (route.service === 'info/refs') return infoRefs(ctx, repo);
    if (route.service === 'git-upload-pack') return uploadPack(ctx, repo);
    return receivePack(ctx, repo);
  } catch (err) {
    // A malformed request must never take the server down: answer 400 and stay healthy.
    const message = err instanceof Error ? err.message : String(err);
    sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from(`bad request: ${message}\n`, 'utf8'));
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The commit an annotated tag peels to, or null when the ref is not an annotated tag. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

/** A v0 ref advertisement: the service preamble, then `<oid> <ref>` lines with capabilities. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta agent=${AGENT} object-format=sha1 shallow`
      : `symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get('refs/heads/main');
    let first = true;
    if (mainTip !== undefined) {
      parts.push(encodePktLine(`${mainTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [name, oid] of refs) {
      const line = first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`;
      parts.push(encodePktLine(line));
      first = false;
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** A v2 capability advertisement: the preamble, `version 2`, then capability lines. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

function infoRefs(ctx: Ctx, repo: Repo): boolean {
  const service = ctx.query.get('service');
  if (ctx.method !== 'GET' || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const wantsV2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    sendRaw(ctx, 200, UPLOAD_AD, v2Advertisement());
    return true;
  }
  const contentType = service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD;
  sendRaw(ctx, 200, contentType, v0Advertisement(service, repo));
  return true;
}

// ---------------------------------------------------------------------------------------------
// upload-pack: v2 ls-refs / fetch, v0 fetch
// ---------------------------------------------------------------------------------------------

function uploadPack(ctx: Ctx, repo: Repo): boolean {
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const { packets } = decodePktLines(ctx.body);
  const lines = packets.filter((packet): packet is Extract<GitPacket, { kind: 'data' }> => packet.kind === 'data');
  const firstLine = lines.length > 0 ? lines[0].payload.toString('utf8') : '';
  const isV2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2') || firstLine.startsWith('command=');
  if (isV2) return uploadPackV2(ctx, repo, packets);
  return uploadPackV0(ctx, repo, packets);
}

function lsRefsV2(ctx: Ctx, repo: Repo, args: string[]): boolean {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (keep('HEAD')) {
    if (mainTip !== undefined) {
      lines.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const body = encodePktLines([...lines, 'flush']);
  sendRaw(ctx, 200, UPLOAD_RESULT, body);
  return true;
}

interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | null;
}

/** Parse the argument lines of a v2 fetch command (after the delim). */
function parseFetchArgsV2(lines: string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const value = Number(text.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.trunc(value);
    }
    // thin-pack, no-progress, ofs-delta, filter, done, agent, object-format: accepted, no action.
  }
  return { wants, haves, shallow, depth };
}

/**
 * The objects a fetch sends, and its shallow-info. The walk from the wants is depth-limited when
 * a depth is set; the exclusion set is what the client already holds (reachable from its haves,
 * not descending past its shallow boundary). New shallow commits are the sent commits whose
 * parents the client will still lack; unshallow commits are old boundary commits whose parents
 * this fetch delivers.
 */
function selectFetch(repo: Repo, args: FetchArgs): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const boundary = new Set(args.shallow.filter(isObjectId));

  // Depth-limited walk from the wants.
  const walked = new Set<string>();
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of args.wants) {
    if (!isObjectId(want)) continue;
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      walked.add(want);
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject !== undefined && targetObject.type === 'commit') queue.push({ oid: target, depth: 1 });
      else if (targetObject !== undefined) walked.add(target);
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    } else {
      // A tree or blob want: include it and its closure outright.
      for (const oid of collectReachable([want], lookup, { allowMissing: true })) walked.add(oid);
    }
  }
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (args.depth !== null && depth > args.depth) continue;
    if (commitDepth.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    commitDepth.set(oid, depth);
    walked.add(oid);
    const commit = parseCommit(object.data);
    for (const treeOid of collectReachable([commit.tree], lookup, { allowMissing: true })) walked.add(treeOid);
    if (args.depth === null || depth < args.depth) {
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
  }

  // What the client already holds: reachable from its haves, stopping at its shallow boundary.
  const held = new Set<string>();
  const heldQueue: string[] = [...args.haves.filter(isObjectId), ...boundary];
  const heldSeen = new Set<string>();
  while (heldQueue.length) {
    const oid = heldQueue.pop()!;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = lookup(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const treeOid of collectReachable([commit.tree], lookup, { allowMissing: true })) held.add(treeOid);
      if (!boundary.has(oid)) for (const parent of commit.parents) heldQueue.push(parent);
    } else if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    } else {
      for (const child of collectReachable([oid], lookup, { allowMissing: true })) held.add(child);
    }
  }

  const send = new Set<string>();
  for (const oid of walked) if (!held.has(oid)) send.add(oid);

  // New shallow boundary: sent commits with a parent the client will still lack.
  const shallow: string[] = [];
  if (args.depth !== null) {
    for (const oid of commitDepth.keys()) {
      if (!send.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const cut = parents.some((parent) => !send.has(parent) && !held.has(parent));
      if (cut) shallow.push(oid);
    }
    shallow.sort();
  }
  // Unshallow: old boundary commits whose parents this fetch now delivers.
  const unshallow: string[] = [];
  for (const oid of boundary) {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) {
      unshallow.push(oid);
      continue;
    }
    if (parents.every((parent) => send.has(parent) || held.has(parent))) unshallow.push(oid);
  }
  unshallow.sort();

  const objects = new Map<string, GitObject>();
  for (const oid of [...send].sort()) {
    const object = lookup(oid);
    if (object !== undefined) objects.set(oid, object);
  }
  return { objects, shallow, unshallow };
}

/** Chunk bytes into sideband band-1 pkt-lines (each at most PKT_LINE_MAX total). */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxData = 65520 - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return chunks;
}

function fetchV2(ctx: Ctx, repo: Repo, args: FetchArgs): boolean {
  const { objects, shallow, unshallow } = selectFetch(repo, args);
  const pack = writePack(objects.values());
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  sendRaw(ctx, 200, UPLOAD_RESULT, Buffer.concat(parts));
  return true;
}

function uploadPackV2(ctx: Ctx, repo: Repo, packets: readonly GitPacket[]): boolean {
  const lines = packets.filter((packet): packet is Extract<GitPacket, { kind: 'data' }> => packet.kind === 'data');
  const texts = lines.map((packet) => packet.payload.toString('utf8'));
  const commandLine = texts.find((text) => text.startsWith('command='));
  const command = commandLine === undefined ? '' : commandLine.slice('command='.length).replace(/\n$/, '');
  // Arguments come after the delim packet; everything before it is the command header.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argTexts: string[] = [];
  if (delimIndex >= 0) {
    for (const packet of packets.slice(delimIndex + 1)) {
      if (packet.kind === 'data') argTexts.push(packet.payload.toString('utf8'));
    }
  }
  if (command === 'ls-refs') return lsRefsV2(ctx, repo, argTexts.map((text) => text.replace(/\n$/, '')));
  if (command === 'fetch') return fetchV2(ctx, repo, parseFetchArgsV2(argTexts));
  sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from(`unknown v2 command ${JSON.stringify(command)}\n`, 'utf8'));
  return true;
}

function uploadPackV0(ctx: Ctx, repo: Repo, packets: readonly GitPacket[]): boolean {
  const texts = packets
    .filter((packet): packet is Extract<GitPacket, { kind: 'data' }> => packet.kind === 'data')
    .map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const text of texts) {
    if (text.startsWith('want ')) {
      const oid = text.slice(5).split(' ')[0];
      if (isObjectId(oid)) wants.push(oid);
    } else if (text.startsWith('have ')) {
      const oid = text.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (text.startsWith('shallow ')) {
      const oid = text.slice(8).trim();
      if (isObjectId(oid)) shallow.push(oid);
    } else if (text.startsWith('deepen ')) {
      const value = Number(text.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.trunc(value);
    }
    // done: negotiation is over; the pack follows.
  }
  const { objects, shallow: newShallow, unshallow } = selectFetch(repo, { wants, haves, shallow, depth });
  const pack = writePack(objects.values());
  const parts: Buffer[] = [];
  for (const oid of newShallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(encodePktLine('NAK\n'));
  parts.push(...sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  sendRaw(ctx, 200, UPLOAD_RESULT, Buffer.concat(parts));
  return true;
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function receivePack(ctx: Ctx, repo: Repo): boolean {
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  // The command list is pkt-lines up to the first flush; everything after it is the raw pack,
  // which is not pkt-line framed, so the framing parse stops at the flush.
  const commands: PushCommand[] = [];
  let capabilities = '';
  let offset = 0;
  let sawFlush = false;
  const body = ctx.body;
  while (offset < body.length) {
    if (offset + 4 > body.length) {
      sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('truncated pkt-line in receive-pack\n', 'utf8'));
      return true;
    }
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('bad pkt-line in receive-pack\n', 'utf8'));
      return true;
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (length < 4 || length > 65520 || offset + length > body.length) {
      sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('bad pkt-line length in receive-pack\n', 'utf8'));
      return true;
    }
    const text = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = text.indexOf('\0');
    const line = (nul < 0 ? text : text.slice(0, nul)).replace(/\n$/, '');
    if (nul >= 0 && capabilities === '') capabilities = text.slice(nul + 1).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) {
      sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('bad receive-pack command\n', 'utf8'));
      return true;
    }
    const [oldOid, newOid, ref] = parts;
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
      sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('bad receive-pack command\n', 'utf8'));
      return true;
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush || commands.length === 0) {
    sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('no receive-pack commands\n', 'utf8'));
    return true;
  }
  const packBytes = body.subarray(offset);

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid !== ZERO_OID && !repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} stale info\n`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
          continue;
        }
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (current !== ZERO_OID && !isFastForward(repo, current, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  }

  const inner = encodePktLines([`unpack ${unpackDetail}\n`, ...reportLines, 'flush']);
  const sideband = capabilities.split(' ').includes('side-band-64k');
  const parts: Buffer[] = [];
  if (sideband) {
    const maxData = 65520 - 4 - 1;
    for (let offset = 0; offset < inner.length; offset += maxData) {
      const slice = inner.subarray(offset, Math.min(inner.length, offset + maxData));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  } else {
    parts.push(inner);
  }
  parts.push(Buffer.from('0000', 'ascii'));
  sendRaw(ctx, 200, RECEIVE_RESULT, Buffer.concat(parts));
  return true;
}
