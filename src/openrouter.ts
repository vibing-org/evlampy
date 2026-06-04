import OpenAI from "openai";
import { ChatMsg, EffortLevel, EvlampyConfig, UsageInfo } from "./types";

export interface ChatRequest {
  config: EvlampyConfig;
  model: string;
  effort: EffortLevel;
  /** Full message list (system first, then the conversation turns). */
  messages: ChatMsg[];
  /** Called with each streamed text delta. */
  onDelta: (text: string) => void;
  /** Called with each streamed reasoning delta, if the provider exposes one. */
  onReasoningDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  usage?: UsageInfo;
}

/**
 * One single streaming request to an OpenAI-compatible endpoint (OpenRouter).
 * Provider/reasoning/usage are passed straight through — we invent no format.
 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  return new Promise(async (resolve, reject) => {
    // Guarantee instant reject even if the SDK hangs waiting for a chunk
    const onAbort = () => {
      reject(new Error("Aborted"));
    };

    if (req.signal?.aborted) {
      return onAbort();
    }
    req.signal?.addEventListener("abort", onAbort);

    try {
      const client = new OpenAI({
        baseURL: req.config.baseURL,
        apiKey: req.config.apiKey,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/3dcv/evlampy",
          "X-Title": "Evlampy",
        },
      });

      // Build the body. Extra OpenRouter fields aren't in the SDK type, so cast.
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        stream: true,
        stream_options: { include_usage: true },
        usage: { include: true },
        temperature: 0.3,
      };
      body.reasoning = { effort: req.effort };
      // service_tier: "flex" gives ~50% discount on some models (e.g. OpenAI) at the cost of higher latency.
      // Only send if explicitly configured; otherwise let OpenRouter use its default.
      if (req.config.serviceTier) {
        body.service_tier = req.config.serviceTier;
      }


      const stream = await client.chat.completions.create(body as any, {
        signal: req.signal,
      });

      let text = "";
      let usage: UsageInfo | undefined;

      for await (const chunk of stream as any) {

        // Additional check inside the loop in case the SDK swallowed the abort
        if (req.signal?.aborted) {
          return onAbort();
        }

        const choice = chunk?.choices?.[0];
        const reasoningDelta = extractReasoningDelta(choice?.delta);
        if (reasoningDelta) {
          req.onReasoningDelta?.(reasoningDelta);
        }

        const delta = extractTextDelta(choice?.delta?.content);
        if (delta) {
          text += delta;
          req.onDelta(delta);
        }
        if (chunk?.usage) {
          usage = toUsage(chunk.usage);
        }
      }

      resolve({ text, usage });
    } catch (e) {
      // If the SDK itself threw AbortError or the signal is already aborted
      if (req.signal?.aborted || (e as Error).name === "AbortError") {
        onAbort();
      } else {
        reject(e);
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
  });
}

function extractReasoningDelta(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const node = value as Record<string, unknown>;
  const text = flattenText(node.reasoning);

  return text || undefined;
}

function extractTextDelta(value: unknown): string | undefined {
  const text = flattenText(value);
  return text || undefined;
}

function flattenText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => flattenText(item)).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const node = value as Record<string, unknown>;
  if (typeof node.text === "string") {
    return node.text;
  }
  if (typeof node.output_text === "string") {
    return node.output_text;
  }
  if (node.content !== undefined) {
    return flattenText(node.content);
  }

  return "";
}

function toUsage(u: any): UsageInfo {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
    cost: typeof u.cost === "number" ? u.cost : undefined,
  };
}
