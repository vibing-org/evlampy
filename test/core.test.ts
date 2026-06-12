// Standalone sanity tests for parser + matcher (no vscode needed).
// Run: npm run test:core
import { parseChatResponse } from "../src/parser";
import { findMatch } from "../src/matcher";
import { ContentBlock, DiffOp, EvlampyConfig } from "../src/types";
import { activeModels, DEFAULT_CODEX_MODELS, normalizeProvider } from "../src/configDefaults";
import { buildCodexPrompt, CodexJsonlParser, toCodexReasoningEffort, toCodexUsage, validateCodexConfig } from "../src/providers/codexCli";
import { getProvider } from "../src/providers";
import { codexCliProvider } from "../src/providers/codexCli";
import { openaiCompatibleProvider, validateOpenAiCompatibleConfig } from "../src/providers/openaiCompatible";

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

// ---- config defaults / active model list ----
{
  check("missing provider defaults to openai-compatible", normalizeProvider(undefined) === "openai-compatible");
  check("codex provider preserved", normalizeProvider("codex") === "codex");
  check("codex model defaults", DEFAULT_CODEX_MODELS.join(",") === "gpt-5.5,gpt-5.4,gpt-5.4-mini");
  check(
    "active models use codexModels for codex",
    activeModels({ provider: "codex", models: ["openrouter-model"], codexModels: ["codex-model"] })[0] === "codex-model"
  );
  check(
    "active models use models for default provider",
    activeModels({ provider: "openai-compatible", models: ["openrouter-model"], codexModels: ["codex-model"] })[0] === "openrouter-model"
  );
  try {
    validateOpenAiCompatibleConfig({ apiKey: "" });
    check("openai-compatible requires apiKey", false);
  } catch {
    check("openai-compatible requires apiKey", true);
  }
  try {
    validateCodexConfig({ codexModels: ["gpt-5.5"] });
    check("codex does not require apiKey", true);
  } catch (e) {
    check("codex does not require apiKey", false, e);
  }
}

// ---- provider selection ----
{
  const baseConfig: EvlampyConfig = {
    provider: "openai-compatible",
    userSystemPromptPath: "AGENTS.md",
    baseURL: "https://example.test",
    apiKey: "",
    models: ["m1"],
    codexModels: ["c1"],
    serviceTier: "default",
  };

  check("default provider selects OpenAI-compatible", getProvider(baseConfig) === openaiCompatibleProvider);
  check("codex provider selects Codex CLI", getProvider({ ...baseConfig, provider: "codex" }) === codexCliProvider);
}

// ---- codex prompt builder ----
{
  const prompt = buildCodexPrompt([
    { role: "system", content: "system text" },
    { role: "user", content: "first user" },
    { role: "assistant", content: "assistant answer" },
    { role: "user", content: "second user" },
  ]);

  check("codex prompt includes system", prompt.includes("<system>\nsystem text\n</system>"));
  check("codex prompt preserves turn order", prompt.indexOf("first user") < prompt.indexOf("assistant answer") && prompt.indexOf("assistant answer") < prompt.indexOf("second user"));
  check("codex prompt says do not inspect filesystem", prompt.includes("Do not inspect the filesystem."));
  check("codex prompt says do not run commands", prompt.includes("Do not run shell commands."));
  check("codex prompt says do not use web search", prompt.includes("Do not use web search."));
  check("codex prompt says do not edit directly", prompt.includes("Do not edit files directly."));
}

// ---- codex effort mapping ----
{
  check("codex none effort omitted", toCodexReasoningEffort("none") === undefined);
  check("codex max effort maps to xhigh", toCodexReasoningEffort("max") === "xhigh");
  check("codex high effort preserved", toCodexReasoningEffort("high") === "high");
}

// ---- codex usage mapping ----
{
  const usage = toCodexUsage({
    input_tokens: 10,
    cached_input_tokens: 7,
    output_tokens: 4,
    reasoning_output_tokens: 3,
  });
  check("codex usage prompt tokens", usage?.promptTokens === 10, usage);
  check("codex usage completion tokens", usage?.completionTokens === 4, usage);
  check("codex usage total tokens", usage?.totalTokens === 14, usage);
  check("codex usage cached tokens", usage?.cachedPromptTokens === 7, usage);
  check("codex usage reasoning tokens", usage?.reasoningTokens === 3, usage);
  check("codex usage provider", usage?.provider === "codex", usage);
}

// ---- codex JSONL parser: success + usage ----
{
  let text = "";
  let reasoning = "";
  const parser = new CodexJsonlParser((delta) => { text += delta; }, (delta) => { reasoning += delta; });
  parser.handleLine(JSON.stringify({ type: "item.updated", item: { type: "reasoning", text: "thinking" } }));
  parser.handleLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }));
  parser.handleLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3, cached_input_tokens: 1, reasoning_output_tokens: 4 } }));
  const result = parser.result();
  check("codex parser streams final agent message", text === "answer" && result.text === "answer", result);
  check("codex parser ignores reasoning updates", reasoning === "");
  check("codex parser maps usage", result.usage?.totalTokens === 5 && result.usage.reasoningTokens === 4, result.usage);
}

// ---- codex JSONL parser: failures ----
{
  function throwsFor(name: string, eventLine: string, expected: string) {
    const parser = new CodexJsonlParser(() => { });
    try {
      parser.handleLine(eventLine);
      check(name, false);
    } catch (e) {
      check(name, (e as Error).message.includes(expected), (e as Error).message);
    }
  }

  throwsFor("codex parser rejects turn.failed", JSON.stringify({ type: "turn.failed", message: "bad turn" }), "bad turn");
  throwsFor("codex parser rejects malformed stdout", "{not-json", "malformed JSONL");
  throwsFor("codex parser rejects command execution", JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }), "command_execution");
  throwsFor("codex parser rejects file change", JSON.stringify({ type: "item.completed", item: { type: "file_change" } }), "file_change");
  throwsFor("codex parser rejects web search", JSON.stringify({ type: "item.completed", item: { type: "web_search" } }), "web_search");
  throwsFor("codex parser rejects mcp tool call", JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call" } }), "mcp_tool_call");
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
