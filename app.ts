// A standalone GitHub-compatible git forge: git smart HTTP (upload-pack v2, receive-pack v0),
// REST v3, GraphQL v4 and an MCP endpoint, all over one in-memory store, Node stdlib only.
//
// The store is deliberately plain: repositories hold their git objects, refs, labels, issues and
// pull requests in Maps. Git objects are content-addressed exactly as git computes them (SHA-1 over
// "<type> <size>\0" + bytes), so objects created through the REST contents API and objects pushed
// over git live in the same map and read back through either surface unchanged.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0'.repeat(40);
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// --------------------------------------------------------------------------- time
// A monotonic fake clock: timestamps in API bodies stay deterministic for a given request
// sequence (the trial replays the same sequence), without ever reading the wall clock into data
// that must match between runs. The base is a fixed epoch; every stamp advances it by a second.
let clockSeq = 0;
const CLOCK_BASE = 1730000000;
function stamp(): { epoch: number; iso: string } {
  clockSeq += 1;
  const epoch = CLOCK_BASE + clockSeq;
  return { epoch, iso: new Date(epoch * 1000).toISOString() };
}
function isoNow(): string {
  return stamp().iso;
}

// --------------------------------------------------------------------------- ids
let nextRepoId = 1;
let nextIssueGlobalId = 1;
let nextPullGlobalId = 1;
let nextCommentGlobalId = 1;
let nextLabelId = 1;
let requestSeq = 0;

/** Relay-style global id: base64 of "<Type>:<numeric id>", opaque and stable across reads. */
function globalId(type: string, numeric: number): string {
  return Buffer.from(`${type}:${numeric}`, 'utf8').toString('base64');
}
function decodeGlobalId(id: string): { type: string; numeric: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    const numeric = Number(text.slice(at + 1));
    if (!Number.isSafeInteger(numeric)) return null;
    return { type: text.slice(0, at), numeric };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- model
type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}
interface Comment {
  id: number;
  body: string;
  createdAt: string;
}
interface Issue {
  globalIdNum: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  seq: number;
}
interface Pull {
  globalIdNum: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAt: string;
  seq: number;
}
interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  createdAt: string;
}

const repos = new Map<string, Repo>();
let viewerLogin: string | null = null;

/** The token owner's login, learned from the first owner-scoped path that names an existing repo. */
function viewer(): string {
  return viewerLogin ?? 'adaiversen';
}
function learnViewer(owner: string): void {
  if (viewerLogin === null && owner !== '') viewerLogin = owner;
}

/**
 * Resolve a repository by owner + name. A repository belongs to the token's login: once that login
 * is known, the same name under another owner is not found (404, never 403). Before it is known,
 * naming an existing repository teaches it.
 */
function findRepo(owner: string, name: string): Repo | null {
  const repo = repos.get(name);
  if (!repo) return null;
  if (viewerLogin !== null && owner !== viewerLogin) return null;
  if (viewerLogin === null) learnViewer(owner);
  return repo;
}
function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo | null {
  if (repos.has(name)) return null;
  const repo: Repo = {
    id: nextRepoId++,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdAt: isoNow(),
  };
  repos.set(name, repo);
  return repo;
}

// --------------------------------------------------------------------------- git objects
function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}
function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}
function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}
function buildCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const { epoch } = stamp();
  const who = `Forge <forge@example.invalid> ${epoch} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return storeObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8'));
}

/** Peel an object id to the commit it names (through annotated tags), or null. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}
/** The commit a ref names, or null when the ref is missing or not commit-like. */
function refCommit(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (!oid) return null;
  return peelToCommit(repo, oid);
}
/** Every object reachable from the given tips (commits, trees, blobs, tags). */
function reachable(repo: Repo, tips: Iterable<string>, stopParentsOf?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!stopParentsOf || !stopParentsOf.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}
/** True when `ancestor` is reachable from `descendant` by parent links (or equal to it). */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}
/** The commits reachable from `tip`, newest first (breadth by generation, then discovery order). */
function listCommits(repo: Repo, tip: string): string[] {
  const levels = new Map<string, number>();
  const queue: Array<{ oid: string; level: number }> = [{ oid: tip, level: 0 }];
  const order: string[] = [];
  while (queue.length) {
    const { oid, level } = queue.shift() as { oid: string; level: number };
    if (levels.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    levels.set(oid, level);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, level: level + 1 });
  }
  return order.sort((a, b) => (levels.get(a) as number) - (levels.get(b) as number));
}
/** A merge base of two commits: the common ancestor with the smallest distance sum. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    const queue: Array<{ oid: string; d: number }> = [{ oid: tip, d: 0 }];
    while (queue.length) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (dist.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      dist.set(oid, d);
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
    return dist;
  };
  const da = ancestorsOf(a);
  const db = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, d] of da) {
    const other = db.get(oid);
    if (other !== undefined && d + other < bestScore) {
      bestScore = d + other;
      best = oid;
    }
  }
  return best;
}

// --------------------------------------------------------------------------- trees as file maps
/** Flatten a tree (recursively) into a path -> blob oid map. */
function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}
function treeOfCommit(repo: Repo, commitOid: string): Map<string, string> {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.data).tree);
}
/** Build (and store) a tree from a flat path -> blob oid map; returns the tree oid. */
function buildTreeFromMap(repo: Repo, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
/** Commit a file map onto a branch ref; returns the new commit oid. */
function commitFiles(repo: Repo, branchRef: string, files: Map<string, string>, message: string): string {
  const tree = buildTreeFromMap(repo, files);
  const parent = refCommit(repo, branchRef);
  const commit = buildCommit(repo, tree, parent ? [parent] : [], message);
  repo.refs.set(branchRef, commit);
  return commit;
}

// --------------------------------------------------------------------------- packfiles
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}
/** A packfile of plain (non-delta) objects, with its SHA-1 trailer. */
function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return out;
}
/** Read a packfile into a repo's store (resolving OFS/REF deltas, thin bases from the store). */
function readPackInto(repo: Repo, pack: Buffer): void {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++] as number;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset++] as number;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++] as number;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<number, { type: GitObjectType; data: Buffer }>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    let result: { type: GitObjectType; data: Buffer };
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      let base: { type: GitObjectType; data: Buffer } | undefined;
      for (const candidate of raw) {
        if (candidate === entry) continue;
        const candidateResolved = resolved.get(candidate.offset);
        if (candidateResolved && hashObject(candidateResolved.type, candidateResolved.data) === entry.baseOid) {
          base = candidateResolved;
          break;
        }
      }
      if (!base) {
        const external = repo.objects.get(entry.baseOid as string);
        if (!external) throw new Error('ref-delta base missing');
        base = external;
      }
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = CODE_TYPE[entry.typeCode];
      if (!type) throw new Error('unknown pack type');
      result = { type, data: entry.data };
    }
    resolved.set(entry.offset, result);
    return result;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    storeObject(repo, object.type, object.data);
  }
}

// --------------------------------------------------------------------------- pkt-line
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
/** Decode every pkt-line in a request body; returns payloads and control markers in order. */
function decodePktLines(body: Buffer): Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    out.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}
/** The byte offset just past the pkt-line command list (where a push pack begins). */
function pktListEnd(body: Buffer): number {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return offset;
    const length = parseInt(header, 16);
    if (length === 0) return offset + 4;
    if (length < 4) return offset + 4;
    offset += length;
  }
  return offset;
}

// --------------------------------------------------------------------------- HTTP helpers
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  requestSeq += 1;
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': `req-${requestSeq}`,
    ...(text !== '' ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  requestSeq += 1;
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': `req-${requestSeq}` });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** Parse a JSON request body: {ok:true,value} or {ok:false} for malformed JSON (a 400 on the wire). */
function parseJsonBody(raw: Buffer): { ok: boolean; value: Record<string, unknown> } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, value: {} };
  }
}
function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function strOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}
function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// --------------------------------------------------------------------------- serializers
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${viewer()}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: viewer(), id: 1000, type: 'User' },
    html_url: `/${viewer()}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}
