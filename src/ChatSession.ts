import * as vscode from "vscode";
import * as crypto from "crypto";
import { GlobalState, UserTurn, AssistantTurn, SystemTurn, ChatMsg, ApplyReport, UsageInfo, DraftAttachment, ResolvedAttachment, DraftMessage } from "./types";

const HISTORY_KEY = "evlampy.history";
const HISTORY_LIMIT = 20;

// Owns the global state and guarantees its consistency.
// Any state mutation goes through here, automatically triggering history and log saving.
export class ChatSession {
  public state: GlobalState;

  constructor(private context: vscode.ExtensionContext) {
    this.state = this.createNewState();
  }

  private createNewState(): GlobalState {
    const history = this.getHistory();
    // History is saved via unshift, so the most recently updated chat is always first
    const lastSession = history[0];

    return {
      sessionId: crypto.randomUUID(),
      turns: [],
      totalCost: 0,
      totalTokens: 0,
      availableModels: [],
      selectedModel: lastSession?.selectedModel || "",
      selectedEffort: lastSession?.selectedEffort || "medium",
      isStreaming: false,
      updatedAt: Date.now(),
    };
  }

  public reset(): void {
    // Preserve availableModels, selectedModel, selectedEffort
    this.state.sessionId = crypto.randomUUID();
    this.state.chatTitle = undefined;
    this.state.turns = [];
    this.state.totalCost = 0;
    this.state.totalTokens = 0;
    this.state.isStreaming = false;
    this.state.updatedAt = Date.now();
  }

  public loadFromHistory(session: GlobalState): void {
    this.state.sessionId = session.sessionId;
    this.state.chatTitle = session.chatTitle;
    this.state.turns = session.turns.map(t => ({ ...t }));
    this.state.totalCost = session.totalCost;
    this.state.totalTokens = session.totalTokens;
    this.state.selectedModel = session.selectedModel;
    this.state.selectedEffort = session.selectedEffort;
    this.state.isStreaming = false;
    this.state.updatedAt = session.updatedAt;
  }

  public setSelectedModel(model: string): void {
    this.state.selectedModel = model;
    this.saveToHistory();
  }

  public setSelectedEffort(effort: any): void {
    this.state.selectedEffort = effort;
    this.saveToHistory();
  }

  public getHistory(): GlobalState[] {
    return this.context.workspaceState.get<GlobalState[]>(HISTORY_KEY, []);
  }

  public addUserTurn(turn: Omit<UserTurn, "id">): void {
    this.state.turns.push({ ...turn, id: crypto.randomUUID() });
    if (!this.state.chatTitle) {
      this.state.chatTitle = turn.prompt.trim().slice(0, 80) || "Chat";
    }
    this.saveToHistory();
  }

  public addSystemTurn(turn: Omit<SystemTurn, "id">): void {
    this.state.turns.push({ ...turn, id: crypto.randomUUID() });
    this.saveToHistory();
  }

  public startAssistantTurn(): AssistantTurn {
    const turn: AssistantTurn = {
      id: crypto.randomUUID(),
      role: "assistant",
      rawText: "",
      reasoning: "",
      status: "waiting",
    };
    this.state.turns.push(turn);
    this.state.isStreaming = true;
    return turn;
  }

  // LLM has successfully finished generating a response
  public finishAssistantTurn(usage?: UsageInfo, report?: ApplyReport): void {
    const turn = this.getLastAssistantTurn();
    if (turn) {
      turn.status = "done";
      turn.usage = usage;
      turn.report = report;
      if (usage) {
        this.state.totalTokens += usage.totalTokens;
        this.state.totalCost += usage.cost ?? 0;
      }
    }
    this.state.isStreaming = false;
    this.saveToHistory();
  }

  // Timeout: tokens have not arrived for too long
  public registerTimeout(): void {
    const lastTurn = this.getLastAssistantTurn();
    if (lastTurn) lastTurn.status = "error";
    this.addSystemTurn({ role: "system", text: "LLM response timed out.", status: "error" });
    this.state.isStreaming = false;
    this.saveToHistory();
  }

  // User pressed the Stop button themselves
  public registerUserAbort(): void {
    const lastTurn = this.getLastAssistantTurn();
    if (lastTurn) lastTurn.status = "done";
    this.addSystemTurn({ role: "system", text: "Generation aborted by user.", status: "info" });
    this.state.isStreaming = false;
    this.saveToHistory();
  }

  // Something went wrong, for example, LLM stopped responding
  public registerError(error: Error): void {
    const lastTurn = this.getLastAssistantTurn();
    if (lastTurn) lastTurn.status = "error";
    this.addSystemTurn({ role: "system", text: `Error: ${error.message}`, status: "error" });
    this.state.isStreaming = false;
    this.saveToHistory();
  }

