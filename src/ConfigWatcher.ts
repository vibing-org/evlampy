import * as vscode from "vscode";
import * as path from "path";
import { loadConfig, configFilePath } from "./config";
import { EvlampyConfig } from "./types";

// Isolated configuration watcher.
// Encapsulates subscription logic for files and VS Code settings.
// On any change, debounces the call and exposes the ready config externally.
export class ConfigWatcher {

  private watcher?: vscode.FileSystemWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly onConfigChanged: (config: EvlampyConfig) => void) {
    this.disposables.push(
      // Subscribe to global configuration changes
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("evlampy.configPath")) {
          this.resetWatcher();
        }
        this.scheduleRefresh();
      }),
      // Subscribe to local configuration changes in .evlampy/config.json
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.isConfigFile(doc.uri)) {
          this.scheduleRefresh();
        }
      })
    );
    this.resetWatcher();
  }

  // Releases resources
  public dispose(): void {
    this.watcher?.dispose();
    if (this.timer) clearTimeout(this.timer);
    this.disposables.forEach(d => d.dispose());
  }

  // Forced read (e.g., during Webview initialization)
  public async refresh(): Promise<void> {
    try {
      const config = await loadConfig();
      this.onConfigChanged(config);
    } catch { }
  }

  // Debounce (delayed call) to avoid spamming updates
  // if the file is saved multiple times in a row or a batch of settings changes.
  private scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.refresh(); }, 150);
  }

  // Recreates the FileSystemWatcher. Called on start and if the config path changes in settings.
  private resetWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;

    const file = configFilePath();
    if (!file) return;

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const normalizedFile = path.normalize(file);
    let pattern: vscode.GlobPattern = normalizedFile.replace(/\\/g, "/");

    // Try to make the path relative to the workspace root.
    // VS Code FileSystemWatcher works more reliably and efficiently with RelativePattern.
    if (root) {
      const normalizedRoot = path.normalize(root);
      const rel = path.relative(normalizedRoot, normalizedFile);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        pattern = new vscode.RelativePattern(root, rel.replace(/\\/g, "/"));
      }
    }

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = () => this.scheduleRefresh();

    // Watch for file creation, change, and deletion
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    this.watcher = watcher;
  }

  // Checks whether the saved document is our configuration file.
  // Uses path.normalize for cross-platform path comparison (Windows vs Linux/Mac).
  private isConfigFile(uri: vscode.Uri): boolean {
    try {
      const file = configFilePath();
      if (!file) return false;
      return path.normalize(uri.fsPath) === path.normalize(file);
    } catch {
      return false;
    }
  }
}