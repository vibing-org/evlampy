import { marked } from "marked";
import hljs from "highlight.js";

// ---- Types mirrored from src/types.ts (kept local to avoid bundling vscode) ----
interface Attachment {
  path: string;
  range?: { startLine: number; endLine: number };
  content: string;
}
interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
}
type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";
interface ApplyFailure {
  hunkIndex?: number;
  detail: string;
  search?: string;
  replace?: string;
}
interface ApplyResultItem {
  path: string;
  ok: boolean;
  detail: string;
  kind: "edit" | "new" | "rewrite" | "delete";
  opIndex: number;
  partial?: boolean;
  failures?: ApplyFailure[];
}
interface ApplyReport {
  items: ApplyResultItem[];
  appliedCount: number;
  failedCount: number;
}

interface DisplayTurn {
  role: "user" | "assistant" | "system" | "error";
  text: string;
  report?: ApplyReport;
}

type ToWebview =
  | { type: "init"; models: string[]; defaultModel: string }
  | { type: "addAttachment"; attachment: Attachment }
  | { type: "userMessage"; text: string }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantReasoningDelta"; text: string }
  | { type: "assistantDone"; usage?: UsageInfo }
  | { type: "fileSuggestions"; query: string; items: string[] }
  | { type: "applyReport"; report: ApplyReport }
  | { type: "clearChat" }
  | {
    type: "loadChat";
    turns: DisplayTurn[];
    totalCost: number;
    totalTokens: number;
  }
  | { type: "status"; text: string }
  | { type: "error"; message: string };

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(s: any): void;
};

const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const messagesEl = $("messages");
const attachmentsEl = $("attachments");
const suggestionsEl = $("suggestions");
const composerEl = $("composer");
const inputEl = $<HTMLTextAreaElement>("input");
const modelEl = $<HTMLSelectElement>("model");
const effortEl = $<HTMLSelectElement>("effort");
const costEl = $("cost");
const sendBtn = $<HTMLButtonElement>("send");

const INPUT_MAX_HEIGHT_RATIO = 0.25;

type AssistantStatus = "waiting" | "streaming" | "done" | "error";

interface AssistantView {
  el: HTMLElement;
  raw: string;
  reasoning: string;
  status: AssistantStatus;
  report?: ApplyReport;
}

let attachments: Attachment[] = [];
let streaming = false;
let currentAssistant: AssistantView | null = null;
let totalCost = 0;
let totalTokens = 0;
let availableModels: string[] = [];
let selectedModel = "";
let selectedEffort: EffortLevel = "none";
let transcript: DisplayTurn[] = [];
let lastAssistantEl: HTMLElement | null = null;

marked.setOptions({ gfm: true, breaks: true });

// ---- Persisted webview state (survives reload / hide) ----

interface SavedState {
  availableModels: string[];
  selectedModel: string;
  selectedEffort: EffortLevel;
  transcript: DisplayTurn[];
  totalCost: number;
  totalTokens: number;
}

function saveState() {
  vscode.setState({
    availableModels,
    selectedModel,
    selectedEffort,
    transcript,
    totalCost,
    totalTokens,
  } satisfies SavedState);
}

function restoreState() {
  const s = vscode.getState() as SavedState | undefined;
  if (!s) {
    return;
  }
  availableModels = s.availableModels ?? [];
  selectedModel = s.selectedModel ?? "";
  selectedEffort = s.selectedEffort ?? "none";
  transcript = s.transcript ?? [];
  totalCost = s.totalCost ?? 0;
  totalTokens = s.totalTokens ?? 0;
  populateModels();
  populateEfforts();
  transcript.forEach(renderTurn);
  renderCost();
}

function populateModels() {
  modelEl.innerHTML = "";
  availableModels.forEach((mod) => {
    const o = document.createElement("option");
    o.value = mod;
    o.textContent = mod;
    modelEl.appendChild(o);
  });

  if (availableModels.length === 0) {
    selectedModel = "";
    modelEl.disabled = true;
    return;
  }

  modelEl.disabled = false;
  if (!selectedModel || !availableModels.includes(selectedModel)) {
    selectedModel = availableModels[0];
  }
  modelEl.value = selectedModel;
}

function populateEfforts() {
  const efforts: EffortLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];
  effortEl.innerHTML = "";
  efforts.forEach((effort) => {
    const o = document.createElement("option");
    o.value = effort;
    o.textContent = `effort: ${effort}`;
    effortEl.appendChild(o);
  });
  effortEl.value = selectedEffort;
}

