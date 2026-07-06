/**
 * Fuzzy filtering by Levenshtein (edit) distance. Used to search card lists
 * (repositories, projects) by name and other fields, tolerating small typos.
 *
 * Matching strategy, per haystack string (all comparisons case-insensitive):
 *   - an exact substring is always a match, ranked first (prefix beats mid-word);
 *   - otherwise, for queries of 3+ characters, the query is compared against
 *     every substring window whose length is within the typo budget of the
 *     query length; a match is accepted when the smallest edit distance is
 *     within that budget (~1 edit per 3 query characters).
 * Short queries (1-2 chars) match on substring only, since fuzzing them is noise.
 * Results are ordered best-match-first; ties keep the input order (stable sort).
 */

/** Levenshtein edit distance between two strings (insert/delete/substitute). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const curr = new Array<number>(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      // Dense arrays, every index in range is set; the assertions satisfy
      // noUncheckedIndexedAccess without a per-cell guard.
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[n]!;
}

/** Number of edits tolerated for a query of the given length (~1 per 3 chars). */
function typoBudget(queryLength: number): number {
  return Math.floor(queryLength / 3);
}

/**
 * Best (lowest) score for `query` against `text`, or null when there is no
 * match. Both arguments must already be lower-cased. Lower is better; substring
 * matches score below any fuzzy match.
 */
function bestScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const idx = text.indexOf(query);
  if (idx !== -1) return idx === 0 ? 0 : 0.5;

  const budget = typoBudget(query.length);
  if (budget === 0) return null; // too short to fuzz -- substring only

  const qlen = query.length;
  let best = Infinity;
  for (let len = Math.max(1, qlen - budget); len <= qlen + budget; len += 1) {
    for (let start = 0; start + len <= text.length; start += 1) {
      const dist = levenshtein(query, text.slice(start, start + len));
      if (dist < best) best = dist;
      if (best === 0) break;
    }
    if (best === 0) break;
  }
  return best <= budget ? 1 + best : null;
}

/**
 * Whether `text` fuzzy-matches `query` (same scoring as {@link fuzzyFilter}). An
 * empty/whitespace query matches everything. Useful for per-node tree filtering.
 */
export function fuzzyMatches(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return bestScore(q, text.toLowerCase()) !== null;
}

/**
 * Filter `items` by fuzzy-matching `query` against the strings `toText` returns
 * for each item (e.g. a project's name and path). An empty/whitespace query
 * returns a copy of all items in their original order. Otherwise only matching
 * items are returned, ordered best-match-first.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  toText: (item: T) => readonly string[],
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...items];

  const scored: { item: T; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    let best: number | null = null;
    for (const raw of toText(item)) {
      const score = bestScore(q, raw.toLowerCase());
      if (score !== null && (best === null || score < best)) best = score;
    }
    if (best !== null) scored.push({ item, score: best, order });
  });

  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.map((s) => s.item);
}
