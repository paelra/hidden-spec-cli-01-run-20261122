// mend-formats.ts — readers for the four patch formats (SPEC.md sections
// 6-9). Each reader turns patch lines into edits, or throws Exit2 with the
// parse line the format's section names. Edits throw Fail with the code and
// path section 2 names; every path is checked for safety first (section 10).

import {
  Exit2, Fail, blank, buildN, findTier, isSafe,
  occurrences, parseFile, patchLines, rawN, writeFile,
} from './mend-core.ts';
import type { Edit, FileModel, Tree } from './mend-core.ts';

function needSafe(p: string): void {
  if (!isSafe(p)) throw new Fail('unsafe', p);
}
function mustExist(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}
function mustNotExist(tree: Tree, p: string): void {
  if (tree.get(p) !== null) throw new Fail('exists', p);
}

// ---------------- section 6: unified diffs ----------------

interface BodyLine { kind: ' ' | '-' | '+' | '\\'; text: string; }
interface Hunk { a: number; body: BodyLine[]; }
interface Section {
  gitOld: string | null; gitNew: string | null;
  pair: { old: string | null; new: string | null } | null;
  renOld: string | null; renNew: string | null;
  create: boolean; del: boolean; hunks: Hunk[];
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  return t === '/dev/null' ? null : stripPrefix(t);
}
function newSection(): Section {
  return { gitOld: null, gitNew: null, pair: null, renOld: null, renNew: null, create: false, del: false, hunks: [] };
}

export function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const pair = { old: headerPath(line.slice(4)), new: headerPath(lines[i + 1]!.slice(4)) };
      if (sec !== null && sec.hunks.length === 0 && sec.pair === null) {
        sec.pair = pair; // the open section's own header pair
      } else {
        sec = newSection();
        sec.pair = pair;
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s.*)?$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') { hunk.body.push({ kind: ' ', text: '' }); i++; continue; }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          hunk.body.push({ kind: c as BodyLine['kind'], text: b.slice(1) });
          i++;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop(); else break;
      }
      sec.hunks.push(hunk);
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // section header lines, before the first hunk
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) { sec.renOld = stripPrefix(line.slice(12).trim()); i++; continue; }
      if (line.startsWith('rename to ')) { sec.renNew = stripPrefix(line.slice(10).trim()); i++; continue; }
      if (line.startsWith('new file mode')) { sec.create = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { sec.del = true; i++; continue; }
      i++;
      continue;
    }
    i++; // prose outside sections is ignored
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const resolved: ResolvedSection = {
      oldPath: s.pair !== null ? s.pair.old : (s.renOld ?? s.gitOld),
      newPath: s.pair !== null ? s.pair.new : (s.renNew ?? s.gitNew),
      create: s.create, del: s.del, hunks: s.hunks,
    };
    return unifiedEdit(resolved);
  });
}

interface ResolvedSection {
  oldPath: string | null; newPath: string | null;
  create: boolean; del: boolean; hunks: Hunk[];
}

function hunkON(hunk: Hunk): { O: string[]; N: ReturnType<typeof rawN> } {
  const O: string[] = [];
  const N: ReturnType<typeof rawN> = [];
  for (const b of hunk.body) {
    if (b.kind === ' ') { const idx = O.length; O.push(b.text); N.push({ text: b.text, context: true, oIndex: idx }); }
    else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, context: false, oIndex: -1 });
  }
  return { O, N };
}
// Does a '\' line follow the hunk's last context or '+' line?
function backslashAfterLastNew(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k--) {
    const b = hunk.body[k]!;
    if (b.kind === ' ' || b.kind === '+') {
      const next = hunk.body[k + 1];
      return next !== undefined && next.kind === '\\';
    }
  }
  return false;
}

function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, failPath: string): FileModel {
  const lines = [...model.lines];
  let finalBreak = model.finalBreak;
  let d = 0;
  for (const hunk of hunks) {
    const { O, N } = hunkON(hunk);
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(hunk.a + d, lines.length));
      const atEnd = pos === lines.length;
      const built = buildN(lines, pos, O, N, 0);
      lines.splice(pos, 0, ...built);
      if (atEnd) finalBreak = !backslashAfterLastNew(hunk);
      d += built.length;
      continue;
    }
    const found = findTier(lines, O, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = hunk.a - 1 + d;
    let pos = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const built = buildN(lines, pos, O, N, found.tier);
    const runsToEnd = pos + O.length === lines.length;
    lines.splice(pos, O.length, ...built);
    if (runsToEnd) finalBreak = !backslashAfterLastNew(hunk);
    d += built.length - O.length;
  }
  return { lines, br: model.br, finalBreak };
}

function unifiedEdit(sec: ResolvedSection): Edit {
  return (tree) => {
    const isCreate = sec.create || sec.oldPath === null;
    const isDelete = !isCreate && (sec.del || sec.newPath === null);
    if (isCreate) {
      const p = sec.newPath;
      if (p === null) throw new Fail('missing', '');
      needSafe(p);
      mustNotExist(tree, p);
      const plus: string[] = [];
      let lastPlusHunk: Hunk | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === '+') { plus.push(b.text); lastPlusHunk = h; }
      }
      const noBreak = lastPlusHunk !== null && backslashAfterLastNew(lastPlusHunk);
      tree.set(p, writeFile({ lines: plus, br: '\n', finalBreak: plus.length > 0 && !noBreak }));
      return;
    }
    const oldP = sec.oldPath;
    if (oldP === null) throw new Fail('missing', '');
    needSafe(oldP);
    if (isDelete) {
      mustExist(tree, oldP);
      tree.set(oldP, null);
      return;
    }
    const newP = sec.newPath ?? oldP;
    needSafe(newP);
    const before = mustExist(tree, oldP);
    if (newP !== oldP) mustNotExist(tree, newP);
    const model = applyHunks(parseFile(before), sec.hunks, STRICT.flag, oldP);
    tree.set(newP, writeFile(model));
    if (newP !== oldP) { tree.set(oldP, null); tree.moves.push([oldP, newP]); }
  };
}
// --strict is a run-wide switch; main.ts sets it before edits run.
export const STRICT = { flag: false };

