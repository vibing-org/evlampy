// Shared types between the extension host and (where relevant) the webview.

export type ProviderKind = "openai-compatible" | "codex";

export interface EvlampyConfig {
  /** Active LLM backend. Defaults to OpenAI-compatible providers. */
  provider: ProviderKind;
  /** Path (relative to workspace root, or absolute) to the user's system prompt file. Optional. */
  userSystemPromptPath?: string;
  /** OpenAI-compatible base URL. Defaults to OpenRouter. */
  baseURL: string;
  /** API key. Supports ${env:VAR} interpolation. */
  apiKey: string;
  /** Models offered in the model picker (OpenRouter slugs, e.g. "qwen/qwen3-max"). */
  models: string[];
  /** Codex CLI models offered in the model picker when provider === "codex". */
  codexModels: string[];
  /** Service tier: "flex" (~50% discount on some models, e.g. OpenAI), "priority" or not stated (let AI provider use default). */
  serviceTier?: string;
}

/** What is stored in the UI before pressing the Send button. File content is read lazily. */
export type DraftAttachment =
  | { type: "file"; path: string }
  | { type: "selection"; path: string; range: { startLine: number; endLine: number }; content: string };

/** Fully resolved file with content. Formed at the moment of Send for history and LLM. */
export interface ResolvedAttachment {
  path: string;
  range?: { startLine: number; endLine: number };
  content: string;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD cost, if the provider reported it. */
  cost?: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
  provider?: ProviderKind;
}

export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** A chat message sent to the model. */
export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A turn as displayed in the panel (no file bodies). */
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

// ---- Global State Model (Single Source of Truth) ----

export interface TurnId {
  /** Unique ID for granular DOM patching without re-rendering the entire list */
  id: string;
}

export interface UserTurn extends TurnId {
  role: "user";
  /** Plain text of the user's request (without attachments) for display in the UI */
  prompt: string;
  /** Full text sent to the LLM (including attachment contents) */
  rawText: string;
  attachments: ResolvedAttachment[];
}

export type ContentBlock =
  | { type: "text"; content: string }
  | { type: "op"; op: DiffOp; opIndex: number };

export interface AssistantTurn extends TurnId {
  role: "assistant";
  /** Raw text that is populated during streaming */
  rawText: string;
  /** Raw reasoning text */
  reasoning: string;
  status: "waiting" | "streaming" | "done" | "error";
  usage?: UsageInfo;
  /** Typed response blocks (text interspersed with code suggestions). Formed by the parser. */
  blocks?: ContentBlock[];
  /** Result of applying suggestions to the file system. */
  report?: ApplyReport;
}

export interface SystemTurn extends TurnId {
  role: "system";
  text: string;
  status: "info" | "error";
}

export type Turn = UserTurn | AssistantTurn | SystemTurn;

export interface GlobalState {
  sessionId: string;
  chatTitle?: string;
  turns: Turn[];
  totalCost: number;
  totalTokens: number;
  availableModels: string[];
  selectedModel: string;
  selectedEffort: EffortLevel;
  /** Whether the model is currently generating a response */
  isStreaming: boolean;
  updatedAt: number;
}

// ---- Intents (Webview -> Host) ----

export type WebviewIntent =
  | { type: "intent:ready" }
  | { type: "intent:send"; text: string; model: string; effort: EffortLevel; attachments: DraftAttachment[] }
  | { type: "intent:cancel" }
  | { type: "intent:requestSuggestions"; query: string }
  | { type: "intent:attachPath"; path: string }
  | { type: "intent:openConfig" }
  | { type: "intent:newChat" }
  | { type: "intent:showHistory" }
  | { type: "intent:selectModel"; model: string }
  | { type: "intent:selectEffort"; effort: EffortLevel };

// ---- Host Messages (Host -> Webview) ----

export type HostMessage =
  | { type: "state:update"; state: GlobalState }
  | { type: "ui:suggestions"; query: string; items: string[] }
  | { type: "ui:addDraftAttachments"; attachments: DraftAttachment[] };

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
