import * as vscode from "vscode";
import * as path from "path";

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
  "bazel-*",
];

// Isolates file search logic for suggestions (@).
// Takes a query string as input and returns an array of relative paths sorted by length.
export class SuggestionManager {

  private currentSource?: vscode.CancellationTokenSource;

  public async getSuggestions(query: string): Promise<string[]> {
    if (this.currentSource) {
      this.currentSource.cancel();
      this.currentSource.dispose();
    }

    if (!query) {
      this.currentSource = undefined;
      return [];
    }
    this.currentSource = new vscode.CancellationTokenSource();
    const token = this.currentSource.token;

    const parts = query.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) {
      return [];
    }
    const lowerParts = parts.map((p) => p.toLowerCase());

    const globParts = parts.map((p) => `*${p}*`);
    const pathPattern = globParts.join("/**/");
    const excludePattern = `**/{${SEARCH_EXCLUDE_DIRS.join(",")}}/**`;

    try {
      // Run 2 independent searches.
      // Search for matches both in directory names (/**) and in file names.
      const [foundFiles, foundDirs] = await Promise.all([
        vscode.workspace.findFiles(`**/${pathPattern}`, excludePattern, 50, token),
        vscode.workspace.findFiles(`**/${pathPattern}/**`, excludePattern, 50, token)
      ]);

      if (token.isCancellationRequested) return [];
      const found = [...foundFiles, ...foundDirs];

      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

      const filePaths = found
        .map((u) => path.relative(root, u.fsPath).replace(/\\/g, "/"))
        .filter((p) => this.matchesParts(p, lowerParts));

      const dirPaths = this.extractMatchingDirs(filePaths, lowerParts);

      return Array.from(new Set([...dirPaths, ...filePaths]))
        .sort((a, b) => a.length - b.length)
        .slice(0, 20);
    } catch {
      return [];
    }
  }

  // Extracts all unique parent folders from the found files and keeps those that match the query
  private extractMatchingDirs(filePaths: string[], lowerParts: string[]): string[] {
    const dirSet = new Set<string>();

    for (const filePath of filePaths) {
      let current = path.posix.dirname(filePath);
      // Traverse up the directory tree to the root
      while (current && current !== "." && !dirSet.has(current)) {
        dirSet.add(current);
        current = path.posix.dirname(current);
      }
    }

    return Array.from(dirSet)
      .map((dir) => `${dir}/`)
      .filter((dir) => this.matchesParts(dir, lowerParts));
  }

  // Checks that all query parts are present in the path in the typed order.
  private matchesParts(candidate: string, lowerParts: string[]): boolean {
    const lowerCandidate = candidate.toLowerCase();
    let lastIndex = 0;
    for (const part of lowerParts) {
      const idx = lowerCandidate.indexOf(part, lastIndex);
      if (idx === -1) return false;
      lastIndex = idx + part.length;
    }
    return true;
  }

  public dispose(): void {
    if (this.currentSource) {
      this.currentSource.cancel();
      this.currentSource.dispose();
      this.currentSource = undefined;
    }
  }
}