// ---------------- section 7: SEARCH/REPLACE blocks ----------------

export function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    // the block's path: nearest earlier non-blank, non-fence line
    let path = prevPath;
    for (let j = searchLine - 1; j >= searchFrom; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1, rep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
      else if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    needSafe(path);
    if (oldLines.length === 0) {
      mustNotExist(tree, path);
      tree.set(path, writeFile({ lines: newLines, br: '\n', finalBreak: newLines.length > 0 }));
      return;
    }
    const before = mustExist(tree, path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, STRICT.flag);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const built = buildN(model.lines, pos, oldLines, rawN(newLines), found.tier);
    model.lines.splice(pos, oldLines.length, ...built);
    tree.set(path, writeFile(model));
  };
}

// ---------------- section 8: V4A patches ----------------

interface Chunk { anchor: string | null; eof: boolean; body: BodyLine[]; }

export function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const sectionStart = (l: string): string | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const startLine = i;
    i++;
    const raw: Array<{ text: string; at: number }> = [];
    while (i < last && sectionStart(lines[i]!) === null) { raw.push({ text: lines[i]!, at: i }); i++; }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.at + 1}`);
      }
      edits.push((tree) => {
        needSafe(path);
        mustNotExist(tree, path);
        tree.set(path, writeFile({ lines: fileLines, br: '\n', finalBreak: fileLines.length > 0 }));
      });
    } else if (kind === 'del') {
      for (const r of raw) if (!blank(r.text)) throw new Exit2(`error: parse ${r.at + 1}`);
      edits.push((tree) => {
        needSafe(path);
        mustExist(tree, path);
        tree.set(path, null);
      });
    } else {
      edits.push(v4aUpdate(path, raw, startLine));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aUpdate(path: string, raw: Array<{ text: string; at: number }>, startLine: number): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (; idx < raw.length; idx++) {
    const { text, at } = raw[idx]!;
    if (text.startsWith('@@')) {
      cur = { anchor: text.slice(2).trim() === '' ? null : text.slice(2).trim(), eof: false, body: [] };
      chunks.push(cur);
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) { cur = { anchor: null, eof: true, body: [] }; chunks.push(cur); }
      cur.eof = true;
      continue;
    }
    const c = text[0] ?? '';
    if (text === '' || c === ' ' || c === '-' || c === '+') {
      if (cur === null) { cur = { anchor: null, eof: false, body: [] }; chunks.push(cur); }
      cur.body.push({ kind: text === '' ? ' ' : (c as BodyLine['kind']), text: text === '' ? '' : text.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${at + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
  return (tree) => {
    needSafe(path);
    if (moveTo !== null) needSafe(moveTo);
    const before = mustExist(tree, path);
    if (moveTo !== null) mustNotExist(tree, moveTo);
    const model = parseFile(before);
    const lines = model.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(lines, [chunk.anchor], STRICT.flag, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.at[0]! + 1;
      }
      const O: string[] = [];
      const N: ReturnType<typeof rawN> = [];
      for (const b of chunk.body) {
        if (b.kind === ' ') { const oi = O.length; O.push(b.text); N.push({ text: b.text, context: true, oIndex: oi }); }
        else if (b.kind === '-') O.push(b.text);
        else if (b.kind === '+') N.push({ text: b.text, context: false, oIndex: -1 });
      }
      if (O.length === 0) {
        const pos = chunk.eof ? lines.length : Math.min(cursor, lines.length);
        const built = buildN(lines, pos, O, N, 0);
        lines.splice(pos, 0, ...built);
        cursor = pos + built.length;
        continue;
      }
      const tiers = STRICT.flag ? [0] : [0, 1, 2];
      let placed: { pos: number; tier: number } | null = null;
      for (const tier of tiers) {
        const occ = occurrences(lines, O, tier, cursor)
          .filter((p) => !chunk.eof || p + O.length === lines.length);
        if (occ.length > 0) { placed = { pos: occ[0]!, tier }; break; }
      }
      if (placed === null) throw new Fail('no-match', path);
      const built = buildN(lines, placed.pos, O, N, placed.tier);
      lines.splice(placed.pos, O.length, ...built);
      cursor = placed.pos + built.length;
    }
    const dest = moveTo ?? path;
    tree.set(dest, writeFile({ lines, br: model.br, finalBreak: model.finalBreak }));
    if (moveTo !== null) { tree.set(path, null); tree.moves.push([path, moveTo]); }
  };
}

// ---------------- section 9: JSON edits ----------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      mustNotExist(tree, p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' &&
      (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      needSafe(p);
      const before = mustExist(tree, p);
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
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) &&
      typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      needSafe(p);
      const before = mustExist(tree, p);
      const model = parseFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.set(p, writeFile(model));
    };
  }
  return null;
}

export function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
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
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}
