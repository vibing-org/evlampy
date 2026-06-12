import { EvlampyConfig } from "../types";
import { codexCliProvider } from "./codexCli";
import { openaiCompatibleProvider } from "./openaiCompatible";
import { LlmProvider } from "./types";

export function getProvider(config: EvlampyConfig): LlmProvider {
  return config.provider === "codex" ? codexCliProvider : openaiCompatibleProvider;
}
