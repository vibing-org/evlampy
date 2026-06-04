/**
 * Keeps the scroll at the bottom when content is added,
 * unless the user has scrolled up manually.
 */
export class AutoScroller {
  private AUTO_SCROLL_BOTTOM_THRESHOLD = 24;
  private messagesEl = document.getElementById("messages")!;
  private followOutput = true;
  private ignoreScrollTracking = false;
  private scrollReleaseFrame: number | undefined;

  constructor() {
    // Track manual scroll: if the user scrolled up, disable auto-scroll (followOutput = false).
    // ignoreScrollTracking prevents programmatic scroll from triggering this handler and messing up the state.
    this.messagesEl.addEventListener("scroll", () => {
      if (this.ignoreScrollTracking) {
        return;
      }
      this.followOutput = this.isNearBottom();
    });

    // Scrolling up with the mouse wheel is an explicit user intent to stop auto-scroll, even if we are still near the bottom.
    this.messagesEl.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY < 0) {
          this.followOutput = false;
        }
      },
      { passive: true }
    );
  }

  /** Returns true if the scroll position is within the threshold from the very bottom. */
  private isNearBottom(): boolean {
    return (
      this.messagesEl.scrollHeight - (this.messagesEl.scrollTop + this.messagesEl.clientHeight) <=
      this.AUTO_SCROLL_BOTTOM_THRESHOLD
    );
  }

  /**
   * Scrolls to the bottom only if followOutput === true OR force === true is passed.
   * Uses requestAnimationFrame to work around browser bugs with asynchronous DOM rendering.
   */
  public scrollToBottom(force = false) {
    if (!force && !this.followOutput) {
      return;
    }

    this.ignoreScrollTracking = true;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    if (this.scrollReleaseFrame !== undefined) {
      cancelAnimationFrame(this.scrollReleaseFrame);
    }

    this.scrollReleaseFrame = window.requestAnimationFrame(() => {
      this.scrollReleaseFrame = undefined;
      if (force || this.followOutput) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
      this.ignoreScrollTracking = false;
      this.followOutput = this.isNearBottom();
    });
  }
}
