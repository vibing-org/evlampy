import * as vscode from "vscode";
import * as path from "path";
import { ChatViewProvider } from "./chatViewProvider";
import { DiffManager } from "./applier";
import { overrideConfigForProject } from "./config";
import { Attachment } from "./types";

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
    vscode.commands.registerCommand("evlampy.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("evlampy.chatHistory", () =>
      provider.showHistory()
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
  let attachment: Attachment;
  if (!sel.isEmpty) {
    const text = doc.getText(sel);
    attachment = {
      path: rel,
      range: { startLine: sel.start.line + 1, endLine: sel.end.line + 1 },
      content: text,
    };
  } else {
    attachment = { path: rel, content: doc.getText() };
  }
  await provider.addAttachment(attachment);
}

export function deactivate(): void {
  // nothing to clean up beyond context.subscriptions
}
