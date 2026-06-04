import * as vscode from "vscode";
import * as path from "path";
 import {
   ApplyFailure,
   ApplyReport,
   ApplyResultItem,
   DiffOp,
   Hunk,
   ReviewEvent,
   ReviewFile,
   ReviewStatus,
 } from "./types";
import { findMatch } from "./matcher";
import { stripPlaceholders } from "./parser";

const ORIG_SCHEME = "evlampy-orig";

interface ReviewItem {
  rel: string;
  uri: vscode.Uri;
  /** Original on-disk content; null if the file was newly created. */
  original: string | null;
  /** True if the op deleted the file (already removed from disk). */
  deleted: boolean;
  /** Virtual URI holding the original content for the left side of the diff. */
  origUri: vscode.Uri;
  status: ReviewStatus;
  detail: string;
}

/**
 * Applies diff ops (leaving documents dirty) and drives a linear, per-file
 * review: one diff at a time, accept (save) or reject (revert) each file, then
 * automatically advances to the next pending file. No global accept/reject.
 */
export class DiffManager implements vscode.TextDocumentContentProvider {
  private items: ReviewItem[] = [];
  private originals = new Map<string, string>();
  private counter = 0;

  private readonly _onReviewChange = new vscode.EventEmitter<ReviewEvent>();
  readonly onReviewChange = this._onReviewChange.event;

