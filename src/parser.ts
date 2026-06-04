import { DiffOp, Hunk, ContentBlock } from "./types";

/**
 * Parses the raw LLM response into a sequence of text blocks and diff operations.
 * Single-pass parsing ensures we don't lose text between tags and avoids redundant regex matching.
 */
export function parseChatResponse(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let opIndex = 0;

  // Regex for constructions like: <evlampy:kind path="path">content</evlampy:kind>
  const tagRegex = /<evlampy:(edit|new|rewrite|delete)\s+path="([^"]+)"\s*>(.*?)<\/evlampy:\1>/gs;

  let currentIndex = 0;
  let match;

  while ((match = tagRegex.exec(text)) !== null) {
    // Capture text before the tag
    if (match.index > currentIndex) {
      const content = text.slice(currentIndex, match.index);
      if (content.trim()) {
        blocks.push({ type: "text", content });
      }
    }

    const [, kind, path, body] = match;
    const cleanBody = body.trim();
    let op: DiffOp | null = null;

    // Parse the specific operation
    if (kind === "edit") {
      const hunks = parseHunks(cleanBody);
      if (hunks.length > 0) {
        op = { kind: "edit", path, hunks };
      }
    } else if (kind === "new") {
      op = { kind: "new", path, content: cleanBody };
    } else if (kind === "rewrite") {
      op = { kind: "rewrite", path, content: cleanBody };
    } else if (kind === "delete") {
      op = { kind: "delete", path };
    }

    // Add to results
    if (op) {
      blocks.push({ type: "op", op, opIndex: opIndex++ });
    } else {
      // Fallback: if it looked like a tag but failed to parse (e.g. empty edit),
      // treat the whole matched string as regular text so it's not lost.
      blocks.push({ type: "text", content: match[0] });
    }

    currentIndex = tagRegex.lastIndex;
  }

  // Capture any remaining text after the last tag
  if (currentIndex < text.length) {
    const content = text.slice(currentIndex);
    if (content.trim()) {
      blocks.push({ type: "text", content });
    }
  }

  return blocks;
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
