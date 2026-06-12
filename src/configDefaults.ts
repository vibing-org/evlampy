import { EvlampyConfig, ProviderKind } from "./types";

export const DEFAULT_PROVIDER: ProviderKind = "openai-compatible";
export const DEFAULT_CODEX_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];

export function normalizeProvider(value: unknown): ProviderKind {
  return value === "codex" ? "codex" : DEFAULT_PROVIDER;
}

export function activeModels(config: Pick<EvlampyConfig, "provider" | "models" | "codexModels">): string[] {
  return config.provider === "codex" ? config.codexModels : config.models;
}
