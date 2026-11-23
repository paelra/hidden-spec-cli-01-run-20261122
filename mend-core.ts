// mend-core.ts — the mend patch engine: parsing of the four edit formats
// (SPEC.md sections 4 and 6-9), three-tier line matching (section 5), and
// application of edits to an in-memory tree (sections 2, 3 and 10).
// Written for hidden-spec-cli-01-run-20261122. Node 22, standard library only.

export class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
export class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

export const blank = (s: string): boolean => s.trim() === '';

export function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// A file as lines plus its own break style and whether it ends with one.
export interface FileModel { lines: string[]; br: string; finalBreak: boolean; }
export function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}
export function writeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

// The tree as the edits leave it: `now` shadows the disk, null = deleted.
import { readFileSync, statSync } from 'node:fs';
export class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, text: string | null): void { this.now.set(p, text); }
}

export type Edit = (tree: Tree) => void;

// ---- section 5: matching ----
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => s.match(/^[ \t]*/)![0];

function normAt(line: string, tier: number): string {
  return tier === 0 ? line : tier === 1 ? trailTrim(line) : bothTrim(line);
}
export function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const want = O.map((l) => normAt(l, tier));
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (normAt(lines[i + k]!, tier) !== want[k]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
export interface Found { tier: number; at: number[]; }
export function findTier(lines: string[], O: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, O, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}
// Build the replacement lines for a match at `pos`: a context entry takes
// the file's own matched line (oIndex is its index within O); a raw entry is
// written as it is, re-indented at tier 2 (section 5).
export interface NLine { text: string; context: boolean; oIndex: number; }
export function buildN(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  let F = '', P = '';
  if (tier === 2 && O.length > 0) { F = leadOf(lines[pos] ?? ''); P = leadOf(O[0]!); }
  return N.map((n) => {
    if (n.context) return lines[pos + n.oIndex]!;
    if (tier === 2) {
      if (n.text.trim() === '') return n.text;
      if (n.text.startsWith(P)) return F + n.text.slice(P.length);
      return n.text;
    }
    return n.text;
  });
}
export function rawN(texts: string[]): NLine[] {
  return texts.map((t) => ({ text: t, context: false, oIndex: -1 }));
}

export function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}