function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.globalIdNum,
    node_id: globalId('Issue', issue.globalIdNum),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is Label => label !== undefined)
      .map(labelJson),
    user: { login: viewer(), id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    repository_url: `/api/v3/repos/${viewer()}/${repo.name}`,
  };
}
function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: { login: viewer(), id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = refCommit(repo, `refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = refCommit(repo, `refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: pull.globalIdNum,
    node_id: globalId('PullRequest', pull.globalIdNum),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${viewer()}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${viewer()}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? true : computeMergeable(repo, pull) === 'mergeable',
    mergeable_state: pull.merged ? 'clean' : computeMergeable(repo, pull) === 'mergeable' ? 'clean' : 'dirty',
    user: { login: viewer(), id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}
function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit = object && object.type === 'commit' ? parseCommit(object.data) : { tree: ZERO_OID, parents: [], author: '', committer: '', message: '' };
  const splitWho = (who: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) /.exec(who);
    if (!match) return { name: who, email: '', date: new Date(CLOCK_BASE * 1000).toISOString() };
    return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      author: splitWho(commit.author),
      committer: splitWho(commit.committer),
    },
    author: { login: viewer() },
    committer: { login: viewer() },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// --------------------------------------------------------------------------- merges
type Mergeable = 'mergeable' | 'conflicting';
/** Three-way file-level mergeability: both sides changed the same path to different bytes. */
function computeMergeable(repo: Repo, pull: Pull): Mergeable {
  const head = refCommit(repo, `refs/heads/${pull.headRef}`);
  const base = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (!head || !base) return 'conflicting';
  const baseOfMerge = mergeBase(repo, head, base);
  if (!baseOfMerge) return 'conflicting';
  const ancestorFiles = treeOfCommit(repo, baseOfMerge);
  const headFiles = treeOfCommit(repo, head);
  const baseFiles = treeOfCommit(repo, base);
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const headValue = headFiles.get(path);
    const baseValue = baseFiles.get(path);
    const headChanged = headValue !== ancestor;
    const baseChanged = baseValue !== ancestor;
    if (headChanged && baseChanged && headValue !== baseValue) return 'conflicting';
  }
  return 'mergeable';
}
/** The merged file map: the head's changes since the merge base, applied onto the base tip. */
function mergedFiles(repo: Repo, pull: Pull): Map<string, string> | null {
  const head = refCommit(repo, `refs/heads/${pull.headRef}`);
  const base = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (!head || !base) return null;
  const baseOfMerge = mergeBase(repo, head, base);
  if (!baseOfMerge) return null;
  const ancestorFiles = treeOfCommit(repo, baseOfMerge);
  const headFiles = treeOfCommit(repo, head);
  const result = new Map(treeOfCommit(repo, base));
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const headValue = headFiles.get(path);
    if (headValue === ancestor) continue;
    if (headValue === undefined) result.delete(path);
    else result.set(path, headValue);
  }
  return result;
}
/** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or 'conflict'. */
function mergePull(repo: Repo, pull: Pull): string | 'conflict' {
  if (computeMergeable(repo, pull) !== 'mergeable') return 'conflict';
  const files = mergedFiles(repo, pull);
  const baseTip = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (!files || !baseTip) return 'conflict';
  const tree = buildTreeFromMap(repo, files);
  const sha = buildCommit(repo, tree, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = sha;
  return sha;
}
/** Changed files between a pull's merge base and its head, with line counts. */
function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const head = refCommit(repo, `refs/heads/${pull.headRef}`);
  const base = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (!head || !base) return [];
  const baseOfMerge = mergeBase(repo, head, base) ?? base;
  const before = treeOfCommit(repo, baseOfMerge);
  const after = treeOfCommit(repo, head);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const out: Array<Record<string, unknown>> = [];
  const linesOf = (oid: string | undefined): string[] => {
    if (!oid) return [];
    const object = repo.objects.get(oid);
    if (!object) return [];
    const text = object.data.toString('utf8');
    return text === '' ? [] : text.split('\n');
  };
  for (const path of [...paths].sort()) {
    const oldOid = before.get(path);
    const newOid = after.get(path);
    if (oldOid === newOid) continue;
    const oldLines = linesOf(oldOid);
    const newLines = linesOf(newOid);
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const count = oldCounts.get(line) ?? 0;
      if (count > 0) oldCounts.set(line, count - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const count of oldCounts.values()) deletions += count;
    if (additions + deletions === 0) additions = 1;
    out.push({
      filename: path,
      status: oldOid === undefined ? 'added' : newOid === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: newOid ?? oldOid,
    });
  }
  return out;
}
function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    globalIdNum: nextIssueGlobalId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: isoNow(),
    seq: clockSeq,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}
function createPullRecord(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
  const pull: Pull = {
    globalIdNum: nextPullGlobalId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    createdAt: isoNow(),
    seq: clockSeq,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}
function labelNamesOf(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).name === 'string') {
      names.push((entry as Record<string, unknown>).name as string);
    }
  }
  return names;
}
function bareRef(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

// --------------------------------------------------------------------------- REST v3
function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
function paginate<T>(req: IncomingMessage, url: URL, items: T[], routePath: string): { page: T[]; link: string | null } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(routePath, baseUrlOf(req));
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(routePath, baseUrlOf(req));
    for (const [key, value] of url.searchParams) last.searchParams.set(key, value);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(lastPage));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const rawPath = url.pathname;
  const segments = rawPath
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => {
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    });
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);
  const rawBody = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
  await routeRest(req, res, url, method, rest, rawBody);
}

