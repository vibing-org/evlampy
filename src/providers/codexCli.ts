import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ChatMsg, EffortLevel, EvlampyConfig, UsageInfo } from "../types";
import { ChatRequest, ChatResponse, LlmProvider } from "./types";

type JsonObject = Record<string, unknown>;

const AUTONOMOUS_ITEM_TYPES = new Set(["command_execution", "file_change", "web_search", "mcp_tool_call"]);

export const codexCliProvider: LlmProvider = {
  chat,
};

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  validateCodexConfig(req.config);

  const tempWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "evlampy-codex-"));
  try {
    await fs.writeFile(
      path.join(tempWorkdir, "README.md"),
      "Temporary Evlampy Codex workspace. Project files are provided inside the prompt only.\n",
      "utf8"
    );
    return await runCodex(req, tempWorkdir);
  } finally {
    await fs.rm(tempWorkdir, { recursive: true, force: true });
  }
}

export function validateCodexConfig(config: Pick<EvlampyConfig, "codexModels">): void {
  if (config.codexModels.length === 0) {
    throw new Error("Codex model list is empty. Set evlampy.codexModels before using the Codex provider.");
  }
}

export function buildCodexPrompt(messages: ChatMsg[]): string {
  const parts = [
    "You are serving as the LLM backend for Evlampy, a one-shot VS Code extension.",
    "",
    "Critical operating rules:",
    "- Do not inspect the filesystem.",
    "- Do not run shell commands.",
    "- Do not use web search.",
    "- Do not edit files directly.",
    "- The only project context you may use is included below.",
    "- Return changes only in Evlampy's expected edit format.",
    "",
    "<conversation>",
  ];

  for (const message of messages) {
    parts.push(`<${message.role}>`, message.content, `</${message.role}>`);
  }
  parts.push("</conversation>", "");

  return parts.join("\n");
}

export function toCodexReasoningEffort(effort: EffortLevel): string | undefined {
  switch (effort) {
    case "none":
      return undefined;
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
    case "max":
      return "xhigh";
  }
}

export class CodexJsonlParser {
  private textParts: string[] = [];
  private usage?: UsageInfo;

  constructor(
    private readonly onDelta: (text: string) => void,
    private readonly onReasoningDelta?: (text: string) => void
  ) { }

  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let event: JsonObject;
    try {
      event = JSON.parse(trimmed) as JsonObject;
    } catch {
      throw new Error(`Codex CLI emitted malformed JSONL: ${line.slice(0, 200)}`);
    }

    if (event.type === "turn.failed") {
      throw new Error(`Codex turn failed: ${extractErrorMessage(event)}`);
    }
    if (event.type === "error") {
      throw new Error(`Codex CLI error: ${extractErrorMessage(event)}`);
    }
    if (event.type === "turn.completed") {
      this.usage = toCodexUsage(event.usage);
      return;
    }

    const item = event.item;
    if (!item || typeof item !== "object") {
      return;
    }

    const node = item as JsonObject;
    const itemType = String(node.type ?? "");
    if (AUTONOMOUS_ITEM_TYPES.has(itemType)) {
      throw new Error(`Codex attempted a disabled autonomous action (${itemType}). Evlampy disables provider-side tools.`);
    }

    const text = typeof node.text === "string" ? node.text : "";
    if (!text) {
      return;
    }

    if (itemType === "agent_message" && event.type === "item.completed") {
      this.textParts.push(text);
      this.onDelta(text);
    }
  }

  result(): ChatResponse {
    return {
      text: this.textParts.join(""),
      usage: this.usage,
    };
  }
}

export function toCodexUsage(value: unknown): UsageInfo | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as JsonObject;
  const promptTokens = numberValue(usage.input_tokens);
  const completionTokens = numberValue(usage.output_tokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens: numberValue(usage.cached_input_tokens),
    reasoningTokens: numberValue(usage.reasoning_output_tokens),
    provider: "codex",
  };
}

async function runCodex(req: ChatRequest, tempWorkdir: string): Promise<ChatResponse> {
  return new Promise((resolve, reject) => {
    const args = buildCodexArgs(tempWorkdir, req.model, req.effort);
    const parser = new CodexJsonlParser(req.onDelta, req.onReasoningDelta);
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcessWithoutNullStreams;

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      req.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const fail = (error: Error) => {
      terminateChild(child);
      settle(() => reject(error));
    };

    const onAbort = () => {
      terminateChild(child);
      settle(() => reject(new Error("Aborted")));
    };

    if (req.signal?.aborted) {
      return settle(() => reject(new Error("Aborted")));
    }

    try {
      child = spawn("codex", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (e) {
      return settle(() => reject(mapCodexError(e, stderr, req.model)));
    }

    req.signal?.addEventListener("abort", onAbort);

    child.on("error", (e) => {
      settle(() => reject(mapCodexError(e, stderr, req.model)));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      try {
        for (const line of lines) {
          parser.handleLine(line);
        }
      } catch (e) {
        fail(e as Error);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      try {
        if (stdoutBuffer.trim()) {
          parser.handleLine(stdoutBuffer);
        }
      } catch (e) {
        return settle(() => reject(e));
      }

      if (code === 0) {
        return settle(() => resolve(parser.result()));
      }

      settle(() => reject(mapCodexExit(stderr, req.model)));
    });

    child.stdin.end(buildCodexPrompt(req.messages));
  });
}

function buildCodexArgs(tempWorkdir: string, model: string, effort: EffortLevel): string[] {
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    tempWorkdir,
    "--model",
    model,
    "-c",
    "web_search_request=false",
    "-c",
    "sandbox_workspace_write.network_access=false",
  ];

  const codexEffort = toCodexReasoningEffort(effort);
  if (codexEffort) {
    args.push("-c", `model_reasoning_effort="${codexEffort}"`);
  }

  args.push("-");
  return args;
}

function terminateChild(child: ChildProcessWithoutNullStreams | undefined): void {
  if (!child || child.killed) {
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 1500);
}

function mapCodexError(error: unknown, stderr: string, model: string): Error {
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code === "ENOENT") {
    return new Error("Codex CLI was not found. Install OpenAI Codex and make sure `codex` is available on PATH.");
  }
  return mapCodexExit(stderr || (error as Error).message, model);
}

function mapCodexExit(stderr: string, model: string): Error {
  const message = stderr.trim();
  if (/login|auth|sign in/i.test(message)) {
    return new Error(`Codex CLI is not signed in. Run 'Evlampy: Sign in to Codex' or 'codex login'. ${message}`);
  }
  if (message) {
    return new Error(`Codex CLI failed for model '${model}': ${message}`);
  }
  return new Error(`Codex CLI failed for model '${model}'.`);
}

function extractErrorMessage(event: JsonObject): string {
  const message = event.message ?? event.error;
  if (typeof message === "string") {
    return message;
  }
  return JSON.stringify(event);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
