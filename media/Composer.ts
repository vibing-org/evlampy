import { DraftAttachment, GlobalState, EffortLevel } from "./types";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
export const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Manages local UI state (input, selected attachments).
 * Sends intents to the backend when the user performs an action.
 */
export class Composer {
  private inputEl = $<HTMLTextAreaElement>("input"); // input field
  private attachmentsEl = $("attachments"); // currently attached files
  private suggestionsEl = $("suggestions"); // suggestion list for @ input
  private composerEl = $("composer"); // bottom panel: input, model, effort, send, cost
  private modelEl = $<HTMLSelectElement>("model"); // model selector
  private effortEl = $<HTMLSelectElement>("effort"); // effort selector
  private costEl = $("cost"); // total chat cost
  private sendBtn = $<HTMLButtonElement>("send"); // button for sending a request to the LLM

  private localAttachments: DraftAttachment[] = []; // list of attached draft files
  private suggestionItems: string[] = []; // list of suggestions matching the current @query
  private suggestionIndex = 0; // selected suggestion, added to the chat on Enter
  private mentionStart = -1; // position right after the active @ in the text field (stored to remove "@query" after picking a suggestion)
  private mentionTimer?: ReturnType<typeof setTimeout>; // debounce timer for suggestions (to avoid sending a request after every typed character)
  private isStreaming = false; // whether the model is currently responding

  private INPUT_MAX_HEIGHT_RATIO = 0.25; // input field grows no more than x0.25 of the screen height

  constructor(private onSendCallback: () => void) {
    this.sendBtn.onclick = () => this.sendOrCancel();

    // Intercept Enter for sending
    this.inputEl.addEventListener("keydown", (e) => {
      if (this.suggestionsVisible() && this.handleSuggestionKey(e)) {
        return; // skip if suggestions are open (then Enter picks a suggestion)
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendOrCancel();
      }
    });

    this.inputEl.addEventListener("input", () => this.onInputForMention());
    window.addEventListener("resize", () => this.updateInputHeight());

    // Hack for the select: show full model names when open, shortened when closed.
    this.modelEl.addEventListener("mousedown", () => {
      Array.from(this.modelEl.options).forEach(o => o.textContent = o.value);
    });
    this.modelEl.addEventListener("blur", () => this.updateModelDisplay());
    this.modelEl.addEventListener("change", () => {
      this.updateModelDisplay();
      vscode.postMessage({ type: "intent:selectModel", model: this.modelEl.value });
    });

    this.effortEl.addEventListener("change", () => {
      vscode.postMessage({ type: "intent:selectEffort", effort: this.effortEl.value as EffortLevel });
    });
  }

  /**
   * Synchronizes the local UI (buttons, selects, cost) with the global state.
   * Does not mutate the state, only reads it.
   */
  public syncState(state: GlobalState): void {
    this.isStreaming = state.isStreaming;
    
    // Toggle Send / Stop button state
    if (this.isStreaming) {
      this.sendBtn.classList.add("streaming");
      this.sendBtn.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1"></rect></svg>`;
      this.sendBtn.title = "Stop generation";
    } else {
      this.sendBtn.classList.remove("streaming");
      this.sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
      this.sendBtn.title = "Send (Enter)";
    }

    // Update the list of available models
    const currentModels = Array.from(this.modelEl.options).map(o => o.value).join(",");
    const newModels = state.availableModels.join(",");
    
    if (currentModels !== newModels) {
      this.modelEl.innerHTML = "";
      if (state.availableModels.length === 0) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "No models";
        o.disabled = true;
        this.modelEl.appendChild(o);
      } else {
        state.availableModels.forEach((mod) => {
          const o = document.createElement("option");
          o.value = mod;
          o.textContent = mod;
          this.modelEl.appendChild(o);
        });
      }
    }

    // Update the selected model
    if (state.selectedModel && this.modelEl.value !== state.selectedModel) {
      this.modelEl.value = state.selectedModel;
    }
    this.updateModelDisplay();

    // Update the selected effort
    if (state.selectedEffort && this.effortEl.value !== state.selectedEffort) {
      this.effortEl.value = state.selectedEffort;
    }

    this.renderCost(state.totalCost, state.totalTokens);
  }

  /** Adds a batch of attachments, filtering out duplicates. */
  public addDraftAttachments(attachments: DraftAttachment[]): void {
    let added = false;
    for (const att of attachments) {
      if (!this.localAttachments.some((a) => this.sameAttachment(a, att))) {
        this.localAttachments.push(att);
        added = true;
      }
    }
    if (added) this.renderAttachments();
    this.inputEl.focus();
  }

  /** Displays suggestions and positions them above the input field. */
  public showSuggestions(query: string, items: string[]) {
    this.suggestionItems = items;
    this.suggestionIndex = 0;
    if (items.length === 0) {
      this.hideSuggestions();
      return;
    }
    this.suggestionsEl.innerHTML = "";
    // Show compact paths, but keep the real suggestion value for picking.
    const displayItems = this.truncateSharedPathPrefix(items);
    items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "sugg" + (i === 0 ? " active" : "");
      row.textContent = displayItems[i];
      row.title = displayItems[i];
      row.onclick = () => this.pickSuggestion(i);
      this.suggestionsEl.appendChild(row);
    });
    this.layoutSuggestions();
    this.suggestionsEl.classList.remove("hidden");
  }

  /**
   * Sends an intent to the backend and clears the local input state.
   * If streaming is in progress, the button acts as Cancel.
   */
  private sendOrCancel() {
    if (this.isStreaming) {
      vscode.postMessage({ type: "intent:cancel" });
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;

    vscode.postMessage({
      type: "intent:send",
      text,
      model: this.modelEl.value,
      effort: this.effortEl.value as EffortLevel,
      attachments: [...this.localAttachments]
    });

    this.inputEl.value = "";
    this.updateInputHeight();
    this.localAttachments = [];
    this.renderAttachments();
    this.onSendCallback();
  }

  /** Shortens long model paths to the last segment for UI compactness. */
  private updateModelDisplay() {
    Array.from(this.modelEl.options).forEach(o => {
      o.textContent = o.selected ? (o.value.split("/").pop() || o.value) : o.value;
    });
  }

  /** Dynamically changes the textarea height, but no more than INPUT_MAX_HEIGHT_RATIO of the window height. */
  private updateInputHeight() {
    const maxHeight = Math.max(96, Math.floor(window.innerHeight * this.INPUT_MAX_HEIGHT_RATIO));
    this.inputEl.style.height = "auto";
    const nextHeight = Math.min(this.inputEl.scrollHeight, maxHeight);
    this.inputEl.style.height = `${nextHeight}px`;
    this.inputEl.style.overflowY = this.inputEl.scrollHeight > maxHeight ? "auto" : "hidden";

    if (this.suggestionsVisible()) {
      this.layoutSuggestions();
    }
  }

  /**
   * Renders attachment chips.
   * On removal, mutates the local array and re-renders.
   */
  private renderAttachments() {
    this.attachmentsEl.innerHTML = "";
    // Chips display compact paths while keeping the real attachment paths unchanged.
    const displayPaths = this.truncateSharedPathPrefix(this.localAttachments.map((a) => a.path));
    this.localAttachments.forEach((a, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = a.type === "selection"
        ? `${displayPaths[i]}:${a.range.startLine}-${a.range.endLine}`
        : displayPaths[i];
      chip.title = chip.textContent;
      const x = document.createElement("button");
      x.className = "chipx";
      x.textContent = "×"; // button to remove an attachment from the list
      x.onclick = () => {
        this.localAttachments.splice(i, 1);
        this.renderAttachments();
        this.inputEl.focus();
      };
      chip.appendChild(x);
      this.attachmentsEl.appendChild(chip);
    });

    // Add a button to clear all attachments
    if (this.localAttachments.length > 0) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "chip chip-clear";
      clearBtn.title = "Clear all attachments";
      clearBtn.textContent = "Clear all";
      clearBtn.onclick = () => {
        this.localAttachments = [];
        this.renderAttachments();
        this.inputEl.focus();
      };
      this.attachmentsEl.appendChild(clearBtn);
    }

    if (this.suggestionsVisible()) {
      this.layoutSuggestions();
    }
  }

  /** Formats and displays the total cost and tokens. */
  private renderCost(totalCost: number, totalTokens: number) {
    if (totalCost > 0 || totalTokens > 0) {
      this.costEl.textContent = `Total: ${this.fmtTokens(totalTokens)} tok · ${this.fmtCost(totalCost)}`;
      this.costEl.title = `Total tokens: ${totalTokens}`;
    } else {
      this.costEl.textContent = "";
      this.costEl.title = "";
    }
  }

  private fmtTokens(t: any): string {
    if (typeof t !== "number" || isNaN(t)) return "0";
    if (t < 1000) return t.toString();
    return (t / 1000).toFixed(1) + "k";
  }

  private fmtCost(c?: number): string {
    if (c === undefined) return "$—";
    return "$" + c.toFixed(c < 0.01 ? 5 : 4);
  }

  /** Parses the text up to the cursor, looks for the `@...` pattern and requests suggestions from the backend (with debounce). */
  private onInputForMention() {
    this.updateInputHeight();

    if (this.mentionTimer) clearTimeout(this.mentionTimer);
    this.mentionTimer = setTimeout(() => {
      const pos = this.inputEl.selectionStart ?? 0; // cursor position
      const upto = this.inputEl.value.slice(0, pos); // all text up to the cursor
      const m = /(^|\s)@([^\s@]*)$/.exec(upto); // find the last @ in it
      if (!m) {
        this.hideSuggestions();
        return;
      }
      // m[2] is the "query" in the string "... @query"
      this.mentionStart = pos - m[2].length; // position right after '@'
      vscode.postMessage({ type: "intent:requestSuggestions", query: m[2] });
    }, 100);
  }

  /** Hides the suggestion picker popup. */
  private hideSuggestions() {
    this.suggestionsEl.classList.add("hidden");
    this.suggestionItems = [];
  }

  /** Positions the suggestion popup strictly above the cursor/input field, without going off-screen. */
  private layoutSuggestions() {
    const inputRect = this.inputEl.getBoundingClientRect();
    const composerRect = this.composerEl.getBoundingClientRect();
    const bottomGap = Math.max(8, window.innerHeight - composerRect.top + 6);
    const maxHeight = Math.max(120, Math.min(320, composerRect.top - 16));

    this.suggestionsEl.style.position = "fixed";
    this.suggestionsEl.style.left = `${Math.round(inputRect.left)}px`;
    this.suggestionsEl.style.right = `${Math.max(8, Math.round(window.innerWidth - inputRect.right))}px`;
    this.suggestionsEl.style.bottom = `${Math.round(bottomGap)}px`;
    this.suggestionsEl.style.maxHeight = `${Math.round(maxHeight)}px`;
    this.suggestionsEl.style.zIndex = "1000";
    this.suggestionsEl.style.overflowY = "auto";
  }

  private suggestionsVisible(): boolean {
    return !this.suggestionsEl.classList.contains("hidden");
  }

  /**
   * Intercepts arrow keys and Enter for navigating suggestions.
   * Returns true if the event was handled.
   */
  private handleSuggestionKey(e: KeyboardEvent): boolean {
    if (e.key === "ArrowDown") {
      this.suggestionIndex = (this.suggestionIndex + 1) % this.suggestionItems.length;
      this.refreshActive();
      e.preventDefault();
      return true;
    }
    if (e.key === "ArrowUp") {
      this.suggestionIndex =
        (this.suggestionIndex - 1 + this.suggestionItems.length) % this.suggestionItems.length;
      this.refreshActive();
      e.preventDefault();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      this.pickSuggestion(this.suggestionIndex);
      e.preventDefault();
      return true;
    }
    if (e.key === "Escape") {
      this.hideSuggestions();
      e.preventDefault();
      return true;
    }
    return false;
  }

  /** Highlights the current suggestion as active (the one the selector is on). */
  private refreshActive() {
    Array.from(this.suggestionsEl.children).forEach((c, i) =>
      c.classList.toggle("active", i === this.suggestionIndex)
    );
  }

  /** Replaces `@...` with the selected path, restores focus and sends an attach intent. */
  private pickSuggestion(i: number) {
    const pick = this.suggestionItems[i];
    if (!pick || this.mentionStart < 0) {
      this.hideSuggestions();
      return;
    }
    
    // Cut out "@query" from the input field after picking a suggestion
    const pos = this.inputEl.selectionStart ?? 0;
    const before = this.inputEl.value.slice(0, Math.max(0, this.mentionStart - 1));
    const after = this.inputEl.value.slice(pos);
    this.inputEl.value = before + after;

    this.updateInputHeight();
    
    // Place the caret before the removed "@"
    const caret = before.length;
    this.inputEl.setSelectionRange(caret, caret);
    
    this.hideSuggestions();
    this.inputEl.focus();

    vscode.postMessage({ type: "intent:attachPath", path: pick });
  }

  /** Returns true if the attachments are identical. */
  private sameAttachment(a: DraftAttachment, b: DraftAttachment): boolean {
    if (a.type !== b.type || a.path !== b.path) return false;
    if (a.type === "selection" && b.type === "selection") {
      return a.range.startLine === b.range.startLine && a.range.endLine === b.range.endLine;
    }
    return true;
  }

  private truncateSharedPathPrefix(paths: string[]): string[] {
    // Shorten only the middle of the shared directory prefix; keep its edges readable.
    const splitPaths = paths.map((path) => path.split("/"));
    const prefixLength = this.sharedPrefixLength(splitPaths);

    return splitPaths.map((parts) => parts.map((part, i) => {
      return i > 0 && i < prefixLength - 1 ? part.slice(0, 1) : part;
    }).join("/"));
  }

  private sharedPrefixLength(splitPaths: string[][]): number {
    if (splitPaths.length < 2) return 0;
    const minLength = Math.min(...splitPaths.map((parts) => Math.max(0, parts.length - 1)));
    let length = 0;
    while (length < minLength && splitPaths.every((parts) => parts[length] === splitPaths[0][length])) {
      length++;
    }
    return length;
  }
}
