import { DiffOp, Hunk } from "./types";

/**
 * Extract Evlampy diff operations from an assistant message.
 */
export function parseDiffOps(text: string): DiffOp[] {
  const ops: DiffOp[] = [];

  // Regex for contructions like: <evlampy:kind path="path">content</evlampy:kind>
  const tagRegex = /<evlampy:(edit|new|rewrite|delete)\s+path="([^"]+)"\s*>(.*?)<\/evlampy:\1>/gs;

  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    const [, kind, path, body] = match;
    const cleanBody = body.trim();

    if (kind === "edit") {
      const hunks = parseHunks(cleanBody);
      if (hunks.length > 0) {
        ops.push({ kind: "edit", path, hunks });
      }
    } else if (kind === "new") {
      ops.push({ kind: "new", path, content: cleanBody });
    } else if (kind === "rewrite") {
      ops.push({ kind: "rewrite", path, content: cleanBody });
    } else if (kind === "delete") {
      ops.push({ kind: "delete", path });
    }
  }
  return ops;
}

const SEARCH_RE = /^<{5,}\s*SEARCH\s*$/;
const SEP_RE = /^={5,}\s*$/;
const REPLACE_RE = /^>{5,}\s*REPLACE\s*$/;

/** Parse one or more git-conflict-style SEARCH/REPLACE hunks. */
export function parseHunks(body: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = body.split("\n");
  let i = 0;

  while (i < lines.length) {
    if (!SEARCH_RE.test(lines[i].trim())) {
      i++;
      continue;
    }
    i++; // past <<<<<<< SEARCH

    const search: string[] = [];
    while (i < lines.length && !SEP_RE.test(lines[i].trim())) {
      search.push(lines[i]);
      i++;
    }
    if (i >= lines.length) break; // malformed, no separator
    i++; // past =======

    const replace: string[] = [];
    while (i < lines.length && !REPLACE_RE.test(lines[i].trim())) {
      replace.push(lines[i]);
      i++;
    }
    if (i < lines.length) {
      i++; // past >>>>>>> REPLACE
    }
    hunks.push({ search: search.join("\n"), replace: replace.join("\n") });
  }
  return hunks;
}

/** Strip placeholder "... existing code ..." lines as a defensive measure. */
export function stripPlaceholders(code: string): string {
  return code
    .split("\n")
    .filter(l => !/^\s*(\/\/|#|--|\/\*|\*)?\s*\.\.\.\s*existing code\s*\.\.\.\s*(\*\/)?\s*$/i.test(l))
    .join("\n");
}
