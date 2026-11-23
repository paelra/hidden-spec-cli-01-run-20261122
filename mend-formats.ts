// mend-formats.ts — the four patch readers of SPEC.md: unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8)
// and JSON edits (section 9). Each reader parses the whole patch first —
// a parse fault throws Exit2 before any file is looked at — and returns
// one closure per edit, in the patch's order. A closure checks the safety
// of the paths it names before anything else about it (section 10), then
// the file state, then applies to the tree or throws Fail; main.ts rolls
// a failed edit back, so a closure may mutate freely before throwing.

import {
  Exit2,
  Fail,
  Tree,
  applyOps,
  findAnchor,
  findOccurrences,
  isSafePath,
  joinFile,
  splitFile,
  type FileText,
  type Op,
} from './mend-core.ts';

/** Set by main.ts from --strict: matching is tier 0 only (section 5). */
export const STRICT = { flag: false };

type Edit = (tree: Tree) => void;

const rtrim = (s: string) => s.replace(/\s+$/, '');

// ---------------------------------------------------------------- unified

interface UHunk {
  a: number;
  ops: Op[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined; // undefined: no --- / +++ pair yet
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** A --- or +++ path: up to the first tab, spaces removed, a/ b/ off. */
function headerPath(raw: string): string | null {
  const cut = raw.split('\t')[0].trim();
  if (cut === '/dev/null') return null;
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}

export function unifiedEdits(lines: string[]): Edit[] {
  const sections: USection[] = [];
  const fresh = (): USection => ({
    gitOld: null,
    gitNew: null,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.pairOld !== undefined) {
        cur = fresh();
        sections.push(cur);
      }
      cur.pairOld = headerPath(line.slice(4));
      cur.pairNew = headerPath(lines[i + 1].slice(4));
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0 && line.startsWith('--- ')) {
      // A --- line inside a section's header, not followed by a +++ line.
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const ops: Op[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j];
        if (b.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        const c = b.charAt(0);
        if (c === ' ' || c === '-' || c === '+') {
          ops.push({ t: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: b.slice(1), bs: false });
          j += 1;
        } else if (c === '\\') {
          if (ops.length > 0) ops[ops.length - 1].bs = true;
          j += 1;
        } else if (b === '') {
          ops.push({ t: 'ctx', text: '', bs: false, blank: true });
          j += 1;
        } else break;
      }
      while (ops.length > 0 && ops[ops.length - 1].blank) ops.pop();
      cur.hunks.push({ a: Number(m[1]), ops });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map(sectionEdit);
}

/** Apply one hunk; returns the change in line count it makes. */
function applyUHunk(ft: FileText, h: UHunk, d: number, path: string): number {
  const oldOps = h.ops.filter((o) => o.t !== 'add');
  const newCount = h.ops.filter((o) => o.t !== 'del').length;
  if (oldOps.length === 0) {
    const adds = h.ops.filter((o) => o.t === 'add');
    const lenBefore = ft.lines.length;
    const at = Math.max(0, Math.min(h.a + d, lenBefore));
    ft.lines = [...ft.lines.slice(0, at), ...adds.map((o) => o.text), ...ft.lines.slice(at)];
    if (at === lenBefore && adds.length > 0) ft.finalBreak = !adds[adds.length - 1].bs;
    return adds.length;
  }
  const found = findOccurrences(ft.lines, oldOps.map((o) => o.text), STRICT.flag);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.positions[0];
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const runsToEnd = pos + oldOps.length === ft.lines.length;
  ft.lines = applyOps(ft.lines, pos, h.ops, found.tier);
  if (runsToEnd) {
    const lastWrite = [...h.ops].reverse().find((o) => o.t !== 'del');
    ft.finalBreak = lastWrite ? !lastWrite.bs : true;
  }
  return newCount - oldOps.length;
}

function sectionEdit(sec: USection): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom ?? sec.gitOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo ?? sec.gitNew;
  const creation = oldP === null || sec.newFile;
  const deletion = !creation && (newP === null || sec.deletedFile);
  return (tree) => {
    if (creation) {
      const target = newP ?? '';
      if (!isSafePath(target)) throw new Fail('unsafe', target);
      if (tree.has(target)) throw new Fail('exists', target);
      const outLines: string[] = [];
      let lastAddBs = false;
      let seenAdd = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) {
          if (op.t === 'add') {
            outLines.push(op.text);
            lastAddBs = op.bs;
            seenAdd = true;
          }
        }
      }
      const ft: FileText = { brk: '\n', lines: outLines, finalBreak: seenAdd ? !lastAddBs : false };
      tree.put(target, joinFile(ft));
      return;
    }
    if (deletion) {
      const target = oldP!;
      if (!isSafePath(target)) throw new Fail('unsafe', target);
      if (!tree.has(target)) throw new Fail('missing', target);
      tree.remove(target);
      return;
    }
    const from = oldP!;
    const to = newP!;
    if (!isSafePath(from)) throw new Fail('unsafe', from);
    if (!isSafePath(to)) throw new Fail('unsafe', to);
    if (!tree.has(from)) throw new Fail('missing', from);
    const move = from !== to;
    if (move && tree.has(to)) throw new Fail('exists', to);
    const ft = splitFile(tree.get(from)!);
    let d = 0;
    for (const h of sec.hunks) d += applyUHunk(ft, h, d, from);
    if (move) {
      tree.put(to, joinFile(ft));
      tree.remove(from);
      tree.moves.push([from, to]);
    } else {
      tree.put(from, joinFile(ft));
    }
  };
}