modelEl.addEventListener("change", () => {
  selectedModel = modelEl.value;
  saveState();
});

effortEl.addEventListener("change", () => {
  selectedEffort = effortEl.value as EffortLevel;
  saveState();
});

// ---- Rendering ----

function renderTurn(t: DisplayTurn) {
  if (t.role === "user") {
    addMessage("user", t.text);
  } else if (t.role === "assistant") {
    const view = createAssistantView();
    view.raw = t.text;
    view.status = "done";
    view.report = t.report;
    renderAssistantState(view, true);
    if (view.report) {
      annotateAssistantReport(view.report, view.el);
      renderApplyReport(view.report);
    }
    lastAssistantEl = view.el;
  } else if (t.role === "system") {
    addNotice("status", "Info", t.text);
  } else if (t.role === "error") {
    addNotice("error", "Error", t.text);
  }
}

function addMessage(role: "user" | "assistant" | "system", text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = `msg-row ${role}`;

  if (role !== "system") {
    const header = document.createElement("div");
    header.className = "msg-header";
    header.textContent = role === "user" ? "You" : "Evlampy";
    row.appendChild(header);
  }

  const el = document.createElement("div");
  el.className = `msg ${role}`;
  renderMessage(el, role, text);
  row.appendChild(el);

  messagesEl.appendChild(row);
  scrollToBottom();
  return el;
}

function createAssistantView(): AssistantView {
  const row = document.createElement("div");
  row.className = "msg-row assistant";

  const header = document.createElement("div");
  header.className = "msg-header";
  header.textContent = "Evlampy";
  row.appendChild(header);

  const el = document.createElement("div");
  el.className = "msg assistant";
  row.appendChild(el);

  messagesEl.appendChild(row);

  const view: AssistantView = {
    el,
    raw: "",
    reasoning: "",
    status: "waiting",
  };

  renderAssistantState(view, false);
  scrollToBottom();
  return view;
}

function renderMessage(
  el: HTMLElement,
  role: "user" | "assistant" | "system",
  text: string
) {
  if (role === "assistant") {
    const html = renderRichMessage(text, { collapseSuggestions: true });
    el.innerHTML =
      html || `<div class="assistant-placeholder">Completed with no assistant text.</div>`;
    applyHighlighting(el);
    return;
  }

  let content = text;
  if (role === "user") {
    // Delete "---"
    content = content.replace(/(<\/evlampy:read>)\s*---\s*/g, "$1\n\n");
  }

  el.innerHTML = renderRichMessage(content, { collapseSuggestions: true });
  applyHighlighting(el);
}


function renderAssistantState(view: AssistantView, final: boolean) {
  view.el.innerHTML = `${renderReasoningBlock(view)}${renderAssistantAnswer(
    view.raw,
    final,
    view.status
  )}`;
  applyHighlighting(view.el);
}

function renderReasoningBlock(view: AssistantView): string {
  const reasoning = view.reasoning.trim();
  if (!reasoning) {
    return "";
  }

  return `<details class="assistant-reasoning"><summary>Thinking</summary><div class="assistant-reasoning-body">${renderMarkdownBlock(
    view.reasoning
  )}</div></details>`;
}

function renderAssistantAnswer(
  raw: string,
  final: boolean,
  status: AssistantStatus
): string {
  const html = renderRichMessage(raw, { collapseSuggestions: final });
  if (html) {
    return `<div class="assistant-answer">${html}</div>`;
  }
  if (status === "error") {
    return `<div class="assistant-placeholder error">Request failed before any assistant output.</div>`;
  }
  return "";
}

