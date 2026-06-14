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
  ReviewState,
  ReviewStatus,
} from "./types";
import { findMatch } from "./matcher";
import { stripPlaceholders } from "./parser";
import { ReviewSession } from "./ReviewSession";

const ORIG_SCHEME = "evlampy-orig";

interface ReviewItem {
  rel: string;
  uri: vscode.Uri;
  /** Original on-disk content; null if the file was newly created. */
  original: string | null;
  /** Proposed content after applying the suggestion; null for deleted files. */
  proposed: string | null;
  /** True if the op deleted the file (already removed from disk). */
  deleted: boolean;
  /** Virtual URI holding the original content for the left side of the diff. */
  origUri: vscode.Uri;
  status: ReviewStatus;
  detail: string;
}

interface ReviewChange {
  rel: string;
  uri: vscode.Uri;
  /** Content before the first successful suggestion for this file. */
  original: string | null;
  /** Final content after all successful suggestions for this file. */
  proposed: string | null;
  deleted: boolean;
  details: string[];
}

/**
 * Applies diff ops (leaving documents dirty) and drives per-file review.
 * ReviewSession owns the current file; editor tabs only project that state.
 */
export class DiffManager implements vscode.TextDocumentContentProvider {
  private items: ReviewItem[] = [];
  private originals = new Map<string, string>();
  /** Review flow SSOT; editor tabs only display the current item. */
  private review = new ReviewSession();
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

