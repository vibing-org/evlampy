import OpenAI from "openai";
import { EvlampyConfig, UsageInfo } from "../types";
import { ChatRequest, ChatResponse, LlmProvider } from "./types";

export const openaiCompatibleProvider: LlmProvider = {
  chat,
};

/**
 * One single streaming request to an OpenAI-compatible endpoint (OpenRouter).
 * Provider/reasoning/usage are passed straight through; we invent no format.
 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  validateOpenAiCompatibleConfig(req.config);

  return new Promise(async (resolve, reject) => {
    // Guarantee instant reject even if the SDK hangs waiting for a chunk.
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

      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        stream: true,
        stream_options: { include_usage: true },
        usage: { include: true },
        temperature: 0.3,
        reasoning: { effort: req.effort },
      };

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

export function validateOpenAiCompatibleConfig(config: Pick<EvlampyConfig, "apiKey">): void {
  if (!config.apiKey) {
    throw new Error("API key is missing. Please run 'Evlampy: Open Global Config' and set the API key there.");
  }
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
    provider: "openai-compatible",
  };
}