function applyHighlighting(root: HTMLElement) {
  root.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block as HTMLElement);
  });
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateInputHeight() {
  const maxHeight = Math.max(96, Math.floor(window.innerHeight * INPUT_MAX_HEIGHT_RATIO));
  inputEl.style.height = "auto";
  const nextHeight = Math.min(inputEl.scrollHeight, maxHeight);
  inputEl.style.height = `${nextHeight}px`;
  inputEl.style.overflowY = inputEl.scrollHeight > maxHeight ? "auto" : "hidden";

  if (suggestionsVisible()) {
    layoutSuggestions();
  }
}

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  attachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const label = a.range
      ? `${a.path}:${a.range.startLine}-${a.range.endLine}`
      : a.path;
    chip.title = label;
    chip.textContent = label;
    const x = document.createElement("button");
    x.className = "chipx";
    x.textContent = "×";
    x.onclick = () => {
      attachments.splice(i, 1);
      vscode.postMessage({ type: "removeAttachment", index: i });
      renderAttachments();
      inputEl.focus();
    };
    chip.appendChild(x);
    attachmentsEl.appendChild(chip);
  });

  if (attachments.length > 0) {
    const clearBtn = document.createElement("button");
    clearBtn.className = "chip chip-clear";
    clearBtn.title = "Clear all attachments";
    clearBtn.textContent = "Clear all";
    clearBtn.onclick = () => {
      attachments = [];
      vscode.postMessage({ type: "clearAttachments" });
      renderAttachments();
      inputEl.focus();
    };
    attachmentsEl.appendChild(clearBtn);
  }

  if (suggestionsVisible()) {
    layoutSuggestions();
  }
}

function renderCost(lastUsage?: UsageInfo) {
  const last = lastUsage
    ? `last: ${fmtCost(lastUsage.cost)} · ${lastUsage.totalTokens} tok`
    : "";
  const total = `total: ${fmtCost(totalCost)} · ${totalTokens} tok`;
  costEl.textContent = lastUsage ? `${last}  |  ${total}` : total;
}

function fmtCost(c?: number): string {
  if (c === undefined) return "$—";
  return "$" + c.toFixed(c < 0.01 ? 5 : 4);
}

// ---- Sending ----

function send() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;
  vscode.postMessage({
    type: "send",
    text,
    attachments,
    model: modelEl.value,
    effort: selectedEffort,
  });
  inputEl.value = "";
  updateInputHeight();
  attachments = [];
  renderAttachments();
}

sendBtn.onclick = send;

inputEl.addEventListener("keydown", (e) => {
  if (suggestionsVisible() && handleSuggestionKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

inputEl.addEventListener("input", onInputForMention);
window.addEventListener("resize", () => {
  updateInputHeight();
});

// ---- @ mention autocomplete ----

let suggestionItems: string[] = [];
let suggestionIndex = 0;
let mentionStart = -1;

function onInputForMention() {
  updateInputHeight();

  const pos = inputEl.selectionStart ?? 0;
  const upto = inputEl.value.slice(0, pos);
  const m = /(^|\s)@([^\s@]*)$/.exec(upto);
  if (!m) {
    hideSuggestions();
    return;
  }
  mentionStart = pos - m[2].length;
  vscode.postMessage({ type: "requestFileSuggestions", query: m[2] });
}

function showSuggestions(items: string[]) {
  suggestionItems = items;
  suggestionIndex = 0;
  if (items.length === 0) {
    hideSuggestions();
    return;
  }
  suggestionsEl.innerHTML = "";
  items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "sugg" + (i === 0 ? " active" : "");
    row.textContent = it;
    row.onclick = () => pickSuggestion(i);
    suggestionsEl.appendChild(row);
  });
  layoutSuggestions();
  suggestionsEl.classList.remove("hidden");
}

function hideSuggestions() {
  suggestionsEl.classList.add("hidden");
  suggestionItems = [];
}

function layoutSuggestions() {
  const inputRect = inputEl.getBoundingClientRect();
  const composerRect = composerEl.getBoundingClientRect();
  const bottomGap = Math.max(8, window.innerHeight - composerRect.top + 6);
  const maxHeight = Math.max(120, Math.min(320, composerRect.top - 16));

  suggestionsEl.style.position = "fixed";
  suggestionsEl.style.left = `${Math.round(inputRect.left)}px`;
  suggestionsEl.style.right = `${Math.max(8, Math.round(window.innerWidth - inputRect.right))}px`;
  suggestionsEl.style.bottom = `${Math.round(bottomGap)}px`;
  suggestionsEl.style.maxHeight = `${Math.round(maxHeight)}px`;
  suggestionsEl.style.zIndex = "1000";
  suggestionsEl.style.overflowY = "auto";
}

function suggestionsVisible(): boolean {
  return !suggestionsEl.classList.contains("hidden");
}

function handleSuggestionKey(e: KeyboardEvent): boolean {
  if (e.key === "ArrowDown") {
    suggestionIndex = (suggestionIndex + 1) % suggestionItems.length;
    refreshActive();
    e.preventDefault();
    return true;
  }
  if (e.key === "ArrowUp") {
    suggestionIndex =
      (suggestionIndex - 1 + suggestionItems.length) % suggestionItems.length;
    refreshActive();
    e.preventDefault();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    pickSuggestion(suggestionIndex);
    e.preventDefault();
    return true;
  }
  if (e.key === "Escape") {
    hideSuggestions();
    e.preventDefault();
    return true;
  }
  return false;
}

function refreshActive() {
  Array.from(suggestionsEl.children).forEach((c, i) =>
    c.classList.toggle("active", i === suggestionIndex)
  );
}

function pickSuggestion(i: number) {
  const pick = suggestionItems[i];
  if (!pick || mentionStart < 0) {
    hideSuggestions();
    return;
  }
  const pos = inputEl.selectionStart ?? 0;
  const before = inputEl.value.slice(0, Math.max(0, mentionStart - 1));
  const after = inputEl.value.slice(pos);
  inputEl.value = before + after;
  updateInputHeight();
  const caret = before.length;
  inputEl.setSelectionRange(caret, caret);
  hideSuggestions();
  inputEl.focus();
  vscode.postMessage({ type: "attachByPath", path: pick });
}

// ---- Inbound messages ----

window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case "init": {
      availableModels = m.models;
      if (availableModels.length > 0) {
        if (!selectedModel || !availableModels.includes(selectedModel)) {
          selectedModel = m.defaultModel || availableModels[0];
        }
      } else {
        selectedModel = "";
      }
      populateModels();
      populateEfforts();
      saveState();
      renderCost();
      break;
    }
    case "addAttachment":
      if (!attachments.some((a) => sameAttachment(a, m.attachment))) {
        attachments.push(m.attachment);
        renderAttachments();
      }
      inputEl.focus();
      break;
    case "userMessage": {
      const turn: DisplayTurn = { role: "user", text: m.text };
      renderTurn(turn);
      transcript.push(turn);
      saveState();
      break;
    }
    case "assistantStart":
      streaming = true;
      sendBtn.disabled = true;
      currentAssistant = createAssistantView();
      break;
    case "assistantReasoningDelta":
      if (currentAssistant) {
        currentAssistant.reasoning += m.text;
        if (currentAssistant.status === "waiting") {
          currentAssistant.status = "streaming";
        }
        renderAssistantState(currentAssistant, false);
        if (currentAssistant.report) {
          annotateAssistantReport(currentAssistant.report, currentAssistant.el);
        }
        scrollToBottom();
      }
      break;
    case "assistantDelta":
      if (currentAssistant) {
        currentAssistant.raw += m.text;
        currentAssistant.status = "streaming";
        renderAssistantState(currentAssistant, false);
        if (currentAssistant.report) {
          annotateAssistantReport(currentAssistant.report, currentAssistant.el);
        }
        scrollToBottom();
      }
      break;
    case "assistantDone":
      streaming = false;
      sendBtn.disabled = false;
      if (currentAssistant) {
        if (currentAssistant.status !== "error") {
          currentAssistant.status = "done";
        }
        renderAssistantState(currentAssistant, true);
        if (currentAssistant.report) {
          annotateAssistantReport(currentAssistant.report, currentAssistant.el);
        }
        if (currentAssistant.raw.trim()) {
          transcript.push({ 
            role: "assistant", 
            text: currentAssistant.raw,
            report: currentAssistant.report 
          });
        }
        lastAssistantEl = currentAssistant.el;
      }
      currentAssistant = null;
      if (m.usage) {
        totalTokens += m.usage.totalTokens;
        if (m.usage.cost) totalCost += m.usage.cost;
      }
      renderCost(m.usage);
      saveState();
      break;
    case "fileSuggestions":
      showSuggestions(m.items);
      break;
    case "applyReport":
      if (currentAssistant) {
        currentAssistant.report = m.report;
        annotateAssistantReport(m.report, currentAssistant.el);
      } else {
        annotateAssistantReport(m.report, lastAssistantEl);
      }
      renderApplyReport(m.report);
      break;
    case "clearChat":
      resetChat();
      break;
    case "loadChat":
      resetChat();
      transcript = m.turns.map((t) => ({ ...t }));
      transcript.forEach(renderTurn);
      totalCost = m.totalCost;
      totalTokens = m.totalTokens;
      renderCost();
      saveState();
      break;
    case "status": {
      const turn: DisplayTurn = { role: "system", text: m.text };
      renderTurn(turn);
      transcript.push(turn);
      saveState();
      break;
    }
    case "error": {
      const turn: DisplayTurn = { role: "error", text: m.message };
      renderTurn(turn);
      transcript.push(turn);
      streaming = false;
      sendBtn.disabled = false;
      if (currentAssistant) {
        currentAssistant.status = "error";
        renderAssistantState(currentAssistant, true);
        if (currentAssistant.report) {
          annotateAssistantReport(currentAssistant.report, currentAssistant.el);
        }
      }
      saveState();
      break;
    }
  }
});

