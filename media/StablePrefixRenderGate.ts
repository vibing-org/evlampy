import { GlobalState, Turn } from "./types";

export interface StablePrefixRenderPass {
  sessionChanged: boolean;
  forceRenderFromIndex: number;
}

/** Decides which existing turn DOM nodes are safe to keep without re-rendering. */
export class StablePrefixRenderGate {
  private sessionId = "";

  /** Starts a render pass and returns the stable-prefix boundary for the current state. */
  public begin(state: Pick<GlobalState, "sessionId" | "turns">): StablePrefixRenderPass {
    const sessionChanged = this.sessionId !== state.sessionId;
    if (sessionChanged) {
      this.sessionId = state.sessionId;
    }

    return {
      sessionChanged,
      forceRenderFromIndex: this.findLastInteractiveTurnIndex(state.turns),
    };
  }

  /** Existing nodes before the mutable tail can be reused as-is. */
  public shouldRenderExisting(pass: StablePrefixRenderPass, turnIndex: number): boolean {
    if (pass.sessionChanged) {
      return true;
    }
    return turnIndex >= pass.forceRenderFromIndex;
  }

  /** Finds the last user/assistant turn; system-only states are small and render fully. */
  private findLastInteractiveTurnIndex(turns: Turn[]): number {
    for (let i = turns.length - 1; i >= 0; i--) {
      const role = turns[i].role;
      if (role === "user" || role === "assistant") {
        return i;
      }
    }
    return 0;
  }
}
