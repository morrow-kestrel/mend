// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads an edit an AI model wrote, in one of four formats
// (a unified diff, SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON), and applies it to the
// tree of text files in the working directory: every file is changed or nothing is. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts stay as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}
/** A hunk or chunk failure inside one edit; the edit wrapper gives it the edit's path. */
class MatchFail {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3)

interface FileLines {
  lines: string[];
  br: '\n' | '\r\n';
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5)

const rstripWS = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWS(a) === rstripWS(b);
  return stripWS(a) === stripWS(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which o occurs at or after `from`, and its occurrences there. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

type Op = { t: 'ctx' | 'del' | 'add' | 'bs'; text: string };

/**
 * The lines written in place of o matched at `pos`: context lines are the file's own matched lines; at tier 2 the
 * other lines are re-indented from o's first line's indent to the file's first matched line's indent.
 */
function buildReplacement(lines: string[], pos: number, o: string[], ops: Op[], tier: number): string[] {
  const out: string[] = [];
  const f = leadWS(lines[pos] ?? '');
  const p = leadWS(o[0] ?? '');
  let oi = 0;
  for (const op of ops) {
    if (op.t === 'ctx') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (op.t === 'del') {
      oi += 1;
    } else if (op.t === 'add') {
      let s = op.text;
      if (tier === 2 && s !== '' && !/^[ \t]+$/.test(s) && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out;
}

/** True when a `\` line follows the ops' last context or `+` line. */
function bsAfterLastWrite(ops: Op[]): boolean {
  let idx = -1;
  ops.forEach((op, k) => {
    if (op.t === 'ctx' || op.t === 'add') idx = k;
  });
  return idx >= 0 && ops[idx + 1]?.t === 'bs';
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)

interface UHunk {
  a: number;
  ops: Op[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string;
  pairNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: UHunk[];
}

function pairPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Apply a section's hunks in order to a file's lines; throws MatchFail('no-match'). */
function applyHunks(fl: FileLines, hunks: UHunk[], strict: boolean): FileLines {
  let lines = [...fl.lines];
  let finalBreak = fl.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: string[] = [];
    for (const op of h.ops) {
      if (op.t === 'ctx' || op.t === 'del') o.push(op.text);
      if (op.t === 'ctx' || op.t === 'add') n.push(op.text);
    }
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...n);
      if (atEnd && h.ops.some((op) => op.t === 'ctx' || op.t === 'add')) finalBreak = !bsAfterLastWrite(h.ops);
      d += n.length;
    } else {
      const found = findTier(lines, o, strict, 0);
      if (found === null) throw new MatchFail('no-match');
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const written = buildReplacement(lines, best, o, h.ops, found.tier);
      const touchesEnd = best + o.length === lines.length;
      lines.splice(best, o.length, ...written);
      if (touchesEnd) {
        finalBreak = h.ops.some((op) => op.t === 'ctx' || op.t === 'add') ? !bsAfterLastWrite(h.ops) : lines.length > 0;
      }
      d += n.length - o.length;
    }
  }
  return { lines, br: fl.br, finalBreak };
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldRaw = sec.pairOld ?? sec.renameFrom ?? sec.gitOld;
    const newRaw = sec.pairNew ?? sec.renameTo ?? sec.gitNew;
    const isCreate = sec.newFile || oldRaw === '/dev/null';
    const isDelete = sec.delFile || newRaw === '/dev/null';
    if (isCreate) {
      const p = newRaw!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastHunk: UHunk | null = null;
      let lastIdx = -1;
      for (const h of sec.hunks) {
        h.ops.forEach((op, k) => {
          if (op.t === 'add') {
            plus.push(op.text);
            lastHunk = h;
            lastIdx = k;
          }
        });
      }
      const finalBreak = lastHunk === null ? true : (lastHunk as UHunk).ops[lastIdx + 1]?.t !== 'bs';
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldRaw!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = oldRaw!;
    const newP = newRaw!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let out = before;
    if (sec.hunks.length > 0) {
      try {
        out = joinFile(applyHunks(splitFile(before), sec.hunks, strict));
      } catch (e) {
        if (e instanceof MatchFail) throw new Fail(e.code, oldP);
        throw e;
      }
    }
    if (newP !== oldP) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = { newFile: false, delFile: false, hasPair: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hasPair || cur.hunks.length > 0) cur = newSection();
      cur.pairOld = pairPath(line);
      cur.pairNew = pairPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s.*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          raw.push(l);
          j += 1;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const ops: Op[] = raw.map((l) =>
        l === ''
          ? { t: 'ctx' as const, text: '' }
          : l[0] === ' '
            ? { t: 'ctx' as const, text: l.slice(1) }
            : l[0] === '-'
              ? { t: 'del' as const, text: l.slice(1) }
              : l[0] === '+'
                ? { t: 'add' as const, text: l.slice(1) }
                : { t: 'bs' as const, text: l },
      );
      cur.hunks.push({ a: parseInt(m[1]!, 10), ops });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1; // outside sections and bodies: prose, fences, anything else is ignored
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    prevPath = path;
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const fl = splitFile(before);
      const found = findTier(fl.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const ops: Op[] = [
        ...oldLines.map((text) => ({ t: 'del' as const, text })),
        ...newLines.map((text) => ({ t: 'add' as const, text })),
      ];
      const written = buildReplacement(fl.lines, pos, oldLines, ops, found.tier);
      const out = [...fl.lines];
      out.splice(pos, oldLines.length, ...written);
      tree.now.set(p, joinFile({ lines: out, br: fl.br, finalBreak: fl.finalBreak }));
    });
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)

interface VChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOV = '*** Move to: ';

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fl = splitFile(before);
    let lines = [...fl.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (tierEq(lines[k]!, ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const o: string[] = [];
      const n: string[] = [];
      for (const op of ch.ops) {
        if (op.t === 'ctx' || op.t === 'del') o.push(op.text);
        if (op.t === 'ctx' || op.t === 'add') n.push(op.text);
      }
      if (o.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        lines.splice(pos, 0, ...n);
        cursor = pos + n.length;
      } else {
        const found = findTier(lines, o, strict, cursor);
        let occ = found === null ? [] : found.occ;
        if (ch.eof) occ = occ.filter((p) => p + o.length === lines.length);
        if (found === null || occ.length === 0) throw new Fail('no-match', path);
        const pos = occ[0]!;
        const written = buildReplacement(lines, pos, o, ch.ops, found.tier);
        lines.splice(pos, o.length, ...written);
        cursor = pos + written.length;
      }
    }
    const out = joinFile({ lines, br: fl.br, finalBreak: fl.finalBreak });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const nonBlank: number[] = [];
  lines.forEach((l, idx) => {
    if (!blank(l)) nonBlank.push(idx);
  });
  if (nonBlank.length === 0) throw new Exit2('error: parse 1');
  const first = nonBlank[0]!;
  const last = nonBlank[nonBlank.length - 1]!;
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = l.startsWith(V_ADD) ? 'add' : l.startsWith(V_DEL) ? 'del' : 'upd';
    const prefix = kind === 'add' ? V_ADD : kind === 'del' ? V_DEL : V_UPD;
    const path = l.slice(prefix.length).trim();
    const secLine = i + 1;
    const sec: Array<{ text: string; no: number }> = [];
    let j = i + 1;
    while (j < last && !isStart(lines[j]!)) {
      sec.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const s of sec) {
        if (s.text.startsWith('+')) fileLines.push(s.text.slice(1));
        else if (s.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${s.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
    } else if (kind === 'del') {
      for (const s of sec) {
        if (!blank(s.text)) throw new Exit2(`error: parse ${s.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (sec.length > 0 && sec[0]!.text.startsWith(V_MOV)) {
        moveTo = sec[0]!.text.slice(V_MOV.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; idx < sec.length; idx += 1) {
        const s = sec[idx]!;
        if (s.text.startsWith('@@')) {
          const anchor = s.text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (s.text.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${s.no}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (s.text === '' || s.text[0] === ' ' || s.text[0] === '-' || s.text[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${s.no}`);
            cur = { anchor: null, ops: [], eof: false };
            chunks.push(cur);
          }
          cur.ops.push(
            s.text === ''
              ? { t: 'ctx', text: '' }
              : s.text[0] === ' '
                ? { t: 'ctx', text: s.text.slice(1) }
                : s.text[0] === '-'
                  ? { t: 'del', text: s.text.slice(1) }
                  : { t: 'add', text: s.text.slice(1) },
          );
          continue;
        }
        throw new Exit2(`error: parse ${s.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// The run (SPEC.md sections 1, 2 and 10)

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move pair (old, new) is reported as one R line when the old path existed before the patch and does not
  // after it, and the new path did not exist before it and does after it.
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rByNew = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) rByNew.set(n, o);
  }
  const rOlds = new Set(rByNew.values());
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rByNew.has(p)) rows.push({ key: p, text: `R ${rByNew.get(p)} -> ${p}` });
    else if (rOlds.has(p) && now === null) continue;
    else rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
