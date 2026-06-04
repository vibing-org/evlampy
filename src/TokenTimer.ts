export class TokenTimer {
  private timer?: NodeJS.Timeout;
  private timeoutSeconds = 90;

  constructor(private timeoutAbort: AbortController) { }

  reset() {
    this.clear();
    this.timer = setTimeout(() => {
      this.timeoutAbort.abort(`LLM response timed out (no tokens received for ${this.timeoutSeconds} seconds).`);
    }, this.timeoutSeconds * 1000);
  }

  clear() {
    clearTimeout(this.timer);
  }
}
