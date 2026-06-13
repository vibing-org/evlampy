import { ProviderKind } from "./types";

export class TokenTimer {
  private timer?: NodeJS.Timeout;

  constructor(
    private timeoutAbort: AbortController,
    private provider: ProviderKind
  ) { }

  reset() {
    this.clear();
    const timeoutSeconds = this.provider === "codex" ? 600 : 90; // 10 mins for codex cuz it can't stream the answer
    this.timer = setTimeout(() => {
      this.timeoutAbort.abort(`LLM response timed out (no tokens received for ${timeoutSeconds} seconds).`);
    }, timeoutSeconds * 1000);
  }

  clear() {
    clearTimeout(this.timer);
  }
}
