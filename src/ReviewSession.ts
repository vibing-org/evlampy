import { ReviewFile, ReviewState, ReviewStatus } from "./types";

/**
 * Owns the review flow state. VS Code diff tabs are only a projection of this
 * state, so accept/reject commands never depend on the active editor timing.
 */
export class ReviewSession {
  private state: ReviewState = { phase: "idle", files: [] };

  /** Start a new review batch and select the first pending file. */
  start(files: ReviewFile[]): ReviewState {
    this.state = {
      phase: files.some((f) => f.status === "pending") ? "reviewing" : "done",
      files: files.map((f) => ({ ...f })),
    };
    this.state.currentRel = this.nextPendingRel();
    return this.snapshot();
  }

  /** Return to the empty state before applying a new batch. */
  reset(): ReviewState {
    this.state = { phase: "idle", files: [] };
    return this.snapshot();
  }

  /** Return a defensive copy so callers cannot mutate the session. */
  snapshot(): ReviewState {
    return {
      phase: this.state.phase,
      currentRel: this.state.currentRel,
      files: this.state.files.map((f) => ({ ...f })),
    };
  }

  isActive(): boolean {
    return this.state.phase === "reviewing" && !!this.state.currentRel;
  }

  currentRel(): string | undefined {
    return this.state.currentRel;
  }

  /** Make another pending file current, e.g. when the user reopens it. */
  setCurrent(rel: string): ReviewState {
    const item = this.state.files.find((f) => f.path === rel && f.status === "pending");
    if (item) {
      this.state.phase = "reviewing";
      this.state.currentRel = item.path;
    }
    return this.snapshot();
  }

  /** Mark one file and advance to the next pending file, if any. */
  decide(rel: string, status: Exclude<ReviewStatus, "pending">): ReviewState {
    const item = this.state.files.find((f) => f.path === rel && f.status === "pending");
    if (!item) {
      return this.snapshot();
    }

    item.status = status;
    this.state.currentRel = this.nextPendingRel();
    this.state.phase = this.state.currentRel ? "reviewing" : "done";
    return this.snapshot();
  }

  /** Mark all remaining files and finish the review. */
  decideAll(status: Exclude<ReviewStatus, "pending">): ReviewState {
    for (const item of this.state.files) {
      if (item.status === "pending") {
        item.status = status;
      }
    }
    this.state.phase = "done";
    this.state.currentRel = undefined;
    return this.snapshot();
  }

  private nextPendingRel(): string | undefined {
    return this.state.files.find((f) => f.status === "pending")?.path;
  }
}
