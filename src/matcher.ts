// Locating a SEARCH block inside a file: exact -> fuzzy.
// In case of ambiguity (multiple equally-good matches)
// method will apply file change to the first match and show a warning to the user.

export interface MatchResult {
  /** Character offset (inclusive) where the match starts in the file. */
  start: number;
  /** Character offset (exclusive) where the match ends. */
  end: number;
  /** How it was matched, for reporting. */
  level: "exact" | "fuzzy";
  score: number;
  multipleMatches?: boolean;
}

export type MatchOutcome =
  | { ok: true; match: MatchResult }
  | { ok: false; reason: string };

const FUZZY_THRESHOLD = 0.70;

export function findMatch(fileText: string, search: string): MatchOutcome {
  const cleanSearch = search.trim();
  if (cleanSearch === "") {
    return { ok: false, reason: "empty SEARCH block" };
  }

  // 1) Exact match
  let firstIdx = fileText.indexOf(search);
  if (firstIdx !== -1) {
    const doublicateIdx = fileText.indexOf(search, firstIdx + search.length);
    return {
      ok: true,
      match: {
        start: firstIdx,
        end: firstIdx + search.length,
        level: "exact",
        score: 1.0,
        multipleMatches: doublicateIdx !== -1
      }
    };
  }

  // 2) Fuzzy match
  const fileLines = fileText.split("\n");
  const searchLines = cleanSearch.split("\n");
  const win = searchLines.length;

  if (win > fileLines.length) {
    return { ok: false, reason: "SEARCH has more lines than the file." };
  }

  let bestIndex = -1;
  let bestScore = 0;

  for (let s = 0; s + win <= fileLines.length; s++) {
    const candidate = fileLines.slice(s, s + win).join("\n");
    const score = similarity(candidate, cleanSearch);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = s;
    }
  }

  if (bestIndex !== -1 && bestScore >= FUZZY_THRESHOLD) {
    let start = 0;
    for (let k = 0; k < bestIndex; k++) {
      start += fileLines[k].length + 1;
    }
    let end = start;
    for (let k = 0; k < win; k++) {
      end += fileLines[bestIndex + k].length + 1;
    }
    end = Math.min(end, fileText.length);
    if (end > start && fileText[end - 1] === "\n") {
      end -= 1;
    }

    return { ok: true, match: { start, end, level: "fuzzy", score: bestScore } };
  }

  return {
    ok: false,
    reason: `Confidence is too low (${(bestScore * 100).toFixed(0)}%). Search block did not match.`
  };
}

/** Normalized Levenshtein similarity in [0,1]. */
export function similarity(a: string, b: string): number {
  const normA = a.replace(/\s+/g, " ").trim();
  const normB = b.replace(/\s+/g, " ").trim();
  if (normA === normB) return 1.0;

  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 1.0;

  return 1 - levenshtein(normA, normB) / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