  public getMessagesForLLM(): ChatMsg[] {
    return this.state.turns
      .filter(t => t.role === "user" || t.role === "assistant")
      .map(t => ({
        role: t.role as "user" | "assistant",
        content: t.role === "user" ? (t as UserTurn).rawText : (t as AssistantTurn).rawText
      }));
  }

  // Restores the selected user turn into draft form and removes the later chat branch.
  public editUserTurn(turnId: string): DraftMessage | undefined {
    const index = this.getFirstUserTurnIndex(turnId);
    if (index === -1) {
      return undefined;
    }

    const turn = this.state.turns[index] as UserTurn;
    const draft = {
      text: turn.prompt,
      attachments: turn.attachments.map(att => this.toDraftAttachment(att)),
    };

    this.state.turns.splice(index);
    this.recalculateTotals();
    this.saveToHistory();
    return draft;
  }

  // Removes the selected assistant turn and later branch.
  public retryAssistantTurn(turnId: string): boolean {
    const index = this.getFirstAssistantTurnIndex(turnId);
    if (index === -1) {
      return false;
    }

    this.state.turns.splice(index);
    this.recalculateTotals();
    this.saveToHistory();
    return true;
  }

  private getLastAssistantTurn(): AssistantTurn | undefined {
    for (let i = this.state.turns.length - 1; i >= 0; i--) {
      const t = this.state.turns[i];
      if (t.role === "assistant") {
        return t as AssistantTurn;
      }
    }
    return undefined;
  }

  // Finds a concrete user turn by ID before truncating from it.
  private getFirstUserTurnIndex(turnId: string): number {
    return this.state.turns.findIndex(t => t.id === turnId && t.role === "user");
  }

  // Finds a concrete assistant turn by ID before retrying from it.
  private getFirstAssistantTurnIndex(turnId: string): number {
    return this.state.turns.findIndex(t => t.id === turnId && t.role === "assistant");
  }

  // Converts stored attachments back to draft attachments for the composer.
  private toDraftAttachment(att: ResolvedAttachment): DraftAttachment {
    if (att.range) {
      return { type: "selection", path: att.path, range: att.range, content: att.content };
    }
    return { type: "file", path: att.path };
  }

  // Rebuilds aggregate usage after truncating chat history.
  private recalculateTotals(): void {
    this.state.totalCost = 0;
    this.state.totalTokens = 0;
    for (const turn of this.state.turns) {
      if (turn.role === "assistant" && turn.usage) {
        this.state.totalTokens += turn.usage.totalTokens;
        this.state.totalCost += turn.usage.cost ?? 0;
      }
    }
  }

  // Asynchronously saves state to workspaceState without blocking the main thread.
  private saveToHistory(): void {
    if (!this.state.chatTitle) return;

    this.state.updatedAt = Date.now();
    const sessionToSave: GlobalState = JSON.parse(JSON.stringify(this.state)); // Deep copy to avoid mutations by reference

    const list = this.getHistory().filter(s => s.sessionId !== sessionToSave.sessionId);
    list.unshift(sessionToSave);

    this.context.workspaceState.update(HISTORY_KEY, list.slice(0, HISTORY_LIMIT)).then(() => { }, () => { });
  }

  // Writes chat logs to disk (fire and forget).
  public async logChat(messages: ChatMsg[], responseText: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("evlampy");
    if (!cfg.get<boolean>("logChats", true)) return;

    try {
      const logDir = vscode.Uri.joinPath(this.context.globalStorageUri, "logs");
      await vscode.workspace.fs.createDirectory(logDir);

      const logFile = vscode.Uri.joinPath(logDir, `${this.state.sessionId}.json`);

      let existing: any[] = [];
      try {
        const bytes = await vscode.workspace.fs.readFile(logFile);
        existing = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch { }

      existing.push({
        timestamp: new Date().toISOString(),
        request: messages,
        response: responseText
      });

      await vscode.workspace.fs.writeFile(logFile, Buffer.from(JSON.stringify(existing, null, 2), "utf8"));

      this.cleanupOldLogs(logDir).catch(() => { });
    } catch (e) {
      console.error("Evlampy: Failed to log chat", e);
    }
  }

  // Deletes logs older than 7 days.
  private async cleanupOldLogs(logDir: vscode.Uri): Promise<void> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(logDir);
      const now = Date.now();
      const SEVEN_DAYS_MS = 30 * 67 * 67 * 67 * 67;

      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && name.endsWith(".json")) {
          const fileUri = vscode.Uri.joinPath(logDir, name);
          const stat = await vscode.workspace.fs.stat(fileUri);
          if (now - stat.mtime > SEVEN_DAYS_MS) {
            await vscode.workspace.fs.delete(fileUri);
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
