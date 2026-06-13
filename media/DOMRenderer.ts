import { GlobalState, Turn, UserTurn, AssistantTurn, SystemTurn, ApplyReport, ApplyFailure, UsageInfo } from "./types";
import { marked } from "marked";
import hljs from "highlight.js";

export class DOMRenderer {

  private messagesEl = document.getElementById("messages")!;
  private welcomeEl = document.getElementById("welcome")!;
  // Tracks the last rendered text length per host, so streaming updates can be O(delta) instead of O(n).
  private streamLengths = new WeakMap<HTMLElement, number>();

  constructor() {
    marked.setOptions({ gfm: true, breaks: true });
  }

  /**
   * Pure State -> DOM rendering function. Uses key-based reconciliation by turn.id
   * to avoid recreating DOM nodes and disrupting text selection during streaming.
   */
  public render(state: GlobalState): void {
    if (state.turns.length === 0) {
      this.showWelcome();
    } else {
      this.hideWelcome();
    }

    const existingNodes = new Map<string, HTMLElement>();
    Array.from(this.messagesEl.children).forEach(child => {
      const id = (child as HTMLElement).dataset.id;
      if (id) existingNodes.set(id, child as HTMLElement);
    });

    for (const turn of state.turns) {
      let el = existingNodes.get(turn.id);
      if (!el) {
        el = this.createTurnNode(turn);
        this.messagesEl.appendChild(el);
      } else {
        this.updateTurnNode(el, turn);
        existingNodes.delete(turn.id);
      }
    }

    // Remove nodes that are no longer in the state
    for (const el of existingNodes.values()) {
      el.remove();
    }
  }

  private showWelcome() {
    if (this.welcomeEl) {
      this.welcomeEl.classList.remove("hidden");
      this.messagesEl.style.display = "none";
    }
  }

  private hideWelcome() {
    if (this.welcomeEl && !this.welcomeEl.classList.contains("hidden")) {
      this.welcomeEl.classList.add("hidden");
      this.messagesEl.style.display = "";
    }
  }

  /** Creates the basic message skeleton (avatar, header, container) once. */
  private createTurnNode(turn: Turn): HTMLElement {
    const row = document.createElement("div");
    row.dataset.id = turn.id;
    row.className = `msg-row ${turn.role}`;

    if (turn.role !== "system") {
      const header = document.createElement("div");
      header.className = "msg-header";
      const title = document.createElement("div");
      title.className = "msg-header-title";
      title.textContent = turn.role === "user" ? "You" : "Evlampy";
      header.appendChild(title);

      if (turn.role === "assistant") {
        const usageHost = document.createElement("div");
        usageHost.className = "msg-usage";
        header.appendChild(usageHost);
      }

      const actionsHost = document.createElement("div");
      actionsHost.className = "msg-actions";
      if (turn.role === "user") {
        actionsHost.appendChild(this.createActionButton("Edit message", this.editIcon(), () => this.dispatchTurnAction("turn:edit", turn.id)));
      } else {
        actionsHost.appendChild(this.createActionButton("Retry response", this.retryIcon(), () => this.dispatchTurnAction("turn:retry", turn.id)));
      }
      header.appendChild(actionsHost);

      row.appendChild(header);
    }

    const el = document.createElement("div");
    el.className = `msg ${turn.role}`;
    row.appendChild(el);

    this.updateTurnNode(row, turn);
    return row;
  }

  /** Updates the content of an existing node. Delegates logic to specific renderers. */
  private updateTurnNode(row: HTMLElement, turn: Turn): void {
    const el = row.querySelector(`.msg.${turn.role}`) as HTMLElement;

    if (turn.role === "user") {
      this.renderUserTurn(el, turn);
    } else if (turn.role === "assistant") {
      const header = row.querySelector(".msg-header") as HTMLElement;
      const usageHost = header.querySelector(".msg-usage") as HTMLElement;
      const retryButton = header.querySelector(".msg-action") as HTMLButtonElement;
      retryButton.hidden = turn.status !== "done" && turn.status !== "error";
      this.renderAssistantTurn(el, usageHost, turn);
    } else if (turn.role === "system") {
      this.renderSystemTurn(el, turn);
    }
  }

