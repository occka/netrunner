/**
 * Fuzzy matching for Go to file: the query's characters must appear in order.
 * Matches in the file name, at word starts and in runs score higher.
 */
export interface FuzzyHit {
  path: string;
  score: number;
  /** Indices into `path` of the matched characters (for highlighting). */
  positions: number[];
}

const isBoundary = (prev: string | undefined) => prev === undefined || prev === "/" || prev === "\\" || prev === "_" || prev === "-" || prev === "." || prev === " ";

export function fuzzyScore(query: string, path: string): FuzzyHit | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { path, score: 0, positions: [] };
  const lower = path.toLowerCase();
  const nameStart = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\")) + 1;
  // Prefer matching inside the file name: try from the name first, then the whole path.
  const attempt = (from: number): FuzzyHit | null => {
    const positions: number[] = [];
    let i = from;
    for (const ch of q) {
      const found = lower.indexOf(ch, i);
      if (found < 0) return null;
      positions.push(found);
      i = found + 1;
    }
    let score = 0;
    positions.forEach((p, k) => {
      score += 1;
      if (p >= nameStart) score += 2;
      if (isBoundary(path[p - 1]) || (path[p] !== lower[p] && path[p - 1] === lower[p - 1])) score += 3;
      if (k > 0 && positions[k - 1] === p - 1) score += 4;
    });
    if (lower.slice(nameStart).startsWith(q)) score += 10;
    score -= path.length / 100;
    return { path, score, positions };
  };
  const inName = attempt(nameStart);
  const anywhere = attempt(0);
  if (!inName) return anywhere;
  if (!anywhere) return inName;
  return inName.score >= anywhere.score ? inName : anywhere;
}

export function fuzzyFilter(query: string, paths: string[], limit = 60): FuzzyHit[] {
  const hits: FuzzyHit[] = [];
  for (const p of paths) {
    const h = fuzzyScore(query, p);
    if (h) hits.push(h);
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return hits.slice(0, limit);
}
