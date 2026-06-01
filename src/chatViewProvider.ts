import * as crypto from "crypto";
import * as vscode from "vscode";
import * as path from "path";
import { DiffManager } from "./applier";
import { chat } from "./openrouter";
import {
  configFilePath,
  loadConfig,
  loadUserSystemPrompt,
  ConfigError,
} from "./config";
import { buildSystemMessage, buildUserMessage } from "./prompt";
import { parseDiffOps } from "./parser";
import {
  Attachment,
  ChatMsg,
  ChatSession,
  DisplayTurn,
  EffortLevel,
  FromWebview,
  ToWebview,
} from "./types";

const HISTORY_KEY = "evlampy.history";
const HISTORY_LIMIT = 5;
const SEARCH_EXCLUDE_DIRS = [
  ".*",
  "node_modules",
  "dist",
  "out",
  "build",
  "target",
  "bin",
  "obj",
  "coverage",
  "pycache",
  "venv",
  "env",
  "vendor",
  "cdk.out",
];
const MAX_ATTACH_FILES_PER_FOLDER = 100;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "evlampy.chatView";
  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private configWatcher?: vscode.FileSystemWatcher;
  private configRefreshTimer?: ReturnType<typeof setTimeout>;

  // Current conversation (source of truth for what's sent to the model).
  private turns: DisplayTurn[] = [];
  private sessionId = newId();
  private totalCost = 0;
  private totalTokens = 0;
  private pendingAttachments: Attachment[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diffs: DiffManager
  ) {
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("evlampy.configPath")) {
          this.resetConfigWatcher();
        }
        this.scheduleConfigRefresh();
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.isConfigFile(doc.uri)) {
          this.scheduleConfigRefresh();
        }
      }),
      {
        dispose: () => {
          this.configWatcher?.dispose();
          if (this.configRefreshTimer) {
            clearTimeout(this.configRefreshTimer);
          }
        },
      }
    );
    this.resetConfigWatcher();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
  }

  /** Reveal the chat and push an attachment chip (from the Cmd+I command). */
  async addAttachment(attachment: Attachment): Promise<void> {
    await vscode.commands.executeCommand("evlampy.chatView.focus");
    // Give the view a tick to resolve if it was hidden.
    await new Promise((r) => setTimeout(r, 50));
    this.queueAttachment(attachment);
  }

  private post(msg: ToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private async pushError(message: string): Promise<void> {
    this.post({ type: "error", message });
    this.turns.push({ role: "error", text: message });
    await this.saveSession();
  }

  private async pushStatus(text: string): Promise<void> {
    this.post({ type: "status", text });
    this.turns.push({ role: "system", text });
    await this.saveSession();
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "ready":
        if (m.transcript && m.transcript.length > 0 && this.turns.length === 0) {
          this.turns = m.transcript.map((t) => ({ ...t }));
          this.totalCost = m.totalCost ?? 0;
          this.totalTokens = m.totalTokens ?? 0;
        }
        return this.sendInit();
      case "send":
        return this.runChat(m.text, m.attachments, m.model, m.effort);
      case "requestFileSuggestions":
        return this.sendFileSuggestions(m.query);
      case "attachByPath":
        return this.attachPaths([m.path]);
      case "attachPaths":
        return this.attachPaths(m.paths);
      case "openConfig":
        return void vscode.commands.executeCommand("workbench.action.openSettings", "evlampy");
      case "removeAttachment":
        if (m.index >= 0 && m.index < this.pendingAttachments.length) {
          this.pendingAttachments.splice(m.index, 1);
        }
        return;
      case "clearAttachments":
        this.pendingAttachments = [];
        return;
    }
  }

  private async sendInit(): Promise<void> {
    try {
      const cfg = await loadConfig();
      this.post({
        type: "init",
        models: cfg.models,
        defaultModel: cfg.defaultModel ?? cfg.models[0],
      });
    } catch (e) {
      // Still init with empty models; surface the config problem.
      this.post({ type: "init", models: [], defaultModel: "" });
      this.post({ type: "error", message: (e as Error).message });
    }
  }

  private async runChat(
    text: string,
    attachments: Attachment[],
    model: string,
    effort: EffortLevel
  ): Promise<void> {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      const msg =
        e instanceof ConfigError
          ? e.message
          : `Failed to load config: ${(e as Error).message}`;
      await this.pushError(msg);
      this.post({ type: "assistantDone" });
      return;
    }

    if (!cfg.apiKey) {
      await this.pushError("API key is missing. Please set 'evlampy.apiKey' in VS Code Settings or in your local config.");
      this.post({ type: "assistantDone" });
      return;
    }

    const userSystem = await loadUserSystemPrompt(cfg);
    const system = buildSystemMessage(userSystem);

    const userText = buildUserMessage(text, attachments);

    this.pendingAttachments = [];
    this.turns.push({
      role: "user",
      text: userText,
    });
    this.post({ type: "userMessage", text: userText });

    const messages: ChatMsg[] = [
      { role: "system", content: system },
      ...this.turns
        .filter((t) => t.role === "user" || t.role === "assistant")
        .map((t) => ({
          role: t.role as "user" | "assistant",
          content: t.text,
        })),
    ];

    this.abort = new AbortController();
    this.post({ type: "assistantStart" });

    let full;
    let usage;
    try {
      const res = await chat({
        config: cfg,
        model: model || cfg.defaultModel || cfg.models[0],
        effort,
        messages,
        signal: this.abort.signal,
        onDelta: (d) => {
          this.post({ type: "assistantDelta", text: d });
        },
        onReasoningDelta: (d) => {
          this.post({ type: "assistantReasoningDelta", text: d });
        },
      });
      usage = res.usage;
      full = res.text;
    } catch (e) {
      // Roll back the user turn so a failed request doesn't poison the context.
      this.turns.pop();
      await this.pushError(`Request failed: ${(e as Error).message}`);
      this.post({ type: "assistantDone" });
      return;
    }

    try {
      this.turns.push({ role: "assistant", text: full });
      if (usage) {
        this.totalTokens += usage.totalTokens;
        if (usage.cost) {
          this.totalCost += usage.cost;
        }
      }
      await this.saveSession();

      // Parse + apply diffs from the completed message.
      const ops = parseDiffOps(full);
      if (ops.length > 0) {
        const report = await this.diffs.apply(ops);
        this.turns[this.turns.length - 1].report = report;
        await this.saveSession();
        this.post({ type: "applyReport", report });
      }
    } catch (e) {
      await this.pushError(`Post-processing failed: ${(e as Error).message}`);
    } finally {
      this.abort = undefined;
      this.post({ type: "assistantDone", usage });
    }
  }

  // ---- New chat + history ----

  async newChat(): Promise<void> {
    await this.saveSession();
    this.turns = [];
    this.sessionId = newId();
    this.totalCost = 0;
    this.totalTokens = 0;
    this.pendingAttachments = [];
    await vscode.commands.executeCommand("evlampy.chatView.focus");
    this.post({ type: "clearChat" });
  }

  async showHistory(): Promise<void> {
    const sessions = this.loadHistory();
    if (sessions.length === 0) {
      vscode.window.showInformationMessage("Evlampy: no chat history yet.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.title || "(untitled)",
        description: `${s.turns.filter((t) => t.role === "user").length} msg · ${fmtCost(s.totalCost)}`,
        detail: new Date(s.updatedAt).toLocaleString(),
        session: s,
      })),
      { placeHolder: "Restore a chat" }
    );
    if (pick) {
      await this.restore(pick.session);
    }
  }

  private async restore(s: ChatSession): Promise<void> {
    await this.saveSession(); // don't lose the current one
    this.turns = s.turns.map((t) => ({ ...t }));
    this.sessionId = s.id;
    this.totalCost = s.totalCost;
    this.totalTokens = s.totalTokens;
    await vscode.commands.executeCommand("evlampy.chatView.focus");
    this.post({
      type: "loadChat",
      turns: this.turns,
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
    });
  }

  private loadHistory(): ChatSession[] {
    return this.context.workspaceState.get<ChatSession[]>(HISTORY_KEY, []);
  }

  /** Upsert the current session into history (most-recent first, capped). */
  private async saveSession(): Promise<void> {
    if (this.turns.length === 0) {
      return;
    }
    const firstUser = this.turns.find((t) => t.role === "user");
    const session: ChatSession = {
      id: this.sessionId,
      title: summarizeUserTextForHistory(firstUser?.text ?? "Chat").slice(0, 60),
      turns: this.turns.map((t) => ({ ...t })),
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
      updatedAt: Date.now(),
    };
    const list = this.loadHistory().filter((s) => s.id !== session.id);
    list.unshift(session);
    await this.context.workspaceState.update(
      HISTORY_KEY,
      list.slice(0, HISTORY_LIMIT)
    );
  }


  private async attachPaths(inputs: string[]): Promise<void> {
    const uniqueInputs = Array.from(
      new Set(inputs.map((s) => s.trim()).filter(Boolean))
    );

    if (uniqueInputs.length === 0) {
      return;
    }

    let attachedFiles = 0;
    const failed: string[] = [];

    for (const input of uniqueInputs) {
      try {
        attachedFiles += await this.attachSingleInput(input);
      } catch (e) {
        failed.push(`${input}: ${(e as Error).message}`);
      }
    }

    if (attachedFiles > 1 || uniqueInputs.length > 1) {
      await this.pushStatus(`Attached ${attachedFiles} file(s) from ${uniqueInputs.length} item(s).`);
    }

    if (failed.length > 0) {
      await this.pushError(`Some paths could not be attached: ${failed.join(" | ")}`);
    }
  }

  private async attachSingleInput(input: string): Promise<number> {
    const target = this.resolveAttachmentTarget(input);
    const stat = await vscode.workspace.fs.stat(target);

    if (stat.type & vscode.FileType.Directory) {
      const files = await this.collectFilesRecursive(target, MAX_ATTACH_FILES_PER_FOLDER + 1);

      if (files.length > MAX_ATTACH_FILES_PER_FOLDER) {
        throw new Error(
          `Folder "${this.displayPath(target)}" contains more than ${MAX_ATTACH_FILES_PER_FOLDER} files recursively. Attach a smaller folder or specific files instead.`
        );
      }
      for (const file of files) {
        const attachment = await this.readAttachment(file);
        this.queueAttachment(attachment);
      }
      return files.length;
    }

    if (stat.type & vscode.FileType.File) {
      const attachment = await this.readAttachment(target);
      this.queueAttachment(attachment);
      return 1;
    }

    throw new Error("Only files and folders can be attached.");
  }

  private queueAttachment(attachment: Attachment): void {
    const isDup = this.pendingAttachments.some((a) => sameAttachment(a, attachment));
    if (isDup) return;
    this.pendingAttachments.push(attachment);
    this.post({ type: "addAttachment", attachment });
  }

  private resolveAttachmentTarget(input: string): vscode.Uri {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("Empty path.");
    }

    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      const uri = vscode.Uri.parse(trimmed);
      if (uri.scheme !== "file") {
        throw new Error(`Unsupported URI scheme: ${uri.scheme}`);
      }
      return uri;
    }

    const normalizedInput = stripTrailingSeparators(trimmed);
    if (path.isAbsolute(normalizedInput)) {
      return vscode.Uri.file(normalizedInput);
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error("No workspace is open.");
    }

    return vscode.Uri.file(path.join(root, normalizedInput));
  }

  private async collectFilesRecursive(
    dir: vscode.Uri,
    limit = Number.POSITIVE_INFINITY
  ): Promise<vscode.Uri[]> {
    const out: vscode.Uri[] = [];

    const walk = async (current: vscode.Uri): Promise<void> => {
      const entries = await vscode.workspace.fs.readDirectory(current);
      entries.sort(([a], [b]) => a.localeCompare(b));

      for (const [name, type] of entries) {
        if (out.length >= limit) {
          return;
        }

        const child = vscode.Uri.joinPath(current, name);
        if (type & vscode.FileType.Directory) {
          await walk(child);
          continue;
        }
        if (type & vscode.FileType.File) {
          out.push(child);
          if (out.length >= limit) {
            return;
          }
        }
      }
    };

    await walk(dir);
    return out;
  }

  private async readAttachment(uri: vscode.Uri): Promise<Attachment> {
    const openDoc = vscode.workspace.textDocuments.find(
      (doc) =>
        doc.uri.scheme === uri.scheme &&
        path.normalize(doc.uri.fsPath) === path.normalize(uri.fsPath)
    );

    const content = openDoc
      ? openDoc.getText()
      : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");

    return {
      path: this.displayPath(uri),
      content,
    };
  }

  private displayPath(uri: vscode.Uri): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const fsPath = uri.fsPath;

    if (root) {
      const rel = path.relative(root, fsPath);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel.replace(/\\/g, "/");
      }
    }

    return fsPath.replace(/\\/g, "/");
  }

  private async sendFileSuggestions(query: string): Promise<void> {
    const q = query.toLowerCase();
    const found = await vscode.workspace.findFiles(
      "**/*",
      `**/{${SEARCH_EXCLUDE_DIRS.join(",")}}/**`,
      4000
    );

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const files = found
      .map((u) => path.relative(root, u.fsPath).replace(/\\/g, "/"))
      .filter((p) => p && p.toLowerCase().includes(q));

    const dirSet = new Set<string>();
    for (const filePath of found.map((u) =>
      path.relative(root, u.fsPath).replace(/\\/g, "/")
    )) {
      let current = path.posix.dirname(filePath);
      while (current && current !== "." && !dirSet.has(current)) {
        dirSet.add(current);
        current = path.posix.dirname(current);
      }
    }

    const dirs = Array.from(dirSet)
      .filter((p) => p.toLowerCase().includes(q))
      .map((p) => `${p}/`);

    const items = [...dirs, ...files]
      .sort((a, b) => compareSuggestions(a, b, q))
      .slice(0, 20);

    this.post({ type: "fileSuggestions", query, items });
  }

  private resetConfigWatcher(): void {
    this.configWatcher?.dispose();
    this.configWatcher = undefined;

    const file = configFilePath();
    if (!file) {
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const normalizedFile = path.normalize(file);
    let pattern: vscode.GlobPattern = normalizedFile.replace(/\\/g, "/");

    if (root) {
      const normalizedRoot = path.normalize(root);
      const rel = path.relative(normalizedRoot, normalizedFile);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        pattern = new vscode.RelativePattern(root, rel.replace(/\\/g, "/"));
      }
    }

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = () => this.scheduleConfigRefresh();
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    this.configWatcher = watcher;
  }

  private scheduleConfigRefresh(): void {
    if (this.configRefreshTimer) {
      clearTimeout(this.configRefreshTimer);
    }
    this.configRefreshTimer = setTimeout(() => {
      void this.sendInit();
    }, 150);
  }

  private isConfigFile(uri: vscode.Uri): boolean {
    try {
      const file = configFilePath();
      if (!file) return false;
      return path.normalize(uri.fsPath) === path.normalize(file);
    } catch {
      return false;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "style.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Evlampy</title>
</head>
<body>
  <div id="messages"></div>
  <div id="attachmentBar">
    <div id="attachments"></div>
  </div>
  <div id="suggestions" class="hidden"></div>
  <div id="composer">
    <textarea id="input" rows="3" placeholder="Ask…  (@ to attach a file / entire folder, ⌘/Ctrl+I to add the open file/selection)"></textarea>
    <div id="controls">
      <div class="selectors">
        <select id="model" title="Model"></select>
        <select id="effort" title="Effort"></select>
      </div>
      <span id="cost" class="cost"></span>
      <button id="send" title="Send (Enter)">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function fmtCost(c: number): string {
  return "$" + (c < 0.01 ? c.toFixed(5) : c.toFixed(4));
}

function newId(): string {
  return crypto.randomUUID();
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function sameAttachment(a: Attachment, b: Attachment): boolean {
  return (
    a.path === b.path &&
    a.range?.startLine === b.range?.startLine &&
    a.range?.endLine === b.range?.endLine
  );
}

function stripTrailingSeparators(input: string): string {
  return input.length > 1 ? input.replace(/[\\/]+$/g, "") : input;
}

function compareSuggestions(a: string, b: string, query: string): number {
  const aBase = path.posix.basename(a.replace(/\/$/, "")).toLowerCase();
  const bBase = path.posix.basename(b.replace(/\/$/, "")).toLowerCase();
  const aBaseMatch = aBase.includes(query) ? 0 : 1;
  const bBaseMatch = bBase.includes(query) ? 0 : 1;
  const aDir = a.endsWith("/") ? 0 : 1;
  const bDir = b.endsWith("/") ? 0 : 1;

  return aBaseMatch - bBaseMatch || aDir - bDir || a.length - b.length || a.localeCompare(b);
}

function summarizeUserTextForHistory(text: string): string {
  const body = text
    .replace(/<evlampy:read\s+path="[^"]+"[^>]*>[\s\S]*?<\/evlampy:read>/g, "")
    .replace(/^\s*---\s*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  return body.slice(0, 80) || "Chat";
}