  constructor(private readonly root: string) {}

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, this),
      this._onReviewChange
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.originals.get(uri.toString()) ?? "";
  }

  private resolve(rel: string): vscode.Uri {
    const abs = path.isAbsolute(rel) ? rel : path.join(this.root, rel);
    return vscode.Uri.file(abs);
  }

  // ---- Apply a batch, then start the review ----

  async apply(ops: DiffOp[]): Promise<ApplyReport> {
    this.items = [];
    this.originals.clear();

    const report: ApplyResultItem[] = [];
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex];
      try {
        report.push(await this.applyOne(op, opIndex));
      } catch (e) {
        report.push({
          path: op.path,
          ok: false,
          detail: (e as Error).message,
          kind: op.kind,
          opIndex,
        });
      }
    }

    const appliedCount = report.filter((i) => i.ok).length;

    if (this.items.length > 0) {
      this._onReviewChange.fire({ kind: "start", files: this.reviewFiles() });
      await this.openFirstPending();
    }

    return {
      items: report,
      appliedCount,
      failedCount: report.length - appliedCount,
    };
  }

  private reviewFiles(): ReviewFile[] {
    return this.items.map((i) => ({
      path: i.rel,
      status: i.status,
      detail: i.detail,
    }));
  }

  private async applyOne(op: DiffOp, opIndex: number): Promise<ApplyResultItem> {
    switch (op.kind) {
      case "new":
        return this.applyNew(op.path, op.content, opIndex);
      case "rewrite":
        return this.applyRewrite(op.path, op.content, opIndex);
      case "edit":
        return this.applyEdit(op.path, op.hunks, opIndex);
      case "delete":
        return this.applyDelete(op.path, opIndex);
    }
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async applyNew(
    rel: string,
    content: string,
    opIndex: number
  ): Promise<ApplyResultItem> {
    const uri = this.resolve(rel);
    if (await this.exists(uri)) {
      return this.applyRewrite(rel, content, opIndex);
    }
    const we = new vscode.WorkspaceEdit();
    we.createFile(uri, { ignoreIfExists: true });
    we.insert(uri, new vscode.Position(0, 0), content);
    await vscode.workspace.applyEdit(we);
    this.track(rel, uri, null, false, "new file");
    return { path: rel, ok: true, detail: "new file", kind: "new", opIndex };
  }

  private async applyRewrite(
    rel: string,
    content: string,
    opIndex: number
  ): Promise<ApplyResultItem> {
    const uri = this.resolve(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();
    if (content === original) {
      return {
        path: rel,
        ok: false,
        detail: "no change",
        kind: "rewrite",
        opIndex,
      };
    }
    await this.replaceWhole(doc, content);
    this.track(rel, uri, original, false, "rewritten");
    return { path: rel, ok: true, detail: "rewritten", kind: "rewrite", opIndex };
  }

  private async applyEdit(
    rel: string,
    hunks: Hunk[],
    opIndex: number
  ): Promise<ApplyResultItem> {
    const uri = this.resolve(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();

    interface Span {
      start: number;
      end: number;
      search: string;
      replace: string;
      hunkIndex: number;
    }

    const spans: Span[] = [];
    const failures: ApplyFailure[] = [];
    let warnedAboutMultiples = false;

    for (let h = 0; h < hunks.length; h++) {
      const replace = stripPlaceholders(hunks[h].replace);
      const outcome = findMatch(original, hunks[h].search);
      if (!outcome.ok) {
        failures.push({
          hunkIndex: h,
          detail: outcome.reason,
          search: hunks[h].search,
          replace,
        });
        continue;
      }
      if (outcome.match.multipleMatches) {
        warnedAboutMultiples = true;
      }
      spans.push({
        start: outcome.match.start,
        end: outcome.match.end,
        search: hunks[h].search,
        replace,
        hunkIndex: h,
      });
    }

    spans.sort((a, b) => b.start - a.start);
    let lastStart = Number.MAX_SAFE_INTEGER;
    let newText = original;
    let overlaps = 0;
    for (const s of spans) {
      if (s.end > lastStart) {
        overlaps++;
        failures.push({
          hunkIndex: s.hunkIndex,
          detail: "overlaps another applied hunk and was skipped",
          search: s.search,
          replace: s.replace,
        });
        continue;
      }
      newText = newText.slice(0, s.start) + s.replace + newText.slice(s.end);
      lastStart = s.start;
    }

    const appliedHunks = spans.length - overlaps;
    if (newText !== original) {
      await this.replaceWhole(doc, newText);
      let detail = `${appliedHunks} hunk(s) applied`;
      if (warnedAboutMultiples) {
        detail += " (⚠️ applied to 1st of multiple occurrences)";
      }
      this.track(rel, uri, original, false, detail);
    }

    if (failures.length > 0) {
      return {
        path: rel,
        ok: appliedHunks > 0,
        detail: `Applied ${appliedHunks} hunk(s). Failed: ${failures
          .map((f) =>
            f.hunkIndex !== undefined
              ? `hunk ${f.hunkIndex + 1}: ${f.detail}`
              : f.detail
          )
          .join("; ")}`,
        kind: "edit",
        opIndex,
        partial: appliedHunks > 0,
        failures,
      };
    }

    return {
      path: rel,
      ok: true,
      detail: warnedAboutMultiples
        ? `${hunks.length} hunk(s) applied (⚠️ applied to the first of duplicate regions)`
        : `${hunks.length} hunk(s) applied`,
      kind: "edit",
      opIndex,
    };
  }

  private async applyDelete(rel: string, opIndex: number): Promise<ApplyResultItem> {
    const uri = this.resolve(rel);
    if (!(await this.exists(uri))) {
      return {
        path: rel,
        ok: false,
        detail: "file does not exist",
        kind: "delete",
        opIndex,
      };
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();
    const we = new vscode.WorkspaceEdit();
    we.deleteFile(uri, { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(we);
    this.track(rel, uri, original, true, "deleted");
    return {
      path: rel,
      ok: true,
      detail: "deleted (reject to restore)",
      kind: "delete",
      opIndex,
    };
  }

  private track(
    rel: string,
    uri: vscode.Uri,
    original: string | null,
    deleted: boolean,
    detail: string
  ): void {
    if (this.items.some((i) => i.uri.fsPath === uri.fsPath)) {
      return;
    }
    const origUri = vscode.Uri.parse(`${ORIG_SCHEME}:${rel}?v=${this.counter++}`);
    this.originals.set(origUri.toString(), original ?? "");
    this.items.push({
      rel,
      uri,
      original,
      deleted,
      origUri,
      status: "pending",
      detail,
    });
  }

  private async replaceWhole(doc: vscode.TextDocument, content: string): Promise<void> {
    const we = new vscode.WorkspaceEdit();
    const full = new vscode.Range(
      new vscode.Position(0, 0),
      doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end
    );
    we.replace(doc.uri, full, content);
    await vscode.workspace.applyEdit(we);
  }

  private async openDiff(item: ReviewItem): Promise<void> {
    if (item.deleted) {
      // No right-hand document to diff against; show the original being removed
      const doc = await vscode.workspace.openTextDocument(item.origUri);
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      item.origUri,
      item.uri,
      `${item.rel} (Evlampy: original ↔ proposed)`,
      { preview: false }
    );
  }

  // ---- Linear navigation ----

  private async openFirstPending(): Promise<void> {
    const next = this.items.find((i) => i.status === "pending");
    if (next) {
      await this.openDiff(next);
      this._onReviewChange.fire({ kind: "navigated" });
    }
  }

  private async advanceFrom(decided: ReviewItem): Promise<void> {
    await this.closeDiffTab(decided);
    const next = this.items.find((i) => i.status === "pending");
    if (next) {
      await this.openDiff(next);
      this._onReviewChange.fire({ kind: "navigated" });
    } else {
      this._onReviewChange.fire({ kind: "done" });
    }
  }

  private async closeDiffTab(item: ReviewItem): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as unknown;
        if (
          input instanceof vscode.TabInputTextDiff &&
          input.original.toString() === item.origUri.toString()
        ) {
          await vscode.window.tabGroups.close(tab);
        } else if (
          input instanceof vscode.TabInputText &&
          input.uri.toString() === item.origUri.toString()
        ) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }

  // ---- Decisions (per file) ----

  /** The review file shown in the currently active diff tab, if any. */
  activeReviewRel(): string | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input as unknown;
    if (input instanceof vscode.TabInputTextDiff && input.original.scheme === ORIG_SCHEME) {
      return this.items.find((i) => i.uri.toString() === input.modified.toString())?.rel;
    }
    if (input instanceof vscode.TabInputText && input.uri.scheme === ORIG_SCHEME) {
      // A deleted-file preview is open
      return this.items.find((i) => i.origUri.toString() === input.uri.toString())?.rel;
    }
    return undefined;
  }

  async acceptFile(rel: string): Promise<void> {
    const item = this.items.find((i) => i.rel === rel && i.status === "pending");
    if (!item) {
      return;
    }
    if (!item.deleted) {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      if (doc.isDirty) {
        await doc.save();
      }
    }
    item.status = "accepted";
    this._onReviewChange.fire({ kind: "update", path: rel, status: "accepted" });
    await this.advanceFrom(item);
  }

  async rejectFile(rel: string): Promise<void> {
    const item = this.items.find((i) => i.rel === rel && i.status === "pending");
    if (!item) {
      return;
    }
    await this.revert(item);
    item.status = "rejected";
    this._onReviewChange.fire({ kind: "update", path: rel, status: "rejected" });
    await this.advanceFrom(item);
  }

  /** Re-open the diff for a file (e.g., clicked in the panel list). */
  async showFile(rel: string): Promise<void> {
    const item = this.items.find((i) => i.rel === rel);
    if (item) {
      await this.openDiff(item);
      this._onReviewChange.fire({ kind: "navigated" });
    }
  }

  /** Accept all still-pending files at once. */
  async acceptAll(): Promise<void> {
    for (const item of this.items.filter((i) => i.status === "pending")) {
      if (!item.deleted) {
        const doc = await vscode.workspace.openTextDocument(item.uri);
        if (doc.isDirty) {
          await doc.save();
        }
      }
      item.status = "accepted";
      this._onReviewChange.fire({ kind: "update", path: item.rel, status: "accepted" });
      await this.closeDiffTab(item);
    }
    this._onReviewChange.fire({ kind: "done" });
  }

  /** Reject (revert) all still-pending files at once. */
  async rejectAll(): Promise<void> {
    for (const item of this.items.filter((i) => i.status === "pending")) {
      await this.revert(item);
      item.status = "rejected";
      this._onReviewChange.fire({ kind: "update", path: item.rel, status: "rejected" });
      await this.closeDiffTab(item);
    }
    this._onReviewChange.fire({ kind: "done" });
  }

  private async revert(item: ReviewItem): Promise<void> {
    if (item.deleted && item.original !== null) {
      const we = new vscode.WorkspaceEdit();
      we.createFile(item.uri, { ignoreIfExists: true });
      we.insert(item.uri, new vscode.Position(0, 0), item.original);
      await vscode.workspace.applyEdit(we);
      return;
    }
    if (item.original === null) {
      const we = new vscode.WorkspaceEdit();
      we.deleteFile(item.uri, { ignoreIfNotExists: true });
      await vscode.workspace.applyEdit(we);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(item.uri);
    await this.replaceWhole(doc, item.original);
    if (doc.isDirty) {
      await doc.save();
    }
  }
}
