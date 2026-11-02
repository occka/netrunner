/**
 * Line diff for the editor gutter (changes against the index) and merge
 * conflict parsing. Pure functions, tested without Monaco.
 */

export interface Hunk {
  kind: "add" | "delete" | "modify";
  /** 0-based line index and count in the baseline (index) text. */
  baseStart: number;
  baseCount: number;
  /** 0-based line index and count in the current text. */
  start: number;
  count: number;
}

export const splitLines = (text: string) => text.split(/\r?\n/);

/** Lines of `a` matched to lines of `b` (LCS), as index pairs. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i++, j++]);
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Above this many cells the middle part is reported as one change (no DP). */
const MAX_CELLS = 4_000_000;

export function diffLines(base: string[], current: string[]): Hunk[] {
  // Common prefix and suffix first: most edits touch a small region.
  let pre = 0;
  while (pre < base.length && pre < current.length && base[pre] === current[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < current.length - pre && base[base.length - 1 - suf] === current[current.length - 1 - suf]) suf++;
  const a = base.slice(pre, base.length - suf);
  const b = current.slice(pre, current.length - suf);
  const pairs: [number, number][] = a.length * b.length > MAX_CELLS ? [] : lcsPairs(a, b);
  pairs.push([a.length, b.length]); // sentinel
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    if (pi > i || pj > j) {
      const baseCount = pi - i;
      const count = pj - j;
      hunks.push({ kind: baseCount === 0 ? "add" : count === 0 ? "delete" : "modify", baseStart: pre + i, baseCount, start: pre + j, count });
    }
    i = pi + 1;
    j = pj + 1;
  }
  return hunks;
}

/** The baseline with one hunk taken from the current text (for Stage change). */
export function applyHunkToBase(base: string[], current: string[], h: Hunk): string[] {
  return [...base.slice(0, h.baseStart), ...current.slice(h.start, h.start + h.count), ...base.slice(h.baseStart + h.baseCount)];
}

// ---------- Merge conflicts ----------

export interface Conflict {
  /** 0-based line indices of the markers. */
  start: number;
  /** `|||||||` line of a diff3 conflict, if any. */
  base: number | null;
  middle: number;
  end: number;
  currentLabel: string;
  incomingLabel: string;
}

export function findConflicts(lines: string[]): Conflict[] {
  const out: Conflict[] = [];
  let open: Partial<Conflict> | null = null;
  lines.forEach((line, i) => {
    if (line.startsWith("<<<<<<<")) open = { start: i, base: null, currentLabel: line.slice(7).trim() };
    else if (open && line.startsWith("|||||||") && open.middle === undefined) open.base = i;
    else if (open && line.startsWith("=======") && open.middle === undefined) open.middle = i;
    else if (open && open.middle !== undefined && line.startsWith(">>>>>>>")) {
      out.push({ ...(open as Conflict), end: i, incomingLabel: line.slice(7).trim() });
      open = null;
    }
  });
  return out;
}

export type ConflictChoice = "current" | "incoming" | "both";

/** The lines that replace the whole conflict block (markers included). */
export function resolveConflict(lines: string[], c: Conflict, choice: ConflictChoice): string[] {
  const current = lines.slice(c.start + 1, c.base ?? c.middle);
  const incoming = lines.slice(c.middle + 1, c.end);
  return choice === "current" ? current : choice === "incoming" ? incoming : [...current, ...incoming];
}