function renderApplyReport(report: ApplyReport) {
  const issues = report.items.filter(
    (it) => !it.ok || it.partial || (it.failures?.length ?? 0) > 0
  );
  if (issues.length === 0) {
    return;
  }

  const row = document.createElement("div");
  row.className = "msg-row system";

  const el = document.createElement("div");
  el.className = "msg system";
  el.innerHTML = `
    <div class="notice warning">
      <div class="notice-title">Manual review needed</div>
      <div class="notice-text">${issues.length} change block(s) were not fully applied.</div>
      ${issues
      .map(
        (it) => `
            <section class="report-item">
              <div class="report-path">${escapeHtml(it.path)}</div>
              <div class="report-detail">${escapeHtml(it.detail)}</div>
              ${renderFailureList(it.failures ?? [])}
            </section>
          `
      )
      .join("")}
    </div>
  `;
  row.appendChild(el);
  messagesEl.appendChild(row);
  applyHighlighting(el);
  scrollToBottom();
}

/** Wipe the visible chat (keeps the model list/selection). */
function resetChat() {
  messagesEl.innerHTML = "";
  attachments = [];
  lastAssistantEl = null;
  renderAttachments();
  transcript = [];
  totalCost = 0;
  totalTokens = 0;
  currentAssistant = null;
  streaming = false;
  sendBtn.disabled = false;
  hideSuggestions();
  renderCost();
  saveState();
}

function renderRichMessage(
  text: string,
  options: { collapseSuggestions: boolean }
): string {
  const parts: string[] = [];
  let cursor = 0;
  let opIndex = 0;

  while (cursor < text.length) {
    const block = findNextEvlampyBlock(text, cursor);
    if (!block) {
      pushRenderedMarkdown(parts, text.slice(cursor));
      break;
    }

    pushRenderedMarkdown(parts, text.slice(cursor, block.start));
    parts.push(
      block.kind === "read"
        ? renderReadBlock(block.path, block.attrs, block.body)
        : renderSuggestionBlock(
          block.kind,
          block.path,
          block.body,
          opIndex++,
          options.collapseSuggestions
        )
    );
    cursor = block.end;
  }

  return parts.length > 0 ? `<div class="md">${parts.join("")}</div>` : "";
}

function pushRenderedMarkdown(parts: string[], text: string): void {
  const html = renderMarkdownFragment(text);
  if (html) {
    parts.push(html);
  }
}

function findNextEvlampyBlock(text: string, from: number) {
  const openRegex =
    /<evlampy:(read|edit|new|rewrite|delete)\s+path="([^"]+)"([^>]*)>/g;
  openRegex.lastIndex = from;
  const open = openRegex.exec(text);
  if (!open) {
    return null;
  }

  const kind = open[1] as "read" | "edit" | "new" | "rewrite" | "delete";
  const attrs = open[3];
  const bodyStart = open.index + open[0].length;
  const close = findEvlampyBlockClose(text, bodyStart, kind);
  if (!close) {
    return null;
  }

  return {
    start: open.index,
    end: close.end,
    kind,
    path: open[2],
    attrs,
    body: text.slice(bodyStart, close.start),
  };
}

function findEvlampyBlockClose(
  text: string,
  from: number,
  kind: "read" | "edit" | "new" | "rewrite" | "delete"
): { start: number; end: number } | null {
  const closeRegex = new RegExp(
    `(^|\\n)[ \\t]*<\\/evlampy:${kind}>[ \\t]*(?=\\n|$)`,
    "g"
  );
  closeRegex.lastIndex = from;
  const match = closeRegex.exec(text);
  if (!match) {
    return null;
  }

  const prefixLen = match[1]?.length ?? 0;
  return {
    start: match.index + prefixLen,
    end: match.index + match[0].length,
  };
}

