// Standalone sanity tests for parser + matcher (no vscode needed).
// Run: npm run test:core
import { parseChatResponse } from "../src/parser";
import { findMatch } from "../src/matcher";
import { ContentBlock, DiffOp } from "../src/types";

/** Helper: extract DiffOps from parsed ContentBlocks. */
function extractOps(blocks: ContentBlock[]): DiffOp[] {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "op" }> => b.type === "op")
    .map((b) => b.op);
}

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}`, extra ?? "");
  }
}

// ---- parser: edit with one hunk ----
{
  const resp = [
    "Here is the change.",
    "<evlampy:edit path=\"src/Foo.scala\">",
    "<<<<<<< SEARCH",
    "  val x = 1",
    "=======",
    "  val x = 2",
    ">>>>>>> REPLACE",
    "</evlampy:edit>",
    "Done.",
  ].join("\n");
  const ops = extractOps(parseChatResponse(resp));
  check("one edit op parsed", ops.length === 1, ops);
  if (ops[0]?.kind === "edit") {
    check("hunk search", ops[0].hunks[0].search === "  val x = 1");
    check("hunk replace", ops[0].hunks[0].replace === "  val x = 2");
    check("path", ops[0].path === "src/Foo.scala");
  }
}

// ---- parser: multiple hunks + ignores normal code fences ----
{
  const resp = [
    "```python",
    "print('not an edit')",
    "```",
    "<evlampy:edit path=\"a.ts\">",
    "<<<<<<< SEARCH",
    "a",
    "=======",
    "A",
    ">>>>>>> REPLACE",
    "<<<<<<< SEARCH",
    "b",
    "=======",
    "B",
    ">>>>>>> REPLACE",
    "</evlampy:edit>",
  ].join("\n");
  const ops = extractOps(parseChatResponse(resp));
  check("ignores plain fence; one edit", ops.length === 1, ops);
  if (ops[0]?.kind === "edit") {
    check("two hunks", ops[0].hunks.length === 2, ops[0].hunks);
  }
}

// ---- parser: xml edit wrapper with inner ``` (the qwen case) ----
{
  const resp = [
    "Updating the docs:",
    "<evlampy:edit path=\"docs/x.md\">",
    "<<<<<<< SEARCH",
    "Example:",
    "```bash",
    "old --flag",
    "```",
    "=======",
    "Example:",
    "```bash",
    "new --flag",
    "```",
    ">>>>>>> REPLACE",
    "</evlampy:edit>",
    "Done.",
  ].join("\n");
  const ops = extractOps(parseChatResponse(resp));
  check("3-tick edit with inner fences: one op", ops.length === 1, ops);
  if (ops[0]?.kind === "edit") {
    check("inner ``` kept in search", ops[0].hunks[0].search === "Example:\n```bash\nold --flag\n```", JSON.stringify(ops[0].hunks[0].search));
    check("inner ``` kept in replace", ops[0].hunks[0].replace === "Example:\n```bash\nnew --flag\n```", JSON.stringify(ops[0].hunks[0].replace));
  }
}

// ---- parser: two hunks, xml wrapper, inner fences in first ----
{
  const resp = [
    "<evlampy:edit path=\"a.md\">",
    "<<<<<<< SEARCH",
    "```",
    "a",
    "```",
    "=======",
    "```",
    "A",
    "```",
    ">>>>>>> REPLACE",
    "<<<<<<< SEARCH",
    "plain b",
    "=======",
    "plain B",
    ">>>>>>> REPLACE",
    "</evlampy:edit>",
  ].join("\n");
  const ops = extractOps(parseChatResponse(resp));
  check("two hunks despite inner fences", ops[0]?.kind === "edit" && ops[0].hunks.length === 2, ops);
}

// ---- parser: new + rewrite + delete ----
{
  const resp = [
    "<evlampy:new path=\"src/New.ts\">",
    "export const x = 1;",
    "</evlampy:new>",
    "<evlampy:rewrite path=\"src/Old.ts\">",
    "export const y = 2;",
    "</evlampy:rewrite>",
    "<evlampy:delete path=\"src/Gone.ts\">",
    "</evlampy:delete>",
  ].join("\n");
  const ops = extractOps(parseChatResponse(resp));
  check("three ops", ops.length === 3, ops.map((o) => o.kind));
  check("new content", ops[0].kind === "new" && ops[0].content === "export const x = 1;");
  check("delete kind", ops[2].kind === "delete");
}

// ---- matcher: exact unique ----
{
  const file = "line1\nline2\nTARGET\nline4\n";
  const r = findMatch(file, "TARGET");
  check("exact match ok", r.ok && r.match.level === "exact", r);
  if (r.ok) {
    check("exact span", file.slice(r.match.start, r.match.end) === "TARGET");
  }
}

// ---- matcher: ambiguous exact -> apply first match with warning flag ----
{
  const file = "dup\nmiddle\ndup\n";
  const r = findMatch(file, "dup");
  check("ambiguous exact returns first match", r.ok && r.match.multipleMatches === true, r);
  if (r.ok) {
    check("first match is at start", r.match.start === 0 && r.match.end === 3);
  }
}

// ---- matcher: fuzzy (trailing whitespace mismatch falls back to fuzzy) ----
{
  const file = "alpha\n  beta\ngamma\n"; // clean
  const r = findMatch(file, "  beta   "); // model emitted trailing spaces
  check("fuzzy match for whitespace mismatch", r.ok && r.match.level === "fuzzy", r);
  if (r.ok) {
    check("fuzzy span covers beta", file.slice(r.match.start, r.match.end).includes("beta"));
  }
}

// ---- matcher: fuzzy (one char off) ----
{
  const file = "function foo() {\n  return 42;\n}\n";
  const r = findMatch(file, "function foo() {\n  return 43;\n}");
  check("fuzzy match ok", r.ok && r.match.level === "fuzzy", r);
}

// ---- matcher: too different -> fail ----
{
  const file = "completely\nunrelated\ncontent\n";
  const r = findMatch(file, "xxxxxxx\nyyyyyyy\nzzzzzzz");
  check("no confident match fails", !r.ok, r);
}

// ---- end-to-end: apply a hunk via offsets ----
{
  const file = "header\nold body line\nfooter\n";
  const ops = extractOps(parseChatResponse(
    [
      "<evlampy:edit path=\"f.txt\">",
      "<<<<<<< SEARCH",
      "old body line",
      "=======",
      "new body line",
      ">>>>>>> REPLACE",
      "</evlampy:edit>",
    ].join("\n")
  ));
  if (ops[0]?.kind === "edit") {
    const r = findMatch(file, ops[0].hunks[0].search);
    if (r.ok) {
      const applied = file.slice(0, r.match.start) + ops[0].hunks[0].replace + file.slice(r.match.end);
      check("applied result", applied === "header\nnew body line\nfooter\n", JSON.stringify(applied));
    } else {
      check("applied result", false, r);
    }
  }
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