  /** Builds a header icon button for a turn-level action. */
  private createActionButton(title: string, icon: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "msg-action";
    button.type = "button";
    button.title = title;
    button.innerHTML = icon;
    button.onclick = onClick;
    return button;
  }

  /** Emits a DOM event that main.ts turns into a backend intent. */
  private dispatchTurnAction(type: "turn:edit" | "turn:retry", turnId: string): void {
    window.dispatchEvent(new CustomEvent(type, { detail: { turnId } }));
  }

  /** Pencil icon for editing a previous user message. */
  private editIcon(): string {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
  }

  /** Refresh icon for retrying a completed or failed assistant response. */
  private retryIcon(): string {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`;
  }

  /** Renders the user's text as Markdown, and attachments as collapsed <details> blocks. */
  private renderUserTurn(el: HTMLElement, turn: UserTurn) {
    let html = "";

    if (turn.attachments && turn.attachments.length > 0) {
      const attachmentsHtml = turn.attachments.map(att => {
        const label = att.range ? `${att.path}:${att.range.startLine}-${att.range.endLine}` : att.path;
        return this.renderSuggestionBlock("read", label, att.content, -1, true);
      }).join("");

      // Add margin-bottom for visual spacing between attachments and user text
      html += `<div class="md user-attachments">${attachmentsHtml}</div>`;
    }

    html += this.renderMarkdownBlock(turn.prompt);

    this.setInnerHtmlIfChanged(el, html);
    this.applyHighlighting(el);
  }

  /** Renders the assistant's response, separating reasoning, the main answer, and the diff apply report. */
  private renderAssistantTurn(el: HTMLElement, usageHost: HTMLElement, turn: AssistantTurn) {
    if (turn.usage) {
      usageHost.textContent = this.formatUsage(turn.usage);
    } else {
      usageHost.textContent = "";
    }

    let reasoningHost = el.querySelector(".assistant-reasoning-container") as HTMLElement;
    let answerHost = el.querySelector(".assistant-answer-container") as HTMLElement;
    let reportHost = el.querySelector(".assistant-report-container") as HTMLElement;

    if (!reasoningHost) {
      reasoningHost = document.createElement("div");
      reasoningHost.className = "assistant-reasoning-container";
      el.appendChild(reasoningHost);
    }
    if (!answerHost) {
      answerHost = document.createElement("div");
      answerHost.className = "assistant-answer-container";
      el.appendChild(answerHost);
    }
    if (!reportHost) {
      reportHost = document.createElement("div");
      reportHost.className = "assistant-report-container";
      el.appendChild(reportHost);
    }

    const isStreaming = turn.status === "waiting" || turn.status === "streaming";
    const final = turn.status === "done" || turn.status === "error";

    if (isStreaming) {
      // Fast path: plain-text updates only. No marked.parse, no innerHTML churn, no syntax highlighting.
      // The full render (with markdown + highlighting) runs once when streaming ends.
      this.streamReasoning(reasoningHost, turn.reasoning);
      this.streamAnswer(answerHost, turn);
    } else {
      this.renderAssistantReasoning(reasoningHost, turn.reasoning, final);

      const answerHtml = this.renderAssistantAnswer(turn, final);
      this.setInnerHtmlIfChanged(answerHost, answerHtml);

      if (turn.report) {
        this.annotateAssistantReport(turn.report, answerHost);
        this.setInnerHtmlIfChanged(reportHost, this.renderApplyReportHtml(turn.report));
      } else {
        this.setInnerHtmlIfChanged(reportHost, "");
      }

      this.applyHighlighting(answerHost);
      this.applyHighlighting(reportHost);
    }
  }

  /** Streaming-mode reasoning: a small backend-truncated <pre>, replaced as a whole. */
  private streamReasoning(host: HTMLElement, reasoning: string): void {
    if (!reasoning) {
      if (host.childElementCount > 0) host.replaceChildren();
      return;
    }

    let pre = host.querySelector("pre.assistant-stream-reasoning") as HTMLPreElement;
    if (!pre) {
      host.replaceChildren();
      const details = document.createElement("details");
      details.className = "assistant-reasoning";
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = "Thinking";
      const body = document.createElement("div");
      body.className = "assistant-reasoning-body";
      pre = document.createElement("pre");
      pre.className = "assistant-stream-reasoning";
      body.appendChild(pre);
      details.appendChild(summary);
      details.appendChild(body);
      host.appendChild(details);
      pre.textContent = reasoning;
      return;
    }

    if (pre.textContent !== reasoning) {
      pre.textContent = reasoning;
    }
  }

  /** Streaming-mode answer: a single <div> that we extend with textNode appends (O(delta) per update). */
  private streamAnswer(host: HTMLElement, turn: AssistantTurn): void {
    const text = turn.rawText;
    if (!text) {
      this.renderPendingAnswer(host);
      this.streamLengths.delete(host);
      return;
    }

    let div = host.querySelector("div.assistant-stream-answer") as HTMLElement;
    if (!div) {
      host.replaceChildren();
      div = document.createElement("div");
      div.className = "assistant-stream-answer";
      host.appendChild(div);
      div.textContent = text;
      this.streamLengths.set(host, text.length);
      return;
    }

    const lastLength = this.streamLengths.get(host) || 0;
    if (text.length > lastLength) {
      div.appendChild(document.createTextNode(text.slice(lastLength)));
      this.streamLengths.set(host, text.length);
    } else if (text.length < lastLength) {
      div.textContent = text;
      this.streamLengths.set(host, text.length);
    }
  }

  private renderPendingAnswer(host: HTMLElement): void {
    if (host.querySelector(".assistant-pending")) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "assistant-pending";

    const spinner = document.createElement("span");
    spinner.className = "assistant-pending-spinner";
    spinner.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.textContent = "Evlampy is thinking...";

    wrapper.appendChild(spinner);
    wrapper.appendChild(label);
    host.replaceChildren(wrapper);
  }

  /** Renders system notifications. */
  private renderSystemTurn(el: HTMLElement, turn: SystemTurn) {
    const title = turn.status === "error" ? "Error" : "Info";
    const html = `
      <div class="notice ${turn.status}">
        <div class="notice-title">${this.escapeHtml(title)}</div>
        <div class="notice-text">${this.escapeHtml(turn.text)}</div>
      </div>
    `;
    this.setInnerHtmlIfChanged(el, html);
  }

  /** Renders the Thinking block. Preserves the open/closed state across re-renders. */
  private renderAssistantReasoning(host: HTMLElement, reasoning: string, isFinal: boolean) {
    const trimmed = reasoning.trim();
    if (!trimmed) {
      if (host.childElementCount > 0) {
        host.replaceChildren();
      }
      return;
    }

    const { details, body, created } = this.ensureReasoningElements(host);

    if (created) {
      details.open = !isFinal;
    }

    // Force-close the block once when generation is complete.
    // The finalClosed flag allows the user to manually open the block after completion,
    // and prevents subsequent re-renders (e.g. when streaming new messages) from closing it again.
    if (isFinal && details.dataset.finalClosed !== "true") {
      details.open = false;
      details.dataset.finalClosed = "true";
    }

    this.setInnerHtmlIfChanged(body, `<pre class="assistant-stream-reasoning">${this.escapeHtml(reasoning)}</pre>`);
  }

  private ensureReasoningElements(host: HTMLElement): { details: HTMLDetailsElement; body: HTMLElement; created: boolean } {
    const existingDetails = host.querySelector<HTMLDetailsElement>(".assistant-reasoning");
    if (existingDetails) {
      let existingBody = existingDetails.querySelector<HTMLElement>(".assistant-reasoning-body");
      if (!existingBody) {
        existingBody = document.createElement("div");
        existingBody.className = "assistant-reasoning-body";
        existingDetails.appendChild(existingBody);
      }
      return { details: existingDetails, body: existingBody, created: false };
    }

    const details = document.createElement("details");
    details.className = "assistant-reasoning";

    const summary = document.createElement("summary");
    summary.textContent = "Thinking";

    const body = document.createElement("div");
    body.className = "assistant-reasoning-body";

    details.appendChild(summary);
    details.appendChild(body);

    host.replaceChildren(details);

    return { details, body, created: true };
  }

  /**
   * Renders the assistant's answer. If the backend sent typed blocks, uses them.
   * Otherwise falls back to rendering raw text.
   */
  private renderAssistantAnswer(turn: AssistantTurn, final: boolean): string {
    let html = "";
    if (turn.blocks && turn.blocks.length > 0) {
      const parts = turn.blocks.map(b => {
        if (b.type === "text") {
          return this.renderMarkdownFragment(b.content);
        } else {
          let body = "";
          if (b.op.kind === "new" || b.op.kind === "rewrite") {
            body = (b.op as any).content || "";
          } else if (b.op.kind === "edit") {
            body = (b.op as any).hunks?.map((h: any) => `<<<<<<< SEARCH\n${h.search}\n=======\n${h.replace}\n>>>>>>> REPLACE`).join("\n") || "";
          }
          return this.renderSuggestionBlock(b.op.kind, b.op.path, body, b.opIndex, final);
        }
      });
      html = parts.length > 0 ? `<div class="md">${parts.join("")}</div>` : "";
    } else {
      const md = this.renderMarkdownFragment(turn.rawText);
      html = md ? `<div class="md">${md}</div>` : "";
    }

    if (html) {
      return `<div class="assistant-answer">${html}</div>`;
    }
    if (turn.status === "error") {
      return `<div class="assistant-placeholder error">Request failed before any assistant output.</div>`;
    }
    if (final) {
      return `<div class="assistant-placeholder">Completed with no assistant text.</div>`;
    }
    return "";
  }

  /** Renders a report about diff application issues (if there are failed/partial). */
  private renderApplyReportHtml(report: ApplyReport): string {
    const issues = report.items.filter(
      (it) => !it.ok || it.partial || (it.failures?.length ?? 0) > 0
    );
    if (issues.length === 0) {
      return "";
    }

    return `
      <div class="notice warning" style="margin-top: 12px;">
        <div class="notice-title">Manual review needed</div>
        <div class="notice-text">${issues.length} change block(s) were not fully applied.</div>
        ${issues.map((it) => `
          <section class="report-item">
            <div class="report-path">${this.escapeHtml(it.path)}</div>
            <div class="report-detail">${this.escapeHtml(it.detail)}</div>
            ${this.renderFailureList(it.failures ?? [])}
          </section>
        `).join("")}
      </div>
    `;
  }

  /** Adds failed/partial CSS classes to suggestion blocks based on the report. */
  private annotateAssistantReport(report: ApplyReport, el: HTMLElement) {
    report.items.forEach((item) => {
      const block = el.querySelector<HTMLElement>(`.suggestion[data-op-index="${item.opIndex}"]`);
      if (!block) {
        return;
      }

      block.classList.remove("failed", "partial");
      if (!item.ok) {
        block.classList.add("failed");
      } else if (item.partial || (item.failures?.length ?? 0) > 0) {
        block.classList.add("partial");
      }
      block.title = item.detail;
    });
  }

  private renderFailureList(failures: ApplyFailure[]): string {
    if (failures.length === 0) {
      return "";
    }

    return failures
      .map((failure) => {
        const detail =
          failure.hunkIndex !== undefined
            ? `Hunk ${failure.hunkIndex + 1}: ${failure.detail}`
            : failure.detail;
        const raw = this.buildFailureText(failure);

        return `
          <div class="failure-item">
            <div class="failure-detail">${this.escapeHtml(detail)}</div>
            ${raw ? `<div class="failed-suggestion">${marked.parse(this.buildFencedMarkdown(raw, "diff")) as string}</div>` : ""}
          </div>
        `;
      })
      .join("");
  }

  private buildFailureText(failure: ApplyFailure): string {
    if (failure.search === undefined && failure.replace === undefined) {
      return "";
    }
    return `<<<<<<< SEARCH\n${failure.search ?? ""}\n=======\n${failure.replace ?? ""}\n>>>>>>> REPLACE`;
  }

  /** Updates the DOM only if the HTML has actually changed, to avoid disrupting text selection. */
  private setInnerHtmlIfChanged(el: HTMLElement, html: string) {
    if (el.innerHTML !== html) {
      el.innerHTML = html;
    }
  }

  /** Applies highlight.js only to new code blocks (checks data-highlighted). */
  private applyHighlighting(root: HTMLElement) {
    root.querySelectorAll("pre code").forEach((block) => {
      const el = block as HTMLElement;
      if (el.dataset.highlighted === "yes") {
        return;
      }
      hljs.highlightElement(el);
    });
  }

  private renderMarkdownBlock(text: string): string {
    const html = this.renderMarkdownFragment(text);
    return html ? `<div class="md">${html}</div>` : "";
  }

  private renderMarkdownFragment(text: string): string {
    const normalized = this.trimOuterBlankLines(text);
    if (!normalized.trim()) {
      return "";
    }
    // Escape diff markers so that the ">" character does not break the layout during streaming
    const escaped = normalized
      .replace(/^<<<<<<< SEARCH/gm, "&lt;&lt;&lt;&lt;&lt;&lt;&lt; SEARCH")
      .replace(/^=======/gm, "=======")
      .replace(/^>>>>>>> REPLACE/gm, "&gt;&gt;&gt;&gt;&gt;&gt;&gt; REPLACE");

    return marked.parse(escaped) as string;
  }

  private renderSuggestionBlock(
    kind: "edit" | "new" | "rewrite" | "delete" | "read",
    path: string,
    body: string,
    opIndex: number,
    collapseSuggestions: boolean
  ): string {
    const content = this.renderSuggestionBody(kind, path, body);
    const badge = `<span class="suggestion-badge ${kind}">${kind}</span>`;
    const summaryHtml = `<span class="suggestion-filepath">${this.escapeHtml(path)}</span>${badge}`;

    if (collapseSuggestions) {
      return `<details class="suggestion ${kind}" data-op-index="${opIndex}"><summary>${summaryHtml}</summary><div class="suggestion-body">${content}</div></details>`;
    }

    return `<div class="suggestion ${kind}" data-op-index="${opIndex}"><div class="suggestion-summary">${summaryHtml}</div><div class="suggestion-body">${content}</div></div>`;
  }

  private renderSuggestionBody(
    kind: "edit" | "new" | "rewrite" | "delete" | "read",
    path: string,
    body: string
  ): string {
    if (kind === "delete") {
      return `<div class="suggestion-delete">(delete file)</div>`;
    }
    return this.renderCodeBlock(body, this.getLanguageFromPath(path));
  }

  private renderCodeBlock(text: string, lang: string = ""): string {
    const content = this.trimOuterBlankLines(text);
    return marked.parse(this.buildFencedMarkdown(content, lang)) as string;
  }

  private buildFencedMarkdown(text: string, lang: string = ""): string {
    const fence = "`".repeat(Math.max(3, this.longestBacktickRun(text) + 1));
    return `${fence}${lang}\n${text}\n${fence}`;
  }