function renderReadBlock(path: string, attrs: string, body: string): string {
  const start = /start-line="(\d+)"/.exec(attrs)?.[1];
  const end = /end-line="(\d+)"/.exec(attrs)?.[1];
  const label = start && end ? `${path}:${start}-${end}` : path;

  return `<details class="suggestion"><summary>${escapeHtml(
    label
  )}</summary><div class="suggestion-body">${renderCodeBlock(body, getLanguageFromPath(path))}</div></details>`;
}

function renderMarkdownBlock(text: string): string {
  const html = renderMarkdownFragment(text);
  return html ? `<div class="md">${html}</div>` : "";
}

function renderMarkdownFragment(text: string): string {
  const normalized = trimOuterBlankLines(text);
  if (!normalized.trim()) {
    return "";
  }
  return marked.parse(normalized) as string;
}

function renderSuggestionBlock(
  kind: "edit" | "new" | "rewrite" | "delete",
  path: string,
  body: string,
  opIndex: number,
  collapseSuggestions: boolean
): string {
  const content = renderSuggestionBody(kind, path, body);
  if (collapseSuggestions) {
    return `<details class="suggestion" data-op-index="${opIndex}"><summary>${escapeHtml(
      path
    )}</summary><div class="suggestion-body">${content}</div></details>`;
  }

  return `<div class="suggestion" data-op-index="${opIndex}"><div class="suggestion-summary">${escapeHtml(
    path
  )}</div><div class="suggestion-body">${content}</div></div>`;
}

function renderSuggestionBody(
  kind: "edit" | "new" | "rewrite" | "delete",
  path: string,
  body: string
): string {
  if (kind === "delete") {
    return `<div class="suggestion-delete">(delete file)</div>`;
  }

  return renderCodeBlock(body, getLanguageFromPath(path));
}

function renderCodeBlock(text: string, lang: string = ""): string {
  const content = trimOuterBlankLines(text);
  return marked.parse(buildFencedMarkdown(content, lang)) as string;
}

function annotateAssistantReport(report: ApplyReport, el: HTMLElement | null) {
  if (!el) {
    return;
  }

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

function renderFailureList(failures: ApplyFailure[]): string {
  if (failures.length === 0) {
    return "";
  }

  return failures
    .map((failure) => {
      const detail =
        failure.hunkIndex !== undefined
          ? `Hunk ${failure.hunkIndex + 1}: ${failure.detail}`
          : failure.detail;
      const raw = buildFailureText(failure);

      return `
        <div class="failure-item">
          <div class="failure-detail">${escapeHtml(detail)}</div>
          ${raw
          ? `<div class="failed-suggestion">${marked.parse(buildFencedMarkdown(raw, "diff")) as string}</div>`
          : ""}
        </div>
      `;
    })
    .join("");
}

function addNotice(kind: "status" | "error", title: string, text: string) {
  const row = document.createElement("div");
  row.className = "msg-row system";

  const el = document.createElement("div");
  el.className = "msg system";
  el.innerHTML = `
    <div class="notice ${kind}">
      <div class="notice-title">${escapeHtml(title)}</div>
      <div class="notice-text">${escapeHtml(text)}</div>
    </div>
  `;
  row.appendChild(el);
  messagesEl.appendChild(row);
  scrollToBottom();
}

function buildFailureText(failure: ApplyFailure): string {
  if (failure.search === undefined && failure.replace === undefined) {
    return "";
  }
  return `<<<<<<< SEARCH
${failure.search ?? ""}
=======
${failure.replace ?? ""}
>>>>>>> REPLACE`;
}

function buildFencedMarkdown(text: string, lang: string = ""): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${lang}
${text}
${fence}`;
}

function getLanguageFromPath(path: string): string {
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

function longestBacktickRun(text: string): number {
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

function trimOuterBlankLines(text: string): string {
  return text.replace(/^\n+|\n+$/g, "");
}

function sameAttachment(a: Attachment, b: Attachment): boolean {
  return (
    a.path === b.path &&
    a.range?.startLine === b.range?.startLine &&
    a.range?.endLine === b.range?.endLine
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

// Restore any persisted view state, then ask the extension for fresh config.
populateEfforts();
restoreState();
updateInputHeight();
vscode.postMessage({ type: "ready", transcript, totalCost, totalTokens });
