// mend: one patch tool for every AI edit format.
//
// Reads a patch (unified diff, SEARCH/REPLACE blocks, V4A, or JSON tool-call
// edits), finds the lines each edit names at the first of three matching
// tiers, and writes every change or none at all. SPEC.md is the contract:
// this file implements it section by section, in its order.
//
// Run as `node main.ts [options] [PATCH]` with the working directory as the
// root of the tree. Node 22, standard library only. When MAKEFUN_ENV_URL is
// set, the file hands over to runner.ts, which runs the trial's checks.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A parse failure: the whole run ends with exit 2 and this one line. */
class ParseFailure extends Error {
  line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit that failed: reported as `error: <code> <path>`, exit 1. */
class EditFailure extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and
 * the empty piece after a final `\n` dropped. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A file as lines plus its own line break and whether it ends with one. */
interface Doc {
  lines: string[];
  brk: string;
  eol: boolean;
}

/** Split a file's text at its own line break: CRLF when its first line feed
 * follows a carriage return, LF otherwise. */
function readDoc(text: string): Doc {
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], brk, eol: false };
  const parts = text.split(brk);
  const eol = text.endsWith(brk);
  if (eol) parts.pop();
  return { lines: parts, brk, eol };
}

/** Render a doc back: its break between lines, a final one exactly when it
 * ended with one. A doc of no lines renders empty. */
function writeDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.brk) + (doc.eol ? doc.brk : '');
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 * `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line compared at a matching tier: 0 exact, 1 trailing spaces/tabs
 * removed, 2 leading and trailing spaces/tabs removed. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where `needle` occurs in `hay` at one tier. */
function spotsAtTier(hay: string[], needle: string[], tier: number, from: number, endAtLast: boolean): number[] {
  const spots: number[] = [];
  const want = needle.map((l) => tierKey(l, tier));
  for (let i = from; i + needle.length <= hay.length; i += 1) {
    if (endAtLast && i + needle.length !== hay.length) continue;
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (tierKey(hay[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) spots.push(i);
  }
  return spots;
}

/** The first tier at which `needle` occurs in `hay` (from `from`, and only
 * ending at the last line when `endAtLast`), with its positions. */
function firstTier(
  hay: string[],
  needle: string[],
  strict: boolean,
  from: number,
  endAtLast: boolean,
): { tier: number; spots: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const spots = spotsAtTier(hay, needle, tier, from, endAtLast);
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier
 * where one is (both sides a single line), or -1. */
function anchorSpot(hay: string[], anchor: string, strict: boolean, from: number): number {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const want = tierKey(anchor, tier);
    for (let i = from; i < hay.length; i += 1) {
      if (tierKey(hay[i]!, tier) === want) return i;
    }
  }
  return -1;
}

/**
 * The new lines of a block, with context lines taken from the file's own
 * matched lines. `fresh` holds, per line, either a literal new line or the
 * index into `old` of the context line it copies. At tier 2 the literal
 * lines are re-indented from the old block's first line to the file's.
 */
function buildNew(
  old: string[],
  fresh: Array<string | number>,
  fileLines: string[],
  at: number,
  tier: number,
): string[] {
  const out: string[] = fresh.map((part) => (typeof part === 'number' ? fileLines[at + part]! : part));
  if (tier !== 2 || old.length === 0) return out;
  const p = leadingWs(old[0]!);
  const f = leadingWs(fileLines[at]!);
  return out.map((line, i) => {
    if (typeof fresh[i] === 'number') return line;
    if (line === '' || /^[ \t]+$/.test(line)) return line;
    if (line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

/** A move that succeeded, for the `R <old> -> <new>` output line. */
interface Move {
  old: string;
  nw: string;
}

/** The tree as the edits leave it: changed paths in `overlay` (null means
 * deleted), everything else read from disk and cached. */
class WorkTree {
  private origCache = new Map<string, string | null>();
  private overlay = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p)!;
  }

  get(p: string): string | null {
    return this.overlay.has(p) ? this.overlay.get(p)! : this.original(p);
  }

  set(p: string, text: string): void {
    this.overlay.set(p, text);
  }

  del(p: string): void {
    this.overlay.set(p, null);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.overlay);
  }

  restore(snap: Map<string, string | null>): void {
    this.overlay = new Map(snap);
  }

  overlayKeys(): string[] {
    return [...this.overlay.keys()];
  }
}

type Edit = (tree: WorkTree) => void;

/** Byte order of paths, for the output lines. */
function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Detect the patch format (SPEC section 4), or null when none holds. */
function detectKind(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

type BodyRow = { t: 'ctx' | 'old' | 'new' | 'bs' | 'empty'; text: string };

interface UniHunk {
  a: number;
  body: BodyRow[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  oldShown: string;
  newShown: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` line names: after the four characters, up to
 * the first tab, surrounding spaces removed, one leading `a/` or `b/` off. */
function dashPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function classifyBodyRow(line: string): BodyRow {
  if (line === '') return { t: 'empty', text: '' };
  if (line[0] === ' ') return { t: 'ctx', text: line.slice(1) };
  if (line[0] === '-') return { t: 'old', text: line.slice(1) };
  if (line[0] === '+') return { t: 'new', text: line.slice(1) };
  return { t: 'bs', text: line };
}

function isBodyRow(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
}

/** A hunk's old lines O and its new lines N (a number is the index into O
 * of a context line, taken from the file). */
function hunkParts(body: BodyRow[]): { o: string[]; n: Array<string | number> } {
  const o: string[] = [];
  const n: Array<string | number> = [];
  for (const row of body) {
    if (row.t === 'ctx' || row.t === 'empty') {
      o.push(row.text);
      n.push(o.length - 1);
    } else if (row.t === 'old') {
      o.push(row.text);
    } else if (row.t === 'new') {
      n.push(row.text);
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: BodyRow[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.t === 'ctx' || body[i]!.t === 'empty' || body[i]!.t === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.t === 'bs';
}

/** Apply one hunk to a doc. Returns the new doc and the hunk's length delta
 * (N's length minus O's length) for the next hunk's target. */
function applyUniHunk(doc: Doc, hunk: UniHunk, d: number, strict: boolean, path: string): { doc: Doc; delta: number } {
  const { o, n } = hunkParts(hunk.body);
  const cur = doc.lines;
  if (o.length === 0) {
    const at = Math.min(Math.max(hunk.a + d, 0), cur.length);
    const inserted = n as string[];
    const lines = [...cur.slice(0, at), ...inserted, ...cur.slice(at)];
    const eol = at === cur.length ? !hunkNoEol(hunk.body) : doc.eol;
    return { doc: { lines, brk: doc.brk, eol }, delta: inserted.length };
  }
  const found = firstTier(cur, o, strict, 0, false);
  if (found === null) throw new EditFailure('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.spots[0]!;
  for (const spot of found.spots) {
    if (Math.abs(spot - target) < Math.abs(best - target)) best = spot;
  }
  const repl = buildNew(o, n, cur, best, found.tier);
  const lines = [...cur.slice(0, best), ...repl, ...cur.slice(best + o.length)];
  const eol = best + o.length === cur.length ? !hunkNoEol(hunk.body) : doc.eol;
  return { doc: { lines, brk: doc.brk, eol }, delta: repl.length - o.length };
}

/** Parse a unified patch into edits. */
function parseUnified(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  interface Draft {
    pairOld: string | null;
    pairNew: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    diffOld: string | null;
    diffNew: string | null;
    pairSeen: boolean;
    newFile: boolean;
    deletedFile: boolean;
    hunks: UniHunk[];
  }
  const blankDraft = (): Draft => ({
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    pairSeen: false,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const sections: UniSection[] = [];
  const closeSection = (draft: Draft | null): void => {
    if (draft === null) return;
    const oldPath = draft.pairOld === '/dev/null' ? null : (draft.pairOld ?? draft.renameFrom ?? draft.diffOld);
    const newPath = draft.pairNew === '/dev/null' ? null : (draft.pairNew ?? draft.renameTo ?? draft.diffNew);
    sections.push({
      oldPath: oldPath ?? null,
      newPath: newPath ?? null,
      oldShown: draft.pairOld ?? draft.renameFrom ?? draft.diffOld ?? '',
      newShown: draft.pairNew ?? draft.renameTo ?? draft.diffNew ?? '',
      newFile: draft.newFile,
      deletedFile: draft.deletedFile,
      hunks: draft.hunks,
    });
  };

  let draft: Draft | null = null;
  let state: 'out' | 'head' | 'body' | 'after' = 'out';
  let hunk: UniHunk | null = null;
  const endBody = (): void => {
    if (hunk === null || draft === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.t === 'empty') hunk.body.pop();
    draft.hunks.push(hunk);
    hunk = null;
  };
  const openFromDiff = (line: string, i: number): Draft => {
    const m = DIFF_GIT_RE.exec(line);
    if (m === null) throw new ParseFailure(`error: parse ${i + 1}`);
    const d = blankDraft();
    d.diffOld = m[1]!;
    d.diffNew = m[2]!;
    return d;
  };
  const openFromPair = (minus: string, plus: string): Draft => {
    const d = blankDraft();
    d.pairOld = dashPath(minus);
    d.pairNew = dashPath(plus);
    d.pairSeen = true;
    return d;
  };
  const openHunk = (line: string, i: number): void => {
    const m = HUNK_RE.exec(line);
    if (m === null) throw new ParseFailure(`error: parse ${i + 1}`);
    hunk = { a: Number.parseInt(m[1]!, 10), body: [] };
    state = 'body';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        endBody();
        closeSection(draft);
        draft = openFromDiff(line, i);
        state = 'head';
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        closeSection(draft);
        draft = openFromPair(line, lines[i + 1]!);
        state = 'head';
        i += 2;
        continue;
      }
      if (isBodyRow(line)) {
        hunk!.body.push(classifyBodyRow(line));
        i += 1;
        continue;
      }
      endBody();
      state = 'after';
      continue;
    }
    if (state === 'out') {
      if (line.startsWith('diff --git ')) {
        draft = openFromDiff(line, i);
        state = 'head';
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        draft = openFromPair(line, lines[i + 1]!);
        state = 'head';
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new ParseFailure(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (state === 'head') {
      if (line.startsWith('@@')) {
        openHunk(line, i);
        i += 1;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        closeSection(draft);
        draft = openFromDiff(line, i);
        state = 'head';
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!draft!.pairSeen) {
            draft!.pairOld = dashPath(line);
            draft!.pairNew = dashPath(lines[i + 1]!);
            draft!.pairSeen = true;
            i += 2;
            continue;
          }
          closeSection(draft);
          draft = openFromPair(line, lines[i + 1]!);
          state = 'head';
          i += 2;
          continue;
        }
        throw new ParseFailure(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        draft!.pairNew = dashPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        draft!.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        draft!.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        draft!.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        draft!.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    // state === 'after'
    if (line.startsWith('@@')) {
      openHunk(line, i);
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      closeSection(draft);
      draft = openFromDiff(line, i);
      state = 'head';
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      closeSection(draft);
      draft = openFromPair(line, lines[i + 1]!);
      state = 'head';
      i += 2;
      continue;
    }
    i += 1;
  }
  if (state === 'body') endBody();
  closeSection(draft);

  return sections.map((sec) => unifiedEdit(sec, strict, moves));
}

/** One unified section as an edit. */
function unifiedEdit(sec: UniSection, strict: boolean, moves: Move[]): Edit {
  return (tree: WorkTree): void => {
    if (sec.oldPath !== null && !isSafePath(sec.oldPath)) throw new EditFailure('unsafe', sec.oldShown);
    if (sec.newPath !== null && !isSafePath(sec.newPath)) throw new EditFailure('unsafe', sec.newShown);
    if (sec.oldPath === null || sec.newFile) {
      const np = sec.newPath;
      if (np === null) return;
      if (tree.get(np) !== null) throw new EditFailure('exists', np);
      const plus: string[] = [];
      let lastPlus: { hunk: UniHunk; at: number } | null = null;
      for (const h of sec.hunks) {
        h.body.forEach((row, at) => {
          if (row.t === 'new') {
            plus.push(row.text);
            lastPlus = { hunk: h, at };
          }
        });
      }
      let noEol = false;
      if (lastPlus !== null) {
        const row = lastPlus.hunk.body[lastPlus.at + 1];
        noEol = row !== undefined && row.t === 'bs';
      }
      tree.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (sec.newPath === null || sec.deletedFile) {
      const op = sec.oldPath!;
      if (tree.get(op) === null) throw new EditFailure('missing', op);
      tree.del(op);
      return;
    }
    if (sec.oldPath !== sec.newPath) {
      const op = sec.oldPath;
      const np = sec.newPath;
      const cur = tree.get(op);
      if (cur === null) throw new EditFailure('missing', op);
      if (tree.get(np) !== null) throw new EditFailure('exists', np);
      let doc = readDoc(cur);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyUniHunk(doc, h, d, strict, op);
        doc = r.doc;
        d += r.delta;
      }
      tree.del(op);
      tree.set(np, writeDoc(doc));
      moves.push({ old: op, nw: np });
      return;
    }
    const p = sec.oldPath;
    const cur = tree.get(p);
    if (cur === null) throw new EditFailure('missing', p);
    let doc = readDoc(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyUniHunk(doc, h, d, strict, p);
      doc = r.doc;
      d += r.delta;
    }
    tree.set(p, writeDoc(doc));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Parse SEARCH/REPLACE blocks into edits. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFailure(`error: parse ${searchAt + 1}`);
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseFailure(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseFailure(`error: parse ${searchAt + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchAt + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((block) => searchReplaceEdit(block, strict));
}

function searchReplaceEdit(block: SrBlock, strict: boolean): Edit {
  return (tree: WorkTree): void => {
    const p = block.path;
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    if (block.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.set(p, block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new EditFailure('missing', p);
    const doc = readDoc(cur);
    const found = firstTier(doc.lines, block.oldLines, strict, 0, false);
    if (found === null) throw new EditFailure('no-match', p);
    if (found.spots.length > 1) throw new EditFailure('ambiguous', p);
    const at = found.spots[0]!;
    const repl = buildNew(block.oldLines, block.newLines, doc.lines, at, found.tier);
    const lines = [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at + block.oldLines.length)];
    tree.set(p, writeDoc({ lines, brk: doc.brk, eol: doc.eol }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: BodyRow[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: V4aChunk[];
  addLines: string[];
  lineNo: number;
}

const ADD_PREFIX = '*** Add File: ';
const DELETE_PREFIX = '*** Delete File: ';
const UPDATE_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';
const END_OF_FILE = '*** End of File';

/** Parse a V4A patch into edits. */
function parseV4a(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFailure('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFailure(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseFailure(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && isBlank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith(ADD_PREFIX)) {
      kind = 'add';
      path = line.slice(ADD_PREFIX.length).trim();
    } else if (line.startsWith(DELETE_PREFIX)) {
      kind = 'delete';
      path = line.slice(DELETE_PREFIX.length).trim();
    } else if (line.startsWith(UPDATE_PREFIX)) {
      kind = 'update';
      path = line.slice(UPDATE_PREFIX.length).trim();
    } else {
      throw new ParseFailure(`error: parse ${i + 1}`);
    }
    const sectionAt = i;
    const start = i + 1;
    let j = start;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith(ADD_PREFIX) || l.startsWith(DELETE_PREFIX) || l.startsWith(UPDATE_PREFIX)) break;
      j += 1;
    }
    const raw = lines.slice(start, j);
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
    const base = start;
    if (kind === 'add') {
      const addLines: string[] = [];
      raw.forEach((l, k) => {
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new ParseFailure(`error: parse ${base + k + 1}`);
      });
      sections.push({ kind, path, moveTo: null, chunks: [], addLines, lineNo: sectionAt + 1 });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new ParseFailure(`error: parse ${base + 1}`);
      sections.push({ kind, path, moveTo: null, chunks: [], addLines: [], lineNo: sectionAt + 1 });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith(MOVE_PREFIX)) {
        moveTo = raw[0]!.slice(MOVE_PREFIX.length).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const pushChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k += 1) {
        const l = raw[k]!;
        const lineNo = base + k + 1;
        if (l.startsWith('@@')) {
          pushChunk();
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
        } else if (l === END_OF_FILE) {
          if (cur !== null) {
            cur.eof = true;
            pushChunk();
          }
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseFailure(`error: parse ${lineNo}`);
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push(classifyBodyRow(l));
        } else {
          throw new ParseFailure(`error: parse ${lineNo}`);
        }
      }
      pushChunk();
      if (chunks.length === 0 && moveTo === null) throw new ParseFailure(`error: parse ${sectionAt + 1}`);
      sections.push({ kind, path, moveTo, chunks, addLines: [], lineNo: sectionAt + 1 });
    }
    i = j;
  }
  return sections.map((sec) => v4aEdit(sec, strict, moves));
}

/** Apply one V4A chunk to a doc, moving the cursor past the lines written. */
function applyV4aChunk(doc: Doc, chunk: V4aChunk, cursor: number, strict: boolean, path: string): { doc: Doc; cursor: number } {
  let cur = doc.lines;
  let at = cursor;
  if (chunk.anchor !== null) {
    const spot = anchorSpot(cur, chunk.anchor, strict, at);
    if (spot < 0) throw new EditFailure('no-match', path);
    at = spot + 1;
  }
  const { o, n } = hunkParts(chunk.body);
  if (o.length === 0) {
    const atInsert = chunk.eof ? cur.length : at;
    const inserted = n as string[];
    const lines = [...cur.slice(0, atInsert), ...inserted, ...cur.slice(atInsert)];
    return { doc: { lines, brk: doc.brk, eol: doc.eol }, cursor: atInsert + inserted.length };
  }
  const found = firstTier(cur, o, strict, at, chunk.eof);
  if (found === null) throw new EditFailure('no-match', path);
  const spot = found.spots[0]!;
  const repl = buildNew(o, n, cur, spot, found.tier);
  const lines = [...cur.slice(0, spot), ...repl, ...cur.slice(spot + o.length)];
  return { doc: { lines, brk: doc.brk, eol: doc.eol }, cursor: spot + repl.length };
}

function v4aEdit(sec: V4aSection, strict: boolean, moves: Move[]): Edit {
  return (tree: WorkTree): void => {
    const p = sec.path;
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new EditFailure('missing', p);
      tree.del(p);
      return;
    }
    if (sec.moveTo !== null && !isSafePath(sec.moveTo)) throw new EditFailure('unsafe', sec.moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new EditFailure('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new EditFailure('exists', sec.moveTo);
    let doc = readDoc(cur);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      const r = applyV4aChunk(doc, chunk, cursor, strict, p);
      doc = r.doc;
      cursor = r.cursor;
    }
    const text = writeDoc(doc);
    if (sec.moveTo !== null) {
      tree.del(p);
      tree.set(sec.moveTo, text);
      moves.push({ old: p, nw: sec.moveTo });
    } else {
      tree.set(p, text);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree: WorkTree): void => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: WorkTree): void => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const crlf = isCrlfText(before);
      const plain = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = plain(before);
      const old = plain(oldStr);
      let count = 0;
      let at = -1;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) {
        count += 1;
        if (at < 0) at = k;
      }
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const out = text.slice(0, at) + plain(newStr) + text.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const atLine = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (tree: WorkTree): void => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const doc = readDoc(before);
      if (atLine < 0 || atLine > doc.lines.length) throw new EditFailure('no-match', p);
      const lines = [...doc.lines];
      lines.splice(atLine, 0, ...add);
      tree.set(p, writeDoc({ lines, brk: doc.brk, eol: doc.eol }));
    };
  }
  return null;
}

/** Whether a file's line break is CRLF (its first line feed follows a
 * carriage return). */
function isCrlfText(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

/** Parse a JSON patch (one array, or JSON Lines) into edits. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFailure('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFailure(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFailure(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new ParseFailure(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFailure(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC sections 1, 2 and 10)
// ---------------------------------------------------------------------------

interface Args {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

/** Parse the command line, or null on a usage error. */
function parseArgs(argv: string[]): Args | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return null;
        const v = a.slice(9);
        if (!FORMATS.includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (check) return null;
        check = true;
      } else if (a === '--strict') {
        if (strict) return null;
        strict = true;
      } else {
        return null;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return null;
  return { format: format ?? 'auto', check, strict, patch: pos.length === 0 ? null : pos[0]! };
}

/** The output lines for a successful run, from the tree before and after. */
function outputRows(tree: WorkTree, moves: Move[]): string[] {
  const claimedOld = new Set<string>();
  const claimedNew = new Set<string>();
  const moved: { key: string; text: string }[] = [];
  for (const m of moves) {
    if (claimedOld.has(m.old) || claimedNew.has(m.nw)) continue;
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      claimedOld.add(m.old);
      claimedNew.add(m.nw);
      moved.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
    }
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of tree.overlayKeys()) {
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    if (claimedOld.has(p) || claimedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.push(...moved);
  rows.sort((a, b) => byteLess(a.key, b.key));
  return rows.map((r) => r.text);
}

function runCli(argv: string[]): { code: number; out: string } {
  const args = parseArgs(argv);
  if (args === null) return { code: 2, out: 'error: usage\n' };
  let text = '';
  try {
    text = readFileSync(args.patch === null || args.patch === '-' ? 0 : args.patch, 'utf8');
  } catch {
    if (args.patch !== null && args.patch !== '-') return { code: 2, out: 'error: no-patch\n' };
    text = '';
  }
  const lines = splitPatchLines(text);
  const kind = args.format === 'auto' ? detectKind(lines) : args.format;
  if (kind === null) return { code: 2, out: 'error: format\n' };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, args.strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, args.strict);
    else if (kind === 'v4a') edits = parseV4a(lines, args.strict, moves);
    else edits = parseJson(text, lines);
  } catch (e) {
    if (e instanceof ParseFailure) return { code: 2, out: `${e.line}\n` };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: 'error: parse 1\n' };

  const tree = new WorkTree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    const out = [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`];
    return { code: 1, out: out.map((l) => `${l}\n`).join('') };
  }
  const rows = outputRows(tree, moves);
  if (!args.check) {
    for (const p of tree.overlayKeys()) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  return { code: 0, out: out.map((l) => `${l}\n`).join('') };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = runCli(process.argv.slice(2));
  writeSync(1, result.out);
  process.exitCode = result.code;
}