  /** Applies the full suggestion batch, then builds one review item per changed file. */
  async apply(ops: DiffOp[]): Promise<ApplyReport> {
    this.items = [];
    this.originals.clear();
    this.review.reset();
    this.emitReviewState();

    const report: ApplyResultItem[] = [];
    const changes = new Map<string, ReviewChange>();
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex];
      try {
        report.push(await this.applyOne(op, opIndex, changes));
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
    this.items = this.buildReviewItems(changes);

    if (this.items.length > 0) {
      this.review.start(this.reviewFiles());
      this.emitReviewState();
      await this.tryOpenCurrent();
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

  /** Routes a single parsed diff op to the matching applier. */
  private async applyOne(
    op: DiffOp,
    opIndex: number,
    changes: Map<string, ReviewChange>
  ): Promise<ApplyResultItem> {
    switch (op.kind) {
      case "new":
        return this.applyNew(op.path, op.content, opIndex, changes);
      case "rewrite":
        return this.applyRewrite(op.path, op.content, opIndex, changes);
      case "edit":
        return this.applyEdit(op.path, op.hunks, opIndex, changes);
      case "delete":
        return this.applyDelete(op.path, opIndex, changes);
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

  /** Creates a new file and records it as a per-file review change. */
  private async applyNew(
    rel: string,
    content: string,
    opIndex: number,
    changes: Map<string, ReviewChange>
  ): Promise<ApplyResultItem> {
    const uri = this.resolve(rel);
    if (await this.exists(uri)) {
      return this.applyRewrite(rel, content, opIndex, changes);
    }
    const we = new vscode.WorkspaceEdit();
    we.createFile(uri, { ignoreIfExists: true });
    we.insert(uri, new vscode.Position(0, 0), content);
    await vscode.workspace.applyEdit(we);
    this.recordChange(changes, rel, uri, null, content, false, "new file");
    return { path: rel, ok: true, detail: "new file", kind: "new", opIndex };
  }

  /** Replaces an existing file and records the final proposed content for review. */
  private async applyRewrite(
    rel: string,
    content: string,
    opIndex: number,
    changes: Map<string, ReviewChange>
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
    this.recordChange(changes, rel, uri, original, content, false, "rewritten");
    return { path: rel, ok: true, detail: "rewritten", kind: "rewrite", opIndex };
  }

  /** Applies search/replace hunks to the current document text and records the resulting proposal. */
  private async applyEdit(
    rel: string,
    hunks: Hunk[],
    opIndex: number,
    changes: Map<string, ReviewChange>
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
      this.recordChange(changes, rel, uri, original, newText, false, detail);
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

  /** Deletes an existing file and records the deletion for review/reject restore. */
  private async applyDelete(
    rel: string,
    opIndex: number,
    changes: Map<string, ReviewChange>
  ): Promise<ApplyResultItem> {
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
    this.recordChange(changes, rel, uri, original, null, true, "deleted");
    return {
      path: rel,
      ok: true,
      detail: "deleted (reject to restore)",
      kind: "delete",
      opIndex,
    };
  }

  private recordChange(
    changes: Map<string, ReviewChange>,
    rel: string,
    uri: vscode.Uri,
    original: string | null,
    proposed: string | null,
    deleted: boolean,
    detail: string
  ): void {
    const existing = changes.get(uri.fsPath);
    if (existing) {
      existing.proposed = proposed;
      existing.deleted = deleted;
      existing.details.push(detail);
      return;
    }

    changes.set(uri.fsPath, {
      rel,
      uri,
      original,
      proposed,
      deleted,
      details: [detail],
    });
  }

  /** Converts per-file accumulated changes into review items after the whole batch is applied. */
  private buildReviewItems(changes: Map<string, ReviewChange>): ReviewItem[] {
    const items: ReviewItem[] = [];
    for (const change of changes.values()) {
      // Skip changes that cancel themselves out before review starts.
      if (!change.deleted && change.original === change.proposed) {
        continue;
      }
      // A file created and then deleted in the same batch leaves nothing to review.
      if (change.deleted && change.original === null) {
        continue;
      }

      // Each review item needs a stable virtual "original" document for the left side of the VS Code diff.
      const origUri = vscode.Uri.parse(`${ORIG_SCHEME}:${change.rel}?v=${this.counter++}`);
      this.originals.set(origUri.toString(), change.original ?? "");
      items.push({
        rel: change.rel,
        uri: change.uri,
        original: change.original,
        proposed: change.proposed,
        deleted: change.deleted,
        origUri,
        status: "pending",
        detail: change.details.join("; "),
      });
    }
    return items;
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

  // ---- Navigation ----

  private async openCurrent(): Promise<void> {
    const current = this.review.currentRel();
    const next = current
      ? this.items.find((i) => i.rel === current && i.status === "pending")
      : undefined;
    if (next) {
      await this.openDiff(next);
    }
  }

  private async tryOpenCurrent(): Promise<void> {
    try {
      await this.openCurrent();
    } catch (e) {
      vscode.window.showErrorMessage(`Evlampy: failed to open review diff: ${(e as Error).message}`);
    }
  }

  private async advanceFrom(decided: ReviewItem): Promise<void> {
    await this.closeDiffTab(decided);
    await this.tryOpenCurrent();
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

  reviewState(): ReviewState {
    return this.review.snapshot();
  }

  isReviewActive(): boolean {
    return this.review.isActive();
  }

  currentReviewRel(): string | undefined {
    return this.review.currentRel();
  }

  canShowPreviousFile(): boolean {
    return this.review.canSelectPreviousPending();
  }

  canShowNextFile(): boolean {
    return this.review.canSelectNextPending();
  }

  async showPreviousFile(): Promise<void> {
    if (!this.canShowPreviousFile()) {
      return;
    }
    this.review.moveCurrent(-1);
    this.emitReviewState();
    await this.tryOpenCurrent();
  }

  async showNextFile(): Promise<void> {
    if (!this.canShowNextFile()) {
      return;
    }
    this.review.moveCurrent(1);
    this.emitReviewState();
    await this.tryOpenCurrent();
  }

  async acceptCurrentFile(): Promise<void> {
    const rel = this.review.currentRel();
    if (rel) {
      await this.acceptFile(rel);
    }
  }

  async rejectCurrentFile(): Promise<void> {
    const rel = this.review.currentRel();
    if (rel) {
      await this.rejectFile(rel);
    }
  }

  async acceptFile(rel: string): Promise<void> {
    const item = this.items.find((i) => i.rel === rel && i.status === "pending");
    if (!item) {
      return;
    }
    const detail = await this.acceptDetail(item);
    if (!item.deleted) {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      if (doc.isDirty) {
        await doc.save();
      }
    }
    item.status = "accepted";
    item.detail = detail;
    this.review.decide(rel, "accepted", detail);
    this.emitReviewState();
    await this.advanceFrom(item);
  }

  async rejectFile(rel: string): Promise<void> {
    const item = this.items.find((i) => i.rel === rel && i.status === "pending");
    if (!item) {
      return;
    }
    await this.revert(item);
    item.status = "rejected";
    item.detail = "rejected";
    this.review.decide(rel, "rejected", "REJECTED (rolled back to source)");
    this.emitReviewState();
    await this.advanceFrom(item);
  }

  /** Re-open the diff for a file (e.g., clicked in the panel list). */
  async showFile(rel: string): Promise<void> {
    const item = this.items.find((i) => i.rel === rel && i.status === "pending");
    if (item) {
      this.review.setCurrent(rel);
      this.emitReviewState();
      await this.openDiff(item);
    }
  }

  /** Accept all still-pending files at once. */
  async acceptAll(): Promise<void> {
    for (const item of this.items.filter((i) => i.status === "pending")) {
      const detail = await this.acceptDetail(item);
      if (!item.deleted) {
        const doc = await vscode.workspace.openTextDocument(item.uri);
        if (doc.isDirty) {
          await doc.save();
        }
      }
      item.status = "accepted";
      item.detail = detail;
      this.review.decide(item.rel, "accepted", detail);
      await this.closeDiffTab(item);
    }
    this.emitReviewState();
  }

  /** Reject (revert) all still-pending files at once. */
  async rejectAll(): Promise<void> {
    for (const item of this.items.filter((i) => i.status === "pending")) {
      await this.revert(item);
      item.status = "rejected";
      item.detail = "rejected";
      await this.closeDiffTab(item);
    }
    this.review.decideAll("rejected", "rejected");
    this.emitReviewState();
  }

  /** Push the full review state after every transition. */
  private emitReviewState(): void {
    this._onReviewChange.fire({ kind: "state", state: this.review.snapshot() });
  }

  private async acceptDetail(item: ReviewItem): Promise<string> {
    if (item.deleted) {
      return "accepted deletion";
    }
    if (item.proposed === null) {
      return "accepted";
    }

    const doc = await vscode.workspace.openTextDocument(item.uri);
    return doc.getText() === item.proposed ? "accepted" : "accepted after manual edits";
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