// ---------------------------------------------------------- search/replace

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

export function searchReplaceEdits(lines: string[]): Edit[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let from = 0; // a block's path is searched after the previous block's end
  let i = 0;
  while (i < lines.length) {
    if (rtrim(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= from; j--) {
      const t = lines[j].trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (rtrim(lines[k]) === '=======') {
        eq = k;
        break;
      }
      if (rtrim(lines[k]) === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (rtrim(lines[k]) === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    from = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => (tree) => {
    if (!isSafePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.has(b.path)) throw new Fail('exists', b.path);
      tree.put(b.path, joinFile({ brk: '\n', lines: b.newLines, finalBreak: true }));
      return;
    }
    if (!tree.has(b.path)) throw new Fail('missing', b.path);
    const ft = splitFile(tree.get(b.path)!);
    const found = findOccurrences(ft.lines, b.oldLines, STRICT.flag);
    if (!found) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const ops: Op[] = [
      ...b.oldLines.map((t) => ({ t: 'del' as const, text: t, bs: false })),
      ...b.newLines.map((t) => ({ t: 'add' as const, text: t, bs: false })),
    ];
    ft.lines = applyOps(ft.lines, found.positions[0], ops, found.tier);
    tree.put(b.path, joinFile(ft));
  });
}

// --------------------------------------------------------------------- v4a

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const vStart = (l: string) =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

export function v4aEdits(lines: string[]): Edit[] {
  const isBlank = (l: string) => l.trim() === '';
  const fb = lines.findIndex((l) => !isBlank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k])) {
      lb = k;
      break;
    }
  }
  if (lines[lb].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = fb + 1;
  while (i < lb) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: VSection['kind'] | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    }
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    const body: { text: string; n: number }[] = [];
    let j = i + 1;
    while (j < lb && !vStart(lines[j])) {
      body.push({ text: lines[j], n: j + 1 });
      j += 1;
    }
    // Blank lines at the end of a section are not part of it; a blank
    // line is one that is empty or only whitespace (section 4).
    while (body.length > 0 && body[body.length - 1].text.trim() === '') body.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const e of body) {
        if (e.text.startsWith('+')) content.push(e.text.slice(1));
        else if (e.text === '') content.push('');
        else throw new Exit2(`error: parse ${e.n}`);
      }
      sections.push({ kind, path, addLines: content, moveTo: null, chunks: [] });
    } else if (kind === 'del') {
      const nonBlank = body.filter((e) => e.text.trim() !== '');
      if (nonBlank.length > 0) throw new Exit2(`error: parse ${nonBlank[0].n}`);
      sections.push({ kind, path, addLines: [], moveTo: null, chunks: [] });
    } else {
      let moveTo: string | null = null;
      let rest = body;
      if (rest.length > 0 && rest[0].text.startsWith('*** Move to: ')) {
        moveTo = rest[0].text.slice(13).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const pushCur = () => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (const e of rest) {
        const t = e.text;
        if (t.startsWith('@@')) {
          pushCur();
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
        } else if (t.trim() === '*** End of File') {
          if (!cur) cur = { anchor: null, eof: false, ops: [] };
          cur.eof = true;
          pushCur();
        } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (!cur) cur = { anchor: null, eof: false, ops: [] };
          if (t === '') cur.ops.push({ t: 'ctx', text: '', bs: false });
          else
            cur.ops.push({
              t: t.charAt(0) === ' ' ? 'ctx' : t.charAt(0) === '-' ? 'del' : 'add',
              text: t.slice(1),
              bs: false,
            });
        } else {
          throw new Exit2(`error: parse ${e.n}`);
        }
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      sections.push({ kind, path, addLines: [], moveTo, chunks });
    }
    i = j;
  }
  return sections.map((s) => (tree) => applyVSection(tree, s));
}

function applyVSection(tree: Tree, s: VSection): void {
  if (!isSafePath(s.path)) throw new Fail('unsafe', s.path);
  if (s.kind === 'add') {
    if (tree.has(s.path)) throw new Fail('exists', s.path);
    tree.put(s.path, joinFile({ brk: '\n', lines: s.addLines, finalBreak: true }));
    return;
  }
  if (s.kind === 'del') {
    if (!tree.has(s.path)) throw new Fail('missing', s.path);
    tree.remove(s.path);
    return;
  }
  const moveTo = s.moveTo;
  if (moveTo !== null && !isSafePath(moveTo)) throw new Fail('unsafe', moveTo);
  if (!tree.has(s.path)) throw new Fail('missing', s.path);
  if (moveTo !== null && tree.has(moveTo)) throw new Fail('exists', moveTo);
  const ft = splitFile(tree.get(s.path)!);
  let cursor = 0;
  for (const chunk of s.chunks) {
    if (chunk.anchor !== null) {
      const idx = findAnchor(ft.lines, chunk.anchor, STRICT.flag, cursor);
      if (idx < 0) throw new Fail('no-match', s.path);
      cursor = idx + 1;
    }
    const oldPat = chunk.ops.filter((o) => o.t !== 'add').map((o) => o.text);
    const newCount = chunk.ops.filter((o) => o.t !== 'del').length;
    if (oldPat.length === 0) {
      const adds = chunk.ops.filter((o) => o.t === 'add').map((o) => o.text);
      const at = chunk.eof ? ft.lines.length : Math.min(cursor, ft.lines.length);
      ft.lines = [...ft.lines.slice(0, at), ...adds, ...ft.lines.slice(at)];
      cursor = at + adds.length;
    } else {
      const found = findOccurrences(ft.lines, oldPat, STRICT.flag, cursor, chunk.eof);
      if (!found) throw new Fail('no-match', s.path);
      const pos = found.positions[0];
      ft.lines = applyOps(ft.lines, pos, chunk.ops, found.tier);
      cursor = pos + newCount;
    }
  }
  if (moveTo !== null) {
    tree.put(moveTo, joinFile(ft));
    tree.remove(s.path);
    tree.moves.push([s.path, moveTo]);
  } else {
    tree.put(s.path, joinFile(ft));
  }
}

// -------------------------------------------------------------------- json

interface JEdit {
  command: string;
  path: string;
  fileText: string;
  oldStr: string;
  newStr: string;
  insertLine: number;
}

