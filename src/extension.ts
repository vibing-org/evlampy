import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { ChatViewProvider } from "./chatViewProvider";
import { DiffManager } from "./DiffManager";
import { overrideConfigForProject, loadConfig } from "./config";
import { DraftAttachment } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const diffs = new DiffManager(root);
  context.subscriptions.push(diffs.register());

  const provider = new ChatViewProvider(context, diffs);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("evlampy.addToChat", () =>
      addToChat(provider, root)
    ),
    vscode.commands.registerCommand("evlampy.focusChat", () =>
      vscode.commands.executeCommand("evlampy.chatView.focus")
    ),
    vscode.commands.registerCommand("evlampy.acceptFile", async () => {
      const rel = diffs.activeReviewRel();
      if (rel) {
        await diffs.acceptFile(rel);
      }
    }),
    vscode.commands.registerCommand("evlampy.rejectFile", async () => {
      const rel = diffs.activeReviewRel();
      if (rel) {
        await diffs.rejectFile(rel);
      }
    }),
    vscode.commands.registerCommand("evlampy.acceptAll", () => diffs.acceptAll()),
    vscode.commands.registerCommand("evlampy.rejectAll", () => diffs.rejectAll()),
    vscode.commands.registerCommand("evlampy.newChat", () => 
      provider["onIntent"]({ type: "intent:newChat" })
    ),
    vscode.commands.registerCommand("evlampy.chatHistory", () =>
      provider["onIntent"]({ type: "intent:showHistory" })
    ),
    vscode.commands.registerCommand("evlampy.openConfig", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "evlampy");
    }),
    vscode.commands.registerCommand("evlampy.overrideConfig", async () => {
      try {
        await overrideConfigForProject();
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    }),
    vscode.commands.registerCommand("evlampy.codexLogin", async () => {
      const available = await isCodexCliAvailable();
      if (!available) {
        vscode.window.showErrorMessage("Codex CLI was not found. Install OpenAI Codex and make sure `codex` is available on PATH.");
        return;
      }
      const terminal = vscode.window.createTerminal("Evlampy Codex Login");
      terminal.show();
      terminal.sendText(vscode.env.remoteName ? "codex login --device-auth" : "codex login");
    })
  );

  // Show the diff-editor Accept/Reject buttons only while an Evlampy diff is active.
  const updateContext = () => {
    const active = !!diffs.activeReviewRel();
    void vscode.commands.executeCommand(
      "setContext",
      "evlampy.reviewDiffActive",
      active
    );
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.window.tabGroups.onDidChangeTabs(updateContext),
    diffs.onReviewChange(updateContext)
  );
  updateContext();

  // Keep first-run setup visible for both provider modes.
  showStartupCredentialPrompt().catch(() => {});
}

function isCodexCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("codex", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  });
}

async function showStartupCredentialPrompt(): Promise<void> {
  const cfg = await loadConfig();

  // OpenAI-compatible providers need an API key before the first request.
  if (cfg.provider === "openai-compatible") {
    if (!cfg.apiKey) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "evlampy");
    }
    return;
  }

  // Codex has its own login; check status without starting a model turn.
  const status = await getCodexLoginStatus();
  if (status.ok) {
    return;
  }

  if (status.canLogin) {
    const action = "Sign in to Codex";
    const picked = await vscode.window.showErrorMessage(status.message, action);
    if (picked === action) {
      await vscode.commands.executeCommand("evlampy.codexLogin");
    }
  } else {
    await vscode.window.showErrorMessage(status.message);
  }
}

function getCodexLoginStatus(): Promise<{ ok: true } | { ok: false; message: string; canLogin: boolean }> {
  return new Promise((resolve) => {
    // `codex login status` is cheap and does not inspect the workspace or call the model.
    const child = spawn("codex", ["login", "status"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;

    const finish = (status: { ok: true } | { ok: false; message: string; canLogin: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(status);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => {
      finish({
        ok: false,
        message: "Codex CLI was not found. Install OpenAI Codex and make sure `codex` is available on PATH.",
        canLogin: false,
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }

      const detail = cleanCodexStatusOutput(output);
      finish({
        ok: false,
        message: detail
          ? `Codex CLI is not signed in. ${detail}`
          : "Codex CLI is not signed in. Run 'Evlampy: Sign in to Codex' or 'codex login'.",
        canLogin: true,
      });
    });
  });
}

function cleanCodexStatusOutput(output: string): string {
  // Codex may print install-time warnings before the actual auth status.
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not create PATH aliases:"))
    .join(" ");
}

async function addToChat(
  provider: ChatViewProvider,
  root: string
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Evlampy: no active editor.");
    return;
  }
  const doc = editor.document;
  const rel = root
    ? path.relative(root, doc.uri.fsPath).replace(/\\/g, "/")
    : doc.uri.fsPath;

  const sel = editor.selection;
  let attachment: DraftAttachment;
  if (!sel.isEmpty) {
    const text = doc.getText(sel);
    attachment = {
      type: "selection",
      path: rel,
      range: { startLine: sel.start.line + 1, endLine: sel.end.line + 1 },
      content: text,
    };
  } else {
    attachment = { type: "file", path: rel };
  }
  await provider.addDraftAttachments([attachment]);
}

export function deactivate(): void {
  // nothing to clean up beyond context.subscriptions
}