  private getLanguageFromPath(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      "js": "javascript", "jsx": "javascript",
      "ts": "typescript", "tsx": "typescript",
      "py": "python",
      "java": "java",
      "c": "c", "cpp": "cpp", "cc": "cpp", "h": "c", "hpp": "cpp",
      "cs": "csharp",
      "go": "go",
      "rs": "rust",
      "rb": "ruby",
      "php": "php",
      "html": "html",
      "css": "css",
      "json": "json",
      "xml": "xml",
      "yaml": "yaml", "yml": "yaml",
      "md": "markdown",
      "sh": "bash", "bash": "bash",
      "kt": "kotlin", "kts": "kotlin",
      "scala": "scala",
      "swift": "swift",
      "sql": "sql"
    };
    return map[ext] || "";
  }

  private longestBacktickRun(text: string): number {
    let best = 0;
    let run = 0;
    for (const ch of text) {
      if (ch === "`") {
        run++;
        if (run > best) {
          best = run;
        }
      } else {
        run = 0;
      }
    }
    return best;
  }

  private trimOuterBlankLines(text: string): string {
    return text.replace(/^\n+|\n+$/g, "");
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  }

  private formatUsage(usage: UsageInfo | undefined): string {
    if (!usage) return "";

    let toks = "";
    const pt = usage.promptTokens;
    const ct = usage.completionTokens;
    const tt = usage.totalTokens;

    if (typeof pt === "number" && typeof ct === "number") {
      toks = `↑${this.fmtTokens(pt)} ↓${this.fmtTokens(ct)}`;
    } else if (typeof tt === "number") {
      toks = `${this.fmtTokens(tt)} tok`;
    }

    if (!toks) return "";

    if (typeof usage.cost === "number") {
      return `${toks} · ${this.fmtCost(usage.cost)}`;
    }
    return toks;
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
}