async function routeRest(req: IncomingMessage, res: ServerResponse, url: URL, method: string, rest: string[], rawBody: Buffer): Promise<void> {
  const parsed = parseJsonBody(rawBody);
  const body = parsed.value;
  const jsonBody = (): Record<string, unknown> | null => {
    if (!parsed.ok) {
      errJson(res, 400, 'Problems parsing JSON');
      return null;
    }
    return body;
  };

  // Root and meta.
  if (rest.length === 0) {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    return sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    return sendJson(res, 200, { login: viewer(), id: 1000, type: 'User', name: viewer() });
  }

  // The viewer's repositories.
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.id - b.id).map(repoJson);
      const { page, link } = paginate(req, url, all, '/api/v3/user/repos');
      return sendJson(res, 200, page, link ? { link } : {});
    }
    if (method === 'POST') {
      const data = jsonBody();
      if (!data) return;
      const name = str(data.name);
      if (name === '') return errJson(res, 422, 'name is required');
      if (repos.has(name)) return errJson(res, 422, 'name already exists on this account: Repository already exists');
      const repo = createRepoRecord(name, str(data.description), boolOr(data.private, false)) as Repo;
      if (typeof data.default_branch === 'string' && data.default_branch !== '') repo.defaultBranch = data.default_branch;
      return sendJson(res, 201, repoJson(repo));
    }
    return errJson(res, 404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) return errJson(res, 404, 'Not Found');
  const owner = rest[1] as string;
  const repoName = rest[2] as string;
  const tail = rest.slice(3);
  const repo = findRepo(owner, repoName);
  if (!repo) return errJson(res, 404, 'Not Found');
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const data = jsonBody();
      if (!data) return;
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.name === 'string' && data.name !== '' && data.name !== repo.name && !repos.has(data.name)) {
        repos.delete(repo.name);
        repo.name = data.name;
        repos.set(repo.name, repo);
      }
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      if (typeof data.default_branch === 'string' && data.default_branch !== '') repo.defaultBranch = data.default_branch;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      repos.delete(repo.name);
      requestSeq += 1;
      res.writeHead(204, { 'x-github-request-id': `req-${requestSeq}` });
      res.end();
      return;
    }
    return errJson(res, 404, 'Not Found');
  }

  // Branches.
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: refCommit(repo, `refs/heads/${name}`) ?? ZERO_OID }, protected: false }));
      return sendJson(res, 200, branches);
    }
    if (tail.length >= 2 && method === 'GET') {
      const name = tail.slice(1).join('/');
      const sha = refCommit(repo, `refs/heads/${name}`);
      if (!sha) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, { name, commit: { sha }, protected: false });
    }
    return errJson(res, 404, 'Not Found');
  }

  // Commits.
  if (tail[0] === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      let tip: string | null = null;
      if (shaParam) {
        tip = refCommit(repo, `refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? peelToCommit(repo, shaParam) : null);
      } else {
        tip = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
      }
      if (!tip) return sendJson(res, 200, []);
      return sendJson(res, 200, listCommits(repo, tip).map((oid) => commitJson(repo, oid)));
    }
    if (tail.length === 2 && method === 'GET') {
      const oid = tail[1] as string;
      if (!repo.objects.has(oid)) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, commitJson(repo, oid));
    }
    return errJson(res, 404, 'Not Found');
  }

  // Git refs (Git Data).
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const data = jsonBody();
      if (!data) return;
      const ref = str(data.ref);
      const sha = str(data.sha);
      if (ref === '' || !repo.objects.has(sha)) return errJson(res, 422, 'sha is not a valid object');
      if (repo.refs.has(ref)) return errJson(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (tail.length >= 3 && method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (tail.length >= 3 && method === 'DELETE') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      if (!repo.refs.has(ref)) return errJson(res, 404, 'Not Found');
      repo.refs.delete(ref);
      requestSeq += 1;
      res.writeHead(204, { 'x-github-request-id': `req-${requestSeq}` });
      res.end();
      return;
    }
    return errJson(res, 404, 'Not Found');
  }

  // Contents.
  if (tail[0] === 'contents') {
    const filePath = tail.slice(1).join('/');
    return handleContents(req, res, url, method, repo, filePath, rawBody);
  }

  // Labels.
  if (tail[0] === 'labels') {
    if (tail.length === 1 && method === 'GET') return sendJson(res, 200, [...repo.labels.values()].map(labelJson));
    if (tail.length === 1 && method === 'POST') {
      const data = jsonBody();
      if (!data) return;
      const name = str(data.name);
      if (name === '') return errJson(res, 422, 'name is required');
      if (repo.labels.has(name)) return errJson(res, 422, 'Validation Failed: label already exists');
      const label: Label = {
        id: nextLabelId++,
        name,
        color: strOr(data.color, 'ededed').replace(/^#/, ''),
        description: typeof data.description === 'string' ? data.description : null,
      };
      repo.labels.set(name, label);
      return sendJson(res, 201, labelJson(label));
    }
    return errJson(res, 404, 'Not Found');
  }

  // Issues and comments.
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        const direction = url.searchParams.get('direction') ?? (url.searchParams.get('sort') ? 'desc' : 'desc');
        list.sort((a, b) => a.number - b.number);
        if (direction !== 'asc') list.reverse();
        const { page, link } = paginate(req, url, list.map((issue) => issueJson(repo, issue)), `${repoPath}/issues`);
        return sendJson(res, 200, page, link ? { link } : {});
      }
      if (method === 'POST') {
        const data = jsonBody();
        if (!data) return;
        const labels = labelNamesOf(data);
        for (const name of labels) {
          if (!repo.labels.has(name)) return errJson(res, 422, `Validation Failed: label '${name}' does not exist`);
        }
        const issue = createIssueRecord(repo, str(data.title), str(data.body), labels);
        return sendJson(res, 201, issueJson(repo, issue));
      }
      return errJson(res, 404, 'Not Found');
    }
    const number = Number(tail[1]);
    const issue = Number.isSafeInteger(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 2) {
      if (!issue) return errJson(res, 404, 'Not Found');
      if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const data = jsonBody();
        if (!data) return;
        if (typeof data.title === 'string') issue.title = data.title;
        if (typeof data.body === 'string') issue.body = data.body;
        if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
        if (data.labels !== undefined) {
          const labels = labelNamesOf(data);
          for (const name of labels) if (!repo.labels.has(name)) return errJson(res, 422, `Validation Failed: label '${name}' does not exist`);
          issue.labels = labels;
        }
        return sendJson(res, 200, issueJson(repo, issue));
      }
      return errJson(res, 404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (!issue) return errJson(res, 404, 'Not Found');
      if (method === 'GET') return sendJson(res, 200, issue.comments.map(commentJson));
      if (method === 'POST') {
        const data = jsonBody();
        if (!data) return;
        const comment: Comment = { id: nextCommentGlobalId++, body: str(data.body), createdAt: isoNow() };
        issue.comments.push(comment);
        return sendJson(res, 201, commentJson(comment));
      }
      return errJson(res, 404, 'Not Found');
    }
    return errJson(res, 404, 'Not Found');
  }

  // Pull requests.
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        list.sort((a, b) => a.number - b.number);
        const { page, link } = paginate(req, url, list.map((pull) => pullJson(repo, pull)), `${repoPath}/pulls`);
        return sendJson(res, 200, page, link ? { link } : {});
      }
      if (method === 'POST') {
        const data = jsonBody();
        if (!data) return;
        const head = bareRef(str(data.head));
        const base = bareRef(strOr(data.base, repo.defaultBranch));
        if (!repo.refs.has(`refs/heads/${head}`)) return errJson(res, 422, `Validation Failed: head '${head}' does not exist`);
        if (!repo.refs.has(`refs/heads/${base}`)) return errJson(res, 422, `Validation Failed: base '${base}' does not exist`);
        const pull = createPullRecord(repo, str(data.title), str(data.body), head, base);
        return sendJson(res, 201, pullJson(repo, pull));
      }
      return errJson(res, 404, 'Not Found');
    }
    const number = Number(tail[1]);
    const pull = Number.isSafeInteger(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 2 && method === 'GET') {
      if (!pull) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, pullJson(repo, pull));
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (!pull) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, pullFiles(repo, pull));
    }
    if (tail.length === 3 && tail[2] === 'merge' && (method === 'PUT' || method === 'POST')) {
      if (!pull) return errJson(res, 404, 'Not Found');
      const data = jsonBody();
      if (!data) return;
      if (pull.merged || pull.state === 'closed') return errJson(res, 405, 'Pull Request is not open');
      const result = mergePull(repo, pull);
      if (result === 'conflict') return errJson(res, 405, 'Pull Request is not mergeable');
      return sendJson(res, 200, { sha: result, merged: true, message: 'Pull Request successfully merged' });
    }
    return errJson(res, 404, 'Not Found');
  }

  return errJson(res, 404, 'Not Found');
}

/** The contents API: files and directories on a branch, committed through the git store. */
function handleContents(req: IncomingMessage, res: ServerResponse, url: URL, method: string, repo: Repo, filePath: string, rawBody: Buffer): void {
  const parsed = parseJsonBody(rawBody);
  const body = parsed.value;
  const branchOf = (): string => strOr(body.branch, url.searchParams.get('ref') ?? repo.defaultBranch);
  const resolveTree = (refName: string): Map<string, string> | null => {
    const commit = refCommit(repo, `refs/heads/${refName}`) ?? (repo.objects.has(refName) ? peelToCommit(repo, refName) : null);
    if (!commit) return null;
    return treeOfCommit(repo, commit);
  };

  if (method === 'GET') {
    const refName = url.searchParams.get('ref') ?? repo.defaultBranch;
    const files = resolveTree(refName);
    if (!files) return errJson(res, 404, 'Not Found');
    if (filePath !== '' && files.has(filePath)) {
      const oid = files.get(filePath) as string;
      const object = repo.objects.get(oid);
      const data = object ? object.data : Buffer.alloc(0);
      return sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: oid,
        size: data.length,
        name: filePath.split('/').pop(),
        path: filePath,
      });
    }
    // Directory listing: immediate children of filePath (or the root).
    const prefix = filePath === '' ? '' : `${filePath}/`;
    const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
    let isDir = filePath === '';
    for (const [path, oid] of files) {
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      const restPath = path.slice(prefix.length);
      if (restPath === '') continue;
      isDir = true;
      const slash = restPath.indexOf('/');
      if (slash < 0) {
        const object = repo.objects.get(oid);
        children.set(restPath, { type: 'file', sha: oid, size: object ? object.data.length : 0 });
      } else {
        const dirName = restPath.slice(0, slash);
        if (!children.has(dirName)) {
          // The subtree's tree oid: rebuild from the commit's tree walk.
          children.set(dirName, { type: 'dir', sha: subtreeSha(repo, refName, prefix + dirName), size: 0 });
        }
      }
    }
    if (!isDir) return errJson(res, 404, 'Not Found');
    const entries = [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, info]) => ({ type: info.type, name, path: prefix + name, sha: info.sha, size: info.size }));
    return sendJson(res, 200, entries);
  }

  if (method === 'PUT') {
    if (!parsed.ok) return errJson(res, 400, 'Problems parsing JSON');
    const branch = branchOf();
    const branchRef = `refs/heads/${branch}`;
    let files = resolveTree(branch);
    let baseCommit: string | null = refCommit(repo, branchRef);
    if (!files) {
      // An unborn branch (or a brand-new branch name) starts from the default branch's tree.
      files = resolveTree(repo.defaultBranch) ?? new Map<string, string>();
      baseCommit = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
      if (!repo.refs.has(branchRef) && baseCommit) {
        // New branch forks from the default tip; an unborn repo starts empty.
        repo.refs.set(branchRef, baseCommit);
      }
    }
    const content = Buffer.from(str(body.content).replace(/[\r\n\t ]+/g, ''), 'base64');
    const existing = files.get(filePath);
    if (existing !== undefined && typeof body.sha === 'string' && body.sha !== existing) {
      return errJson(res, 409, 'Conflict: the file has changed since the sha was read');
    }
    const blobOid = storeObject(repo, 'blob', content);
    files.set(filePath, blobOid);
    const tree = buildTreeFromMap(repo, files);
    const commit = buildCommit(repo, tree, baseCommit ? [baseCommit] : [], strOr(body.message, 'Update file'));
    repo.refs.set(branchRef, commit);
    const status = existing !== undefined ? 200 : 201;
    return sendJson(res, status, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit, message: strOr(body.message, 'Update file') },
    });
  }

  if (method === 'DELETE') {
    if (!parsed.ok) return errJson(res, 400, 'Problems parsing JSON');
    const branch = branchOf();
    const branchRef = `refs/heads/${branch}`;
    const files = resolveTree(branch);
    if (!files || !files.has(filePath)) return errJson(res, 404, 'Not Found');
    const existing = files.get(filePath) as string;
    if (typeof body.sha === 'string' && body.sha !== existing) return errJson(res, 409, 'Conflict: sha does not match');
    files.delete(filePath);
    const baseCommit = refCommit(repo, branchRef);
    const tree = buildTreeFromMap(repo, files);
    const commit = buildCommit(repo, tree, baseCommit ? [baseCommit] : [], strOr(body.message, 'Delete file'));
    repo.refs.set(branchRef, commit);
    return sendJson(res, 200, { content: null, commit: { sha: commit, message: strOr(body.message, 'Delete file') } });
  }

  return errJson(res, 404, 'Not Found');
}
/** The tree oid of a directory path on a branch (for directory listings). */
function subtreeSha(repo: Repo, refName: string, dirPath: string): string {
  const commit = refCommit(repo, `refs/heads/${refName}`);
  if (!commit) return ZERO_OID;
  const commitObject = repo.objects.get(commit);
  if (!commitObject || commitObject.type !== 'commit') return ZERO_OID;
  let treeOid = parseCommit(commitObject.data).tree;
  for (const segment of dirPath.split('/').filter((piece) => piece !== '')) {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return ZERO_OID;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return ZERO_OID;
    treeOid = entry.oid;
  }
  return treeOid;
}

// --------------------------------------------------------------------------- git smart HTTP
/** Parse a full pkt-line stream (a request without a trailing pack) into lines and markers. */
function parsePktStream(body: Buffer): Array<string | 'flush' | 'delim'> {
  const out: Array<string | 'flush' | 'delim'> = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      out.push('flush');
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push('delim');
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    out.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return out;
}
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const target = parseTag(object.data).object;
  return repo.objects.has(target) ? target : null;
}

function advertisement(repo: Repo, service: string, wantV2: boolean): Buffer {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  if (service === 'git-upload-pack' && wantV2) {
    const parts = [
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done filter\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    return Buffer.concat(parts);
  }
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=forge/1.0 symref=HEAD:${headRef} object-format=sha1`
      : `report-status delete-refs side-band-64k ofs-delta agent=forge/1.0 symref=HEAD:${headRef}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(headRef);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(pktLine(`${ZERO_OID} HEAD\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peeledOf(repo, oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const lines: string[] = [];
  if (keep('HEAD')) {
    if (headTip) lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    else if (unborn) lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

interface FetchPlan {
  send: GitObject[];
  shallow: string[];
  unshallow: string[];
}
function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, clientShallow: string[]): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const clientHas =
    depth !== null && shallowSet.size > 0 ? reachable(repo, haves, shallowSet) : reachable(repo, haves);
  const included = new Set<string>();
  const boundary: string[] = [];
  if (depth !== null) {
    // Level-limited walk: commits carry a generation level; trees and blobs ride with their commit.
    const levels = new Map<string, number>();
    const queue: Array<{ oid: string; level: number }> = [];
    for (const want of wants) queue.push({ oid: want, level: 1 });
    const includeTree = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length) {
        const oid = stack.pop() as string;
        if (included.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (!object) continue;
        included.add(oid);
        if (object.type === 'tree') for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.oid);
      }
    };
    while (queue.length) {
      const { oid, level } = queue.shift() as { oid: string; level: number };
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        included.add(oid);
        queue.push({ oid: parseTag(object.data).object, level });
        continue;
      }
      if (object.type !== 'commit') {
        included.add(oid);
        continue;
      }
      const known = levels.get(oid);
      if (known !== undefined && known <= level) continue;
      levels.set(oid, level);
      included.add(oid);
      const commit = parseCommit(object.data);
      includeTree(commit.tree);
      if (level < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
      } else if (commit.parents.length > 0) {
        if (!boundary.includes(oid)) boundary.push(oid);
      }
    }
  } else {
    for (const oid of reachable(repo, wants)) included.add(oid);
  }
  const send: GitObject[] = [];
  for (const oid of included) {
    if (clientHas.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) send.push(object);
  }
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    if (included.has(oid) && !boundary.includes(oid)) unshallow.push(oid);
  }
  return { send, shallow: boundary, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  if (pack.length === 0) return packets;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

function handleFetch(repo: Repo, args: string[], version2: boolean): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
  }
  const plan = planFetch(repo, wants, haves, depth, clientShallow);
  const pack = writePack(plan.send);
  const acks: string[] = [];
  for (const have of haves) if (repo.objects.has(have)) acks.push(have);
  if (version2) {
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    if (acks.length) {
      for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
    if (plan.shallow.length || plan.unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (acks.length) for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, req: IncomingMessage, body: Buffer): Buffer {
  const header = req.headers['git-protocol'] ?? '';
  const version2 = typeof header === 'string' && header.includes('version=2');
  const stream = parsePktStream(body);
  if (stream.length === 0) throw new Error('empty upload-pack request');
  if (version2) {
    let command = '';
    const args: string[] = [];
    let afterDelim = false;
    for (const item of stream) {
      if (item === 'delim') {
        afterDelim = true;
        continue;
      }
      if (item === 'flush') break;
      const line = item.replace(/\n$/, '');
      if (!afterDelim) {
        if (line.startsWith('command=')) command = line.slice('command='.length);
      } else {
        args.push(line);
      }
    }
    if (command === 'ls-refs') return handleLsRefs(repo, args);
    if (command === 'fetch') return handleFetch(repo, args, true);
    throw new Error(`unknown v2 command ${command}`);
  }
  // v0: want section, flush, have section, flush.
  const args: string[] = [];
  for (const item of stream) {
    if (item === 'flush' || item === 'delim') continue;
    args.push(item.replace(/\n$/, ''));
  }
  return handleFetch(repo, args, false);
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const end = pktListEnd(body);
  const stream = parsePktStream(body.subarray(0, end));
  const lines = stream.filter((item): item is string => item !== 'flush' && item !== 'delim');
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let capabilities = '';
  lines.forEach((rawLine, index) => {
    let line = rawLine.replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  });
  const pack = body.subarray(end);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
      readPackInto(repo, pack);
    } catch {
      unpackOk = false;
      unpackDetail = 'error';
    }
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      fail('missing object');
      continue;
    }
    if (current !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
      const currentCommit = peelToCommit(repo, current);
      const newCommit = peelToCommit(repo, command.newOid);
      if (!currentCommit || !newCommit || !isAncestor(repo, currentCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');
  if (wantsSideband) {
    const parts = reportLines.map((line) => pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
  if (!match) return errJson(res, 404, 'Not Found');
  const owner = match[1] as string;
  const repoName = match[2] as string;
  const sub = match[3] ?? '';
  const repo = findRepo(owner, repoName);
  if (!repo) {
    requestSeq += 1;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': `req-${requestSeq}` });
    res.end('not found\n');
    return;
  }
  if (sub === '/info/refs' && method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return errJson(res, 400, 'unknown service');
    const header = req.headers['git-protocol'] ?? '';
    const wantV2 = typeof header === 'string' && header.includes('version=2');
    return sendRaw(res, 200, advertisement(repo, service, wantV2), `application/x-${service}-advertisement`);
  }
  if (sub === '/git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    try {
      const out = handleUploadPack(repo, req, body);
      return sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
    } catch {
      requestSeq += 1;
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': `req-${requestSeq}` });
      res.end('bad request\n');
      return;
    }
  }
  if (sub === '/git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    try {
      const out = handleReceivePack(repo, body);
      return sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
    } catch {
      requestSeq += 1;
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': `req-${requestSeq}` });
      res.end('bad request\n');
      return;
    }
  }
  return errJson(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- GraphQL v4
// A small executor for the documents gh and github-mcp-server send: operations with variables,
// aliases, inline fragments, input objects, enum lists and Relay connections, plus the __type
// introspection those clients feature-detect with. Unknown fields answer 200 with an errors array.
type GqlValue =
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };
interface GqlField {
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[];
}
type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; typeName: string; selections: GqlSelection[] }
  | { kind: 'spread'; name: string };
interface GqlOperation {
  opType: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

function gqlTokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          value += input[j + 1] === 'n' ? '\n' : (input[j + 1] as string);
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    tokens.push(ch);
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  readonly fragments = new Map<string, GqlSelection[]>();
  constructor(input: string) {
    this.tokens = gqlTokenize(input);
  }
  private peek(): string {
    return this.tokens[this.pos] ?? '';
  }
  private next(): string {
    return this.tokens[this.pos++] ?? '';
  }
  private expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token}`);
  }
  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === 'fragment') {
        this.next();
        const name = this.next();
        this.next(); // on
        this.next(); // type name
        if (this.peek() === '@') this.skipDirective();
        const selections = this.parseSelectionSet();
        this.fragments.set(name, selections);
        continue;
      }
      if (head === 'query' || head === 'mutation' || head === 'subscription') {
        const opType = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (/^[A-Za-z_]/.test(this.peek())) name = this.next();
        if (this.peek() === '(') this.skipBalanced();
        while (this.peek() === '@') this.skipDirective();
        const selections = this.parseSelectionSet();
        operations.push({ opType, name, selections });
        continue;
      }
      if (head === '{') {
        operations.push({ opType: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      this.next();
    }
    return operations;
  }
  private skipDirective(): void {
    this.next(); // @
    this.next(); // name
    if (this.peek() === '(') this.skipBalanced();
  }
  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      if (token === ')' || token === ']' || token === '}') depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }
  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          if (this.peek() === '@') this.skipDirective();
          selections.push({ kind: 'inline', typeName, selections: this.parseSelectionSet() });
        } else {
          const name = this.next();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }
  private parseField(): GqlField {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.pos < this.tokens.length) {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    while (this.peek() === '@') this.skipDirective();
    let selections: GqlSelection[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { name, alias, args, selections };
  }
  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token };
    if (token === 'null') return { kind: 'null' };
    if (/^-?[0-9]/.test(token)) return { kind: token.includes('.') || token.includes('e') ? 'float' : 'int', value: token };
    return { kind: 'enum', value: token };
  }
}

function gqlResolve(value: GqlValue, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
      return Number(value.value);
    case 'boolean':
      return value.value === 'true';
    case 'null':
      return null;
    case 'var':
      return vars[value.name] ?? null;
    case 'list':
      return value.items.map((item) => gqlResolve(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = gqlResolve(field.value, vars);
      return out;
    }
  }
}

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'meta', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl', 'isViewer', 'resourcePath', 'company', 'location'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
    'visibility', 'isFork', 'isArchived', 'isEmpty', 'pushedAt', 'stargazerCount', 'forkCount', 'primaryLanguage',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'labels', 'comments',
    'repository', 'url', 'closedAt', 'stateReason', 'assignees', 'milestone',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged',
    'files', 'author', 'createdAt', 'updatedAt', 'headRef', 'baseRef', 'mergeCommit', 'repository', 'url',
    'mergedAt', 'closedAt', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews',
  ],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'author', 'committedDate'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestFilesConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
};
const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  StateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
};

type GqlNode = Record<string, unknown>;
function userNode(login: string): GqlNode {
  return {
    __typename: 'User', id: globalId('User', 1000), databaseId: 1000, login, name: login,
    email: `${login}@example.invalid`, url: '', avatarUrl: '', isViewer: true, resourcePath: `/${login}`,
    company: null, location: null,
  };
}
function commentNode(comment: Comment): GqlNode {
  return {
    __typename: 'IssueComment', id: globalId('IssueComment', comment.id), databaseId: comment.id,
    body: comment.body, author: userNode(viewer()), createdAt: comment.createdAt, updatedAt: comment.createdAt, url: '',
  };
}
function issueNode(repo: Repo, issue: Issue): GqlNode {
  return {
    __typename: 'Issue', id: globalId('Issue', issue.globalIdNum), databaseId: issue.globalIdNum,
    number: issue.number, title: issue.title, state: issue.state === 'open' ? 'OPEN' : 'CLOSED', body: issue.body,
    author: userNode(viewer()), createdAt: issue.createdAt, updatedAt: issue.createdAt, closedAt: null, stateReason: null,
    url: '', milestone: null, assignees: { __typename: 'UserConnection', nodes: [] },
    labels: {
      __typename: 'LabelConnection',
      nodes: issue.labels.map((name) => ({ __typename: 'Label', id: globalId('Label', repo.labels.get(name)?.id ?? 0), name, color: repo.labels.get(name)?.color ?? 'ededed', description: null })),
    },
    comments: { __typename: 'IssueCommentConnection', nodes: issue.comments.map(commentNode), totalCount: issue.comments.length },
    repository: repoNode(repo),
  };
}
function pullNode(repo: Repo, pull: Pull): GqlNode {
  const files = pullFiles(repo, pull);
  return {
    __typename: 'PullRequest', id: globalId('PullRequest', pull.globalIdNum), databaseId: pull.globalIdNum,
    number: pull.number, title: pull.title, body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pull.merged ? 'MERGEABLE' : computeMergeable(repo, pull) === 'mergeable' ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pull.headRef, baseRefName: pull.baseRef,
    headRef: { __typename: 'Ref', name: pull.headRef, prefix: 'refs/heads/' },
    baseRef: { __typename: 'Ref', name: pull.baseRef, prefix: 'refs/heads/' },
    mergeCommit: pull.mergeCommitSha ? { __typename: 'Commit', oid: pull.mergeCommitSha } : null,
    mergedAt: pull.mergedAt, closedAt: pull.state === 'closed' ? pull.createdAt : null,
    author: userNode(viewer()), createdAt: pull.createdAt, updatedAt: pull.createdAt, url: '',
    additions: files.reduce((sum, file) => sum + (file.additions as number), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions as number), 0),
    changedFiles: files.length,
    files: {
      __typename: 'PullRequestFilesConnection',
      nodes: files.map((file) => ({
        __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions,
        deletions: file.deletions, changeType: String(file.status).toUpperCase(),
      })),
      totalCount: files.length,
    },
    repository: repoNode(repo),
  };
}
function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    const wanted = states.map((state) => String(state).toLowerCase());
    list = list.filter((issue) => wanted.includes(issue.state));
  }
  const orderBy = (args.orderBy ?? null) as Record<string, unknown> | null;
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  list.sort((a, b) => a.number - b.number);
  if (direction === 'DESC') list.reverse();
  return pagedConnection('IssueConnection', list.map((issue) => issueNode(repo, issue)), args);
}
function pagedConnection(typeName: string, nodes: GqlNode[], args: Record<string, unknown>): GqlNode {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) {
        const index = nodes.findIndex((node) => node.number === Number(match[1]));
        if (index >= 0) start = index + 1;
      }
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : nodes.length;
  const slice = nodes.slice(start, start + first);
  const hasNext = start + slice.length < nodes.length;
  const endCursor = slice.length ? Buffer.from(`cursor:${String(slice[slice.length - 1]?.number ?? '')}`, 'utf8').toString('base64') : null;
  const startCursor = slice.length ? Buffer.from(`cursor:${String(slice[0]?.number ?? '')}`, 'utf8').toString('base64') : null;
  return {
    __typename: typeName,
    nodes: slice,
    edges: slice.map((node) => ({ node, cursor: Buffer.from(`cursor:${String(node.number ?? '')}`, 'utf8').toString('base64') })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: start > 0, endCursor, startCursor },
    totalCount: nodes.length,
  };
}
function repoNode(repo: Repo): GqlNode {
  const headOid = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository', id: globalId('Repository', repo.id), databaseId: repo.id,
    name: repo.name, nameWithOwner: `${viewer()}/${repo.name}`, owner: userNode(viewer()),
    description: repo.description, isPrivate: repo.isPrivate, visibility: repo.isPrivate ? 'PRIVATE' : 'PUBLIC',
    viewerPermission: 'ADMIN', hasIssuesEnabled: true, createdAt: repo.createdAt, updatedAt: repo.createdAt,
    url: '', isFork: false, isArchived: false, isEmpty: repo.refs.size === 0, pushedAt: repo.createdAt,
    stargazerCount: 0, forkCount: 0, primaryLanguage: null,
    defaultBranchRef: {
      __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/',
      target: { __typename: 'Commit', oid: headOid ?? ZERO_OID },
    },
    issue: (args: Record<string, unknown>): GqlNode | null => {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueNode(repo, issue) : null;
    },
    issues: (args: Record<string, unknown>): GqlNode => issuesConnection(repo, args),
    pullRequest: (args: Record<string, unknown>): GqlNode | null => {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullNode(repo, pull) : null;
    },
    pullRequests: (args: Record<string, unknown>): GqlNode => {
      const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      return pagedConnection('PullRequestConnection', list.map((pull) => pullNode(repo, pull)), args);
    },
  };
}
function findRepoById(numeric: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === numeric) return repo;
  return null;
}
function findIssueByGlobal(numeric: number): { repo: Repo; issue: Issue } | null {
  for (const repo of repos.values()) for (const issue of repo.issues.values()) if (issue.globalIdNum === numeric) return { repo, issue };
  return null;
}
function findPullByGlobal(numeric: number): { repo: Repo; pull: Pull } | null {
  for (const repo of repos.values()) for (const pull of repo.pulls.values()) if (pull.globalIdNum === numeric) return { repo, pull };
  return null;
}
function typeNode(name: string): GqlNode | null {
  if (SCHEMA_ENUMS[name]) {
    return {
      __typename: '__Type', name, kind: 'ENUM', description: null,
      fields: null,
      enumValues: (SCHEMA_ENUMS[name] as string[]).map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null })),
    };
  }
  if (SCHEMA_FIELDS[name]) {
    return {
      __typename: '__Type', name, kind: 'OBJECT', description: null,
      fields: (SCHEMA_FIELDS[name] as string[]).map((field) => ({ __typename: '__Field', name: field, description: null, isDeprecated: false, deprecationReason: null })),
      enumValues: null,
    };
  }
  return null;
}

interface GqlCtx {
  vars: Record<string, unknown>;
  fragments: Map<string, GqlSelection[]>;
  errors: Array<{ message: string }>;
}
function gqlArgs(field: GqlField, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = gqlResolve(arg.value, ctx.vars);
  return out;
}
function execSelections(typeName: string, source: GqlNode | null, selections: GqlSelection[], ctx: GqlCtx): Record<string, unknown> | null {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeName === typeName || selection.typeName === 'Node') {
        Object.assign(out, execSelections(typeName, source, selection.selections, ctx) ?? {});
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, execSelections(typeName, source, fragment, ctx) ?? {});
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (field.name === '__type' && typeName === 'Query') {
      const args = gqlArgs(field, ctx);
      const node = typeNode(String(args.name ?? ''));
      out[key] = node ? execSelections('__Type', node, field.selections, ctx) : null;
      continue;
    }
    if (field.name === '__schema' && typeName === 'Query') {
      out[key] = null;
      continue;
    }
    const known = SCHEMA_FIELDS[typeName];
    if (known && !known.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    let value: unknown = source[field.name];
    if (typeof value === 'function') value = (value as (args: Record<string, unknown>) => unknown)(gqlArgs(field, ctx));
    out[key] = gqlComplete(value, field.selections, ctx);
  }
  return out;
}
function gqlComplete(value: unknown, selections: GqlSelection[], ctx: GqlCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => gqlComplete(item, selections, ctx));
  if (typeof value === 'object') {
    if (selections.length === 0) return value;
    const node = value as GqlNode;
    const typeName = typeof node.__typename === 'string' ? node.__typename : 'Repository';
    return execSelections(typeName, node, selections, ctx);
  }
  return value;
}
function gqlRoot(opType: 'query' | 'mutation'): GqlNode {
  if (opType === 'mutation') {
    return {
      __typename: 'Mutation',
      createIssue: (args: Record<string, unknown>): GqlNode | null => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? findRepoById(decoded.numeric) : null;
        if (!repo) return null;
        const labels = Array.isArray(input.labelIds) ? [] : [];
        void labels;
        const issue = createIssueRecord(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue), clientMutationId: null };
      },
      closeIssue: (args: Record<string, unknown>): GqlNode | null => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        const found = decoded ? findIssueByGlobal(decoded.numeric) : null;
        if (!found) return null;
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue), clientMutationId: null };
      },
      reopenIssue: (args: Record<string, unknown>): GqlNode | null => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        const found = decoded ? findIssueByGlobal(decoded.numeric) : null;
        if (!found) return null;
        found.issue.state = 'open';
        return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue), clientMutationId: null };
      },
      createPullRequest: (args: Record<string, unknown>): GqlNode | null => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? findRepoById(decoded.numeric) : null;
        if (!repo) return null;
        const head = bareRef(String(input.headRefName ?? ''));
        const base = bareRef(String(input.baseRefName ?? repo.defaultBranch));
        if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) return null;
        const pull = createPullRecord(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull), clientMutationId: null };
      },
      mergePullRequest: (args: Record<string, unknown>): GqlNode | null => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        const found = decoded ? findPullByGlobal(decoded.numeric) : null;
        if (!found) return null;
        if (!found.pull.merged && found.pull.state === 'open') mergePull(found.repo, found.pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull), clientMutationId: null };
      },
      addComment: (args: Record<string, unknown>): GqlNode | null => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        const found = decoded ? findIssueByGlobal(decoded.numeric) : null;
        if (!found) return null;
        const comment: Comment = { id: nextCommentGlobalId++, body: String(input.body ?? ''), createdAt: isoNow() };
        found.issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node: commentNode(comment), cursor: '' },
          subject: issueNode(found.repo, found.issue),
          clientMutationId: null,
        };
      },
    };
  }
  return {
    __typename: 'Query',
    viewer: userNode(viewer()),
    repository: (args: Record<string, unknown>): GqlNode | null => {
      const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoNode(repo) : null;
    },
    node: (args: Record<string, unknown>): GqlNode | null => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = findRepoById(decoded.numeric);
        return repo ? repoNode(repo) : null;
      }
      if (decoded.type === 'Issue') {
        const found = findIssueByGlobal(decoded.numeric);
        return found ? issueNode(found.repo, found.issue) : null;
      }
      if (decoded.type === 'PullRequest') {
        const found = findPullByGlobal(decoded.numeric);
        return found ? pullNode(found.repo, found.pull) : null;
      }
      if (decoded.type === 'User') return userNode(viewer());
      return null;
    },
    user: userNode(viewer()),
    search: { __typename: 'SearchType' },
  };
}
function runGraphQL(body: Record<string, unknown>): Record<string, unknown> {
  const query = String(body.query ?? '');
  const vars = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  const parser = new GqlParser(query);
  const operations = parser.parseDocument();
  if (operations.length === 0) return { data: {}, errors: [{ message: 'No operation found' }] };
  let operation = operations[0] as GqlOperation;
  const wanted = typeof body.operationName === 'string' ? body.operationName : null;
  if (wanted) {
    const match = operations.find((candidate) => candidate.name === wanted);
    if (match) operation = match;
  }
  const ctx: GqlCtx = { vars, fragments: parser.fragments, errors: [] };
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const data = execSelections(rootType, gqlRoot(operation.opType), operation.selections, ctx);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length) out.errors = ctx.errors;
  return out;
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return errJson(res, 400, 'Problems parsing JSON');
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runGraphQL((entry ?? {}) as Record<string, unknown>));
    return sendJson(res, 200, results as unknown as Record<string, unknown>);
  }
  const result = runGraphQL((parsed ?? {}) as Record<string, unknown>);
  return sendJson(res, 200, result);
}

// --------------------------------------------------------------------------- MCP
const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' },
        body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];
function mcpToolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError };
  if (!isError && typeof value === 'object' && value !== null) result.structuredContent = value;
  return result;
}
function mcpRepoArg(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = str(args.owner);
  let repo = str(args.repo) || str(args.repository) || str(args.name);
  const fullName = str(args.full_name) || str(args.repository_full_name);
  if (fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    if (owner === '') owner = o as string;
    if (repo === '') repo = r as string;
  }
  return { owner, repo };
}
function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> | 'unknown' {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name) || str(args.repo);
      if (repoName === '') return mcpToolResult('name is required', true);
      const existing = repos.get(repoName);
      if (existing) return mcpToolResult(repoJson(existing));
      const repo = createRepoRecord(repoName, str(args.description), boolOr(args.private, false));
      return mcpToolResult(repoJson(repo as Repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = mcpRepoArg(args);
      if (repoName === '') return mcpToolResult('repo is required', true);
      const repo = findRepo(owner === '' ? viewer() : owner, repoName);
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = mcpRepoArg(args);
      const title = str(args.title);
      if (repoName === '' || title === '') return mcpToolResult('owner, repo and title are required', true);
      const repo = findRepo(owner === '' ? viewer() : owner, repoName);
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      const labels = labelNamesOf(args);
      for (const label of labels) if (!repo.labels.has(label)) return mcpToolResult(`label '${label}' does not exist`, true);
      const issue = createIssueRecord(repo, title, str(args.body), labels);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const { owner, repo: repoName } = mcpRepoArg(args);
      if (repoName === '') return mcpToolResult('repo is required', true);
      const repo = findRepo(owner === '' ? viewer() : owner, repoName);
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      const state = strOr(args.state, 'open');
      let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      return mcpToolResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = mcpRepoArg(args);
      const head = bareRef(str(args.head));
      const base = bareRef(str(args.base));
      const title = str(args.title);
      if (repoName === '' || head === '' || base === '' || title === '') return mcpToolResult('owner, repo, title, head and base are required', true);
      const repo = findRepo(owner === '' ? viewer() : owner, repoName);
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      if (!repo.refs.has(`refs/heads/${head}`)) return mcpToolResult(`head branch '${head}' does not exist`, true);
      if (!repo.refs.has(`refs/heads/${base}`)) return mcpToolResult(`base branch '${base}' does not exist`, true);
      const pull = createPullRecord(repo, title, str(args.body), head, base);
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = mcpRepoArg(args);
      const number = Number(args.pull_number ?? args.number);
      if (repoName === '' || !Number.isSafeInteger(number)) return mcpToolResult('owner, repo and pull_number are required', true);
      const repo = findRepo(owner === '' ? viewer() : owner, repoName);
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      const pull = repo.pulls.get(number);
      if (!pull) return mcpToolResult(`pull request ${number} not found`, true);
      if (!pull.merged) {
        const result = mergePull(repo, pull);
        if (result === 'conflict') return mcpToolResult(`pull request ${number} is not mergeable`, true);
      }
      return mcpToolResult(pullJson(repo, pull));
    }
    default:
      return 'unknown';
  }
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    requestSeq += 1;
    res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': `req-${requestSeq}` });
    res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  const request = (parsed ?? {}) as Record<string, unknown>;
  const method = str(request.method);
  const id = request.id as string | number | null | undefined;
  if (id === undefined && method.startsWith('notifications/')) {
    requestSeq += 1;
    res.writeHead(202, { 'x-github-request-id': `req-${requestSeq}` });
    res.end();
    return;
  }
  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  };
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return reply({
        resultType: 'complete',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo: { name: 'github-forge', version: '1.0.0' },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-forge', version: '1.0.0' } },
      });
    case 'initialize':
      return reply({
        protocolVersion: strOr(params.protocolVersion, '2025-11-25'),
        capabilities: { tools: {} },
        serverInfo: { name: 'github-forge', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = str(params.name);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const result = runMcpTool(toolName, args);
      if (result === 'unknown') return replyError(-32602, `Unknown tool: ${toolName}`);
      return reply(result);
    }
    default:
      return replyError(-32601, `Method not found: ${method}`);
  }
}

// --------------------------------------------------------------------------- the server
/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const dispatch = async (): Promise<void> => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        return errJson(res, 404, 'Not Found');
      }
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/api/graphql') {
        if (!isAuthed(req)) return errJson(res, 401, 'Unauthorized');
        return handleGraphQL(req, res);
      }
      if (path === '/mcp') {
        if (!isAuthed(req)) return errJson(res, 401, 'Unauthorized');
        return handleMcp(req, res);
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!isAuthed(req)) return errJson(res, 401, 'Unauthorized');
        return handleRest(req, res, url);
      }
      if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
        if (!isAuthed(req)) return errJson(res, 401, 'Unauthorized');
        return handleGit(req, res, url);
      }
      return errJson(res, 404, 'Not Found');
    };
    dispatch().catch(() => {
      if (!res.headersSent) errJson(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
}
