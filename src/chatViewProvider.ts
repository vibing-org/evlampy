import * as vscode from "vscode";
import { DiffManager } from "./DiffManager";
import { loadConfig, loadUserSystemPrompt } from "./config";
import { buildSystemMessage, buildUserMessage } from "./prompt";
import { parseChatResponse } from "./parser";
import { ChatSession } from "./ChatSession";
import { AttachmentManager } from "./AttachmentManager";
import { SuggestionManager } from "./SuggestionManager";
import { WebviewHtmlProvider } from "./WebviewHtmlProvider";
import { WebviewIntent, HostMessage, DraftAttachment, ChatMsg, ContentBlock, DiffOp } from "./types";
import { TokenTimer } from "./TokenTimer";
import { ConfigWatcher } from "./ConfigWatcher";
import { getProvider } from "./providers";
import { activeModels } from "./configDefaults";

const STREAM_REASONING_LINE_LIMIT = 20;

// Controller. Orchestrates calls and manages the request lifecycle:
// - Receives Intents from Webview
// - Calls the appropriate service
// - Updates ChatSession
// - Pushes new state back to the View
export class ChatViewProvider implements vscode.WebviewViewProvider {

  public static readonly viewType = "evlampy.chatView";
  private view?: vscode.WebviewView;
  private session: ChatSession;
  private resolver = new AttachmentManager();
  private suggestions = new SuggestionManager();
  private configWatcher: ConfigWatcher;
  private userAbort?: AbortController; // stops generation via Stop button
  private timeoutAbort?: AbortController; // stops generation on timeout
  private pushStateTimer?: NodeJS.Timeout; // to avoid pushing newly generated response tokens to the frontend too frequently

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diffs: DiffManager
  ) {
    this.session = new ChatSession(context);

    this.configWatcher = new ConfigWatcher((config) => {
      const models = activeModels(config);
      this.session.state.availableModels = models;
      if (!models.includes(this.session.state.selectedModel) && models.length > 0) {
        // If not selected and not in history, use the value from config.
        // Later this field is controlled by intents from the frontend.
        this.session.state.selectedModel = models[0];
      }
      this.pushSessionState();
    });

    this.context.subscriptions.push(
      this.configWatcher,
      { dispose: () => this.suggestions.dispose() }
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = WebviewHtmlProvider.getHtml(this.context, view.webview);
    view.webview.onDidReceiveMessage((intent: WebviewIntent) => this.onIntent(intent));
  }

  /** Reveal the chat and push attachment chips (from the Cmd+I command). */
  async addDraftAttachments(attachments: DraftAttachment[]): Promise<void> {
    await vscode.commands.executeCommand("evlampy.chatView.focus");
    // Give the view a tick to resolve if it was hidden.
    await new Promise((r) => setTimeout(r, 50));
    this.view?.webview.postMessage({ type: "ui:addDraftAttachments", attachments } as HostMessage);
  }

  // Sends new state to Webview. Throttles updates during streaming
  // to avoid flooding IPC and hanging Webview with frequent Markdown + Highlight.js re-renders.
  private pushSessionState(): void {
    if (!this.view) return;

    if (this.session.state.isStreaming) {
      // Send response updates to the frontend no more than once every 50 ms
      if (this.pushStateTimer) return;
      this.pushStateTimer = setTimeout(() => {
        this.pushStateTimer = undefined;
        if (this.view) {
          this.view.webview.postMessage({ type: "state:update", state: this.session.state } as HostMessage);
        }
      }, 50);
    } else {
      // Clear pushStateTimer after response generation finishes
      if (this.pushStateTimer) {
        clearTimeout(this.pushStateTimer);
        this.pushStateTimer = undefined;
      }
      this.view.webview.postMessage({ type: "state:update", state: this.session.state } as HostMessage);
    }
  }

  // Receives intents from Webview
  private async onIntent(intent: WebviewIntent): Promise<void> {
    switch (intent.type) {
      case "intent:ready":
        await this.handleReady();
        break;
      case "intent:send":
        await this.handleSend(intent.text, intent.model, intent.effort, intent.attachments);
        break;
      case "intent:cancel":
        if (this.userAbort) {
          this.userAbort.abort();
        }
        break;
      case "intent:attachPath":
        await this.handleAttach(intent.path);
        break;
      case "intent:requestSuggestions":
        await this.handleSuggestions(intent.query);
        break;
      case "intent:newChat":
        this.handleNewChat();
        break;
      case "intent:showHistory":
        await this.handleShowHistory();
        break;
      case "intent:selectModel":
        this.session.setSelectedModel(intent.model);
        this.pushSessionState();
        break;
      case "intent:selectEffort":
        this.session.setSelectedEffort(intent.effort);
        this.pushSessionState();
        break;
      case "intent:openConfig":
        vscode.commands.executeCommand("workbench.action.openSettings", "evlampy");
        break;
    }
  }

  private async handleReady(): Promise<void> {
    await this.configWatcher.refresh();
    this.pushSessionState();
  }

  private async handleSend(text: string, model: string, effort: any, drafts: DraftAttachment[]): Promise<void> {
    if (!text.trim() || !model || !effort) {
      return;
    }
    let tokenTimer: TokenTimer | undefined;
    try {
      const config = await loadConfig();
      const provider = getProvider(config);

      // Read file contents right before sending
      const resolvedAttachments = await this.resolver.resolveDrafts(drafts);

      // Build user message
      const userSystemPrompt = await loadUserSystemPrompt(config);
      const systemMsg = buildSystemMessage(userSystemPrompt);
      const userText = buildUserMessage(text, resolvedAttachments);

      this.session.addUserTurn({ role: "user", prompt: text, rawText: userText, attachments: resolvedAttachments });
      this.pushSessionState();

      // Collect chat history
      const messages = [
        { role: "system", content: systemMsg } as ChatMsg,
        ...this.session.getMessagesForLLM(),
      ];

      // Show LLM response placeholder in chat
      const assistantTurn = this.session.startAssistantTurn();
      this.pushSessionState();

      this.userAbort = new AbortController();
      this.timeoutAbort = new AbortController();

      // Combine both signals: streaming will be aborted if either triggers
      const combinedAbort = new AbortController();
      const onAbort = () => combinedAbort.abort();
      this.userAbort.signal.addEventListener("abort", onAbort);
      this.timeoutAbort.signal.addEventListener("abort", onAbort);

      tokenTimer = new TokenTimer(this.timeoutAbort);
      tokenTimer.reset();

      // Keep the full reasoning on the host while streaming, but send only a short tail to the Webview.
      // Huge reasoning blocks make VS Code Webview IPC and layout noticeably laggy.
      let fullReasoning = "";

      const res = await provider.chat({
        config,
        model,
        effort,
        messages,
        signal: combinedAbort.signal,
        onDelta: (delta) => {
          assistantTurn.rawText += delta;
          assistantTurn.status = "streaming";
          tokenTimer!.reset();
          this.pushSessionState();
        },
        onReasoningDelta: (reasoningDelta) => {
          fullReasoning += reasoningDelta;
          assistantTurn.reasoning = this.tailReasoning(fullReasoning);
          assistantTurn.status = "streaming";
          tokenTimer!.reset();
          this.pushSessionState();
        }
      });

      // Save chat to debug logs
      await this.session.logChat(messages, res.text);

      // Parse LLM response: extract text and diff operations
      const blocks = parseChatResponse(res.text);
      // Restore full reasoning after streaming ends. The final UI keeps it collapsed and renders it as plain text.
      assistantTurn.reasoning = fullReasoning;
      assistantTurn.blocks = blocks;

      // Extract only operations to apply to the file system.
      const suggestedChanges = blocks.flatMap(b => b.type === "op" ? [b.op] : []);

      let report;
      if (suggestedChanges.length > 0) {
        report = await this.diffs.apply(suggestedChanges);
      }

      this.session.finishAssistantTurn(res.usage, report);
      this.pushSessionState();
    } catch (e) {
      if (this.timeoutAbort?.signal.aborted) {
        this.session.registerTimeout();
      } else if (this.userAbort?.signal.aborted) {
        this.session.registerUserAbort();
      } else {
        this.session.registerError(e as Error);
      }
      this.pushSessionState();
    } finally {
      tokenTimer?.clear();
      this.userAbort = undefined;
      this.timeoutAbort = undefined;
    }
  }

  private tailReasoning(reasoning: string): string {
    let start = reasoning.length;
    for (let lines = 0; lines < STREAM_REASONING_LINE_LIMIT && start > 0; lines++) {
      start = reasoning.lastIndexOf("\n", start - 1);
      if (start === -1) {
        return reasoning;
      }
    }
    return "...\n" + reasoning.slice(start + 1);
  }

  private async handleAttach(inputPath: string): Promise<void> {
    try {
      const drafts = await this.resolver.expandPathToDrafts(inputPath);
      this.view?.webview.postMessage({ type: "ui:addDraftAttachments", attachments: drafts } as HostMessage);
    } catch (e) {
      this.session.addSystemTurn({ role: "system", text: `Attach failed: ${(e as Error).message}`, status: "error" });
      this.pushSessionState();
    }
  }

  private async handleSuggestions(query: string): Promise<void> {
    const items = await this.suggestions.getSuggestions(query);
    this.view?.webview.postMessage({ type: "ui:suggestions", query, items } as HostMessage);
  }

  private handleNewChat(): void {
    if (this.blockIfStreaming("Cannot create a new chat while the current one is generating. Please stop it first.")) {
      return;
    }

    this.session.reset();
    this.pushSessionState();
  }

  // If a stream is currently running, posts an error system turn and returns true.
  private blockIfStreaming(message: string): boolean {
    if (this.session.state.isStreaming) {
      this.session.addSystemTurn({ role: "system", text: message, status: "error" });
      this.pushSessionState();
      return true;
    }
    return false;
  }

  private async handleShowHistory(): Promise<void> {
    const sessions = this.session.getHistory();
    if (sessions.length === 0) {
      vscode.window.showInformationMessage("Evlampy: no chat history yet.");
      return;
    }

    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.chatTitle || "(untitled)",
        detail: new Date(s.updatedAt).toLocaleString(),
        session: s,
      })),
      { placeHolder: "Restore a chat" }
    );

    if (pick) {
      if (this.blockIfStreaming("Cannot restore chat while the current one is generating. Please stop it first.")) {
        return;
      }

      this.session.loadFromHistory(pick.session);
      await this.configWatcher.refresh();
      this.pushSessionState();
    }
  }
}
