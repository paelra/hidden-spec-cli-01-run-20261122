// mend-core.ts — the shared machinery of mend, written from SPEC.md:
// the two error kinds, the patch line split (section 3), path safety
// (section 3), format detection (section 4), the in-memory tree the edits
// act on, the line model of a file, and the three-tier matching of
// section 5. main.ts drives; mend-formats.ts reads the four formats.

import { readFileSync } from 'node:fs';

/** A fatal problem with the patch itself: main.ts prints `line`, exit 2. */
export class Exit2 extends Error {
  line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed: main.ts prints `error: <code> <path>`, exit 1. */
export class Fail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

/**
 * A patch's lines (section 3): its text split at `\n`, each line with one
 * trailing `\r` removed, and without the empty piece after a final `\n`.
 */
export function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * Section 3: a path is safe when it is not empty, does not start with `/`,
 * holds no `\`, and none of its `/`-separated segments is empty, `.` or
 * `..`.
 */
export function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Section 4: which format a patch read with `--format=auto` is in. */
export function detectFormat(lines: string[]): string | null {
  const isBlank = (l: string) => l.trim() === '';
  const first = lines.find((l) => !isBlank(l));
  if (first !== undefined) {
    if (first.trim() === '*** Begin Patch') return 'v4a';
    const lead = first.replace(/^\s+/, '');
    if (lead.startsWith('[') || lead.startsWith('{')) return 'json';
  }
  const noTrail = (l: string) => l.replace(/\s+$/, '');
  if (lines.some((l) => noTrail(l) === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/**
 * The tree a patch acts on. Nothing is written to disk while edits run:
 * `now` is the overlay of paths the patch has touched (a null value is a
 * path that does not exist any more), over the bytes the files started
 * with. main.ts snapshots and restores `now` and `moves` around each edit,
 * which is what makes a failed edit change nothing.
 */
export class Tree {
  now = new Map<string, string | null>();
  moves: [string, string][] = [];
  diskCache = new Map<string, string | null>();

  /** The bytes a path held before the patch, or null if it did not exist. */
  original(p: string): string | null {
    if (!this.diskCache.has(p)) {
      let v: string | null = null;
      try {
        v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.diskCache.set(p, v);
    }
    return this.diskCache.get(p)!;
  }

  /** The bytes a path holds now, as earlier edits left them. */
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  has(p: string): boolean {
    return this.get(p) !== null;
  }

  put(p: string, text: string): void {
    this.now.set(p, text);
  }

  remove(p: string): void {
    this.now.set(p, null);
  }
}

/**
 * A file as lines (section 3): its break is CRLF when its first line feed
 * follows a carriage return, and LF otherwise; the last, empty piece after
 * a final break is not a line, and `finalBreak` remembers it was there. An
 * empty file has no lines and does not end with a break.
 */
export interface FileText {
  brk: string;
  lines: string[];
  finalBreak: boolean;
}

export function splitFile(text: string): FileText {
  const i = text.indexOf('\n');
  const brk = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { brk, lines: [], finalBreak: false };
  const parts = text.split(brk);
  let finalBreak = false;
  if (parts[parts.length - 1] === '') {
    finalBreak = true;
    parts.pop();
  }
  return { brk, lines: parts, finalBreak };
}

/** The bytes of a file in the line model; a file of no lines is empty. */
export function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.finalBreak ? f.brk : '');
}

/**
 * One line of a hunk or chunk body: a context line (`ctx`, in both the old
 * and the new lines), an old line (`del`) or a new line (`add`). `bs` is
 * set when a `\` line (as in `\ No newline at end of file`) follows it, and
 * `blank` when the body line was a completely empty line (unified hunks
 * drop those at the end of a body).
 */
export interface Op {
  t: 'ctx' | 'del' | 'add';
  text: string;
  bs: boolean;
  blank?: boolean;
}

const trimTrailWs = (s: string) => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrailWs(a) === trimTrailWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

export interface Found {
  tier: number;
  positions: number[];
}

/**
 * Section 5: the occurrences of `pat` in `lines`, at the first tier at
 * which it occurs at least once (tier 0 only when `strict`), counting only
 * positions at or after `fromPos`; with `mustEndAtEnd`, only occurrences
 * that end at the file's last line. Null when it occurs at no tier.
 */
export function findOccurrences(
  lines: string[],
  pat: string[],
  strict: boolean,
  fromPos = 0,
  mustEndAtEnd = false,
): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = fromPos; i + pat.length <= lines.length; i++) {
      if (mustEndAtEnd && i + pat.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < pat.length; k++) {
        if (!lineEq(lines[i + k], pat[k], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `fromPos` equal to a single-line anchor. */
export function findAnchor(lines: string[], anchor: string, strict: boolean, fromPos: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = fromPos; i < lines.length; i++) {
      if (lineEq(lines[i], anchor, tier)) return i;
    }
  }
  return -1;
}

/**
 * Write a matched hunk or chunk into a file's lines: context lines are
 * written as the file's own matched lines, never the patch's; at tier 2
 * every other new line is re-indented (the first matched line's leading
 * whitespace replaces the old lines' first line's, where the new line
 * starts with it). Returns the whole file's new lines.
 */
export function applyOps(lines: string[], pos: number, ops: Op[], tier: number): string[] {
  const oldLen = ops.filter((o) => o.t !== 'add').length;
  let f = '';
  let p = '';
  if (tier === 2) {
    f = /^[ \t]*/.exec(lines[pos] ?? '')![0];
    const firstOld = ops.find((o) => o.t !== 'add');
    p = firstOld ? /^[ \t]*/.exec(firstOld.text)![0] : '';
  }
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.t === 'ctx') {
      out.push(lines[pos + oi]);
      oi += 1;
    } else if (op.t === 'del') {
      oi += 1;
    } else {
      let s = op.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + oldLen)];
}
