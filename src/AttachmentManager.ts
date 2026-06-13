import * as vscode from "vscode";
import * as path from "path";
import { DraftAttachment, ResolvedAttachment } from "./types";

const MAX_ATTACH_FILES_PER_FOLDER = 100;

// Encapsulates attachment handling
export class AttachmentManager {

  // Resolves a workspace-relative, absolute, or URI path to a VS Code URI.
  public resolvePath(input: string): vscode.Uri {
    return this.resolveTarget(input);
  }

  /**
   * If a file is passed, returns it as is.
   * If a folder is passed, recursively expands it into a list of files.
   * Throws an error if the folder contains too many files.
   */
  public async expandPathToDrafts(input: string): Promise<DraftAttachment[]> {
    if (!input.trim()) throw new Error("Empty path.");

    const target = this.resolveTarget(input);
    const stat = await vscode.workspace.fs.stat(target);
    const drafts: DraftAttachment[] = [];

    if (stat.type & vscode.FileType.Directory) {
      const files = await this.collectFilesRecursive(target, MAX_ATTACH_FILES_PER_FOLDER + 1);
      if (files.length > MAX_ATTACH_FILES_PER_FOLDER) {
        throw new Error(`Folder "${this.displayPath(target)}" contains more than ${MAX_ATTACH_FILES_PER_FOLDER} files recursively. Attach a smaller folder or specific files instead.`);
      }
      for (const file of files) {
        drafts.push({ type: "file", path: this.displayPath(file) });
      }
    } else if (stat.type & vscode.FileType.File) {
      drafts.push({ type: "file", path: this.displayPath(target) });
    } else {
      throw new Error("Only files and folders can be attached.");
    }

    return drafts;
  }

  // Converts drafts into ready attachments (reads content from disk)
  public async resolveDrafts(drafts: DraftAttachment[]): Promise<ResolvedAttachment[]> {
    const resolved: ResolvedAttachment[] = [];
    for (const draft of drafts) {
      if (draft.type === "selection") {
        resolved.push({ path: draft.path, range: draft.range, content: draft.content });
      } else {
        const uri = this.resolveTarget(draft.path);
        const content = await this.readAttachmentContent(uri);
        resolved.push({ path: draft.path, content });
      }
    }
    return resolved;
  }

  // Constructs a URI from the given path. Handles absolute and relative paths
  private resolveTarget(input: string): vscode.Uri {
    const trimmed = input.trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      return vscode.Uri.parse(trimmed);
    }
    const normalizedInput = this.stripTrailingSeparators(trimmed);
    if (path.isAbsolute(normalizedInput)) {
      return vscode.Uri.file(normalizedInput);
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error("No workspace is open.");
    return vscode.Uri.file(path.join(root, normalizedInput));
  }

  // Recursively finds all files in a directory and returns them
  private async collectFilesRecursive(dir: vscode.Uri, limit: number): Promise<vscode.Uri[]> {
    const out: vscode.Uri[] = [];
    const walk = async (current: vscode.Uri): Promise<void> => {
      const entries = await vscode.workspace.fs.readDirectory(current);
      entries.sort(([a], [b]) => a.localeCompare(b));
      for (const [name, type] of entries) {
        if (out.length >= limit) return;
        const child = vscode.Uri.joinPath(current, name);
        if (type & vscode.FileType.Directory) await walk(child);
        else if (type & vscode.FileType.File) out.push(child);
      }
    };
    await walk(dir);
    return out;
  }

  // Reads content from disk or from an unsaved editor
  private async readAttachmentContent(uri: vscode.Uri): Promise<string> {
    const openDoc = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.scheme === uri.scheme && path.normalize(doc.uri.fsPath) === path.normalize(uri.fsPath)
    );
    return openDoc
      ? openDoc.getText()
      : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  }

  // Converts a URI to a string path relative to the current workspace root
  private displayPath(uri: vscode.Uri): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const fsPath = uri.fsPath;
    if (root) {
      const rel = path.relative(root, fsPath);
      if (rel && !rel.startsWith("..")) {
        return rel.replace(/\\/g, "/");
      }
    }
    return fsPath.replace(/\\/g, "/");
  }

  private stripTrailingSeparators(input: string): string {
    return input.length > 1 ? input.replace(/[\\/]+$/g, "") : input;
  }
}