/** An edit object, or null when a key is missing or mistyped. */
function validEdit(o: unknown): JEdit | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const base: JEdit = { command: '', path: '', fileText: '', oldStr: '', newStr: '', insertLine: 0 };
  if (typeof r.path !== 'string' || typeof r.command !== 'string') return null;
  base.path = r.path;
  base.command = r.command;
  if (r.command === 'create') {
    if (typeof r.file_text !== 'string') return null;
    base.fileText = r.file_text;
    return base;
  }
  if (r.command === 'str_replace') {
    if (typeof r.old_str !== 'string' || r.old_str === '') return null;
    if (r.new_str !== undefined && typeof r.new_str !== 'string') return null;
    base.oldStr = r.old_str;
    base.newStr = typeof r.new_str === 'string' ? r.new_str : '';
    return base;
  }
  if (r.command === 'insert') {
    if (typeof r.insert_line !== 'number' || !Number.isInteger(r.insert_line)) return null;
    if (typeof r.new_str !== 'string') return null;
    base.insertLine = r.insert_line;
    base.newStr = r.new_str;
    return base;
  }
  return null;
}

export function jsonEdits(text: string, lines: string[]): Edit[] {
  const objs: JEdit[] = [];
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx >= 0 && lines[firstIdx].trimStart().startsWith('[')) {
    // One JSON array of edit objects; any fault is at the array's line.
    const startLine = firstIdx + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${startLine}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2(`error: parse ${startLine}`);
    for (const el of parsed) {
      const v = validEdit(el);
      if (!v) throw new Exit2(`error: parse ${startLine}`);
      objs.push(v);
    }
  } else {
    // JSON Lines: one edit object a line, blank lines ignored.
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const v = validEdit(parsed);
      if (!v) throw new Exit2(`error: parse ${i + 1}`);
      objs.push(v);
    }
  }
  return objs.map((o) => (tree) => applyJEdit(tree, o));
}

function applyJEdit(tree: Tree, o: JEdit): void {
  if (!isSafePath(o.path)) throw new Fail('unsafe', o.path);
  if (o.command === 'create') {
    if (tree.has(o.path)) throw new Fail('exists', o.path);
    tree.put(o.path, o.fileText);
    return;
  }
  if (o.command === 'str_replace') {
    if (!tree.has(o.path)) throw new Fail('missing', o.path);
    const raw = tree.get(o.path)!;
    const crlf = splitFile(raw).brk === '\r\n';
    const flat = (s: string) => s.replace(/\r\n/g, '\n');
    const work = crlf ? flat(raw) : raw;
    const oldS = crlf ? flat(o.oldStr) : o.oldStr;
    const newS = crlf ? flat(o.newStr) : o.newStr;
    let count = 0;
    let first = -1;
    let idx = work.indexOf(oldS);
    while (idx >= 0) {
      if (first < 0) first = idx;
      count += 1;
      idx = work.indexOf(oldS, idx + 1);
    }
    if (count === 0) throw new Fail('no-match', o.path);
    if (count > 1) throw new Fail('ambiguous', o.path);
    let result = work.slice(0, first) + newS + work.slice(first + oldS.length);
    if (crlf) result = result.replace(/\n/g, '\r\n');
    tree.put(o.path, result);
    return;
  }
  // insert
  if (!tree.has(o.path)) throw new Fail('missing', o.path);
  const ft = splitFile(tree.get(o.path)!);
  if (o.insertLine < 0 || o.insertLine > ft.lines.length) throw new Fail('no-match', o.path);
  let add: string[] = [];
  if (o.newStr !== '') {
    add = o.newStr.split('\n');
    if (add[add.length - 1] === '') add.pop();
    add = add.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  }
  ft.lines = [...ft.lines.slice(0, o.insertLine), ...add, ...ft.lines.slice(o.insertLine)];
  tree.put(o.path, joinFile(ft));
}
