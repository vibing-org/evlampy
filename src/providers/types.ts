import { ChatMsg, EffortLevel, EvlampyConfig, UsageInfo } from "../types";

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

export interface LlmProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
