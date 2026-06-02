// Shared types between the extension host and (where relevant) the webview.

export interface EvlampyConfig {
  /** Path (relative to workspace root, or absolute) to the user's system prompt file. Optional. */
  userSystemPromptPath?: string;
  /** OpenAI-compatible base URL. Defaults to OpenRouter. */
  baseURL: string;
  /** API key. Supports ${env:VAR} interpolation. */
  apiKey: string;
  /** Models offered in the model picker (OpenRouter slugs, e.g. "qwen/qwen3-max"). */
  models: string[];
  /** Which of `models` is selected by default. Falls back to models[0]. */
  defaultModel?: string;
  /** Service tier: "flex" (~50% discount on some models, e.g. OpenAI), "priority" or not stated (let AI provider use default). */
  serviceTier?: string;
}

/** An attachment chip in the chat: a whole file or a selected range of one. */
export interface Attachment {
  /** Workspace-relative path. */
  path: string;
  /** 1-based inclusive line range, if a selection. Absent => whole file. */
  range?: { startLine: number; endLine: number };
  /** The actual text content captured at attach time. */
  content: string;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD cost, if the provider reported it. */
  cost?: number;
}

export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** A chat message sent to the model. */
export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A saved chat session (history). */
export interface ChatSession {
  id: string;
  title: string;
  turns: DisplayTurn[];
  totalCost: number;
  totalTokens: number;
  updatedAt: number;
}

/** A turn as shown in the panel (no file bodies). */
export interface DisplayTurn {
  role: "user" | "assistant" | "system" | "error";
  text: string;
  report?: ApplyReport;
}

/** A single search/replace hunk inside an `evlampy:edit` block. */
export interface Hunk {
  search: string;
  replace: string;
}

export type DiffOp =
  | { kind: "edit"; path: string; hunks: Hunk[] }
  | { kind: "new"; path: string; content: string }
  | { kind: "rewrite"; path: string; content: string }
  | { kind: "delete"; path: string };

// ---- Review model ----

export type ReviewStatus = "pending" | "accepted" | "rejected";

export interface ReviewFile {
  path: string;
  status: ReviewStatus;
  /** Short note (e.g. "3 hunk(s) applied", "new file", "deleted"). */
  detail: string;
}

// ---- Messages: webview <-> extension ----

export type ToWebview =
  | { type: "init"; models: string[]; defaultModel: string }
  | { type: "addAttachment"; attachment: Attachment }
  | { type: "userMessage"; text: string }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantReasoningDelta"; text: string }
  | { type: "assistantDone"; usage?: UsageInfo }
  | { type: "fileSuggestions"; query: string; items: string[] }
  | { type: "applyReport"; report: ApplyReport }
  | { type: "clearChat" }
  | { type: "loadChat"; turns: DisplayTurn[]; totalCost: number; totalTokens: number }
  | { type: "status"; text: string }
  | { type: "error"; message: string };

export type FromWebview =
  | { type: "ready"; transcript?: DisplayTurn[]; totalCost?: number; totalTokens?: number }
  | {
      type: "send";
      text: string;
      attachments: Attachment[];
      model: string;
      effort: EffortLevel;
    }
  | { type: "requestFileSuggestions"; query: string }
  | { type: "attachByPath"; path: string }
  | { type: "attachPaths"; paths: string[] }
  | { type: "openConfig" }
  | { type: "removeAttachment"; index: number }
  | { type: "clearAttachments" }
  | { type: "cancel" };

export interface ApplyFailure {
  hunkIndex?: number;
  detail: string;
  search?: string;
  replace?: string;
}

export interface ApplyResultItem {
  path: string;
  ok: boolean;
  detail: string;
  kind: DiffOp["kind"];
  opIndex: number;
  partial?: boolean;
  failures?: ApplyFailure[];
}

export interface ApplyReport {
  items: ApplyResultItem[];
  appliedCount: number;
  failedCount: number;
}

// ---- Review events (applier -> provider/extension) ----

export type ReviewEvent =
  | { kind: "start"; files: ReviewFile[] }
  | { kind: "update"; path: string; status: ReviewStatus }
  | { kind: "done" }
  | { kind: "navigated" };
