type Listener<T> = (event: T) => unknown;

const files = new Map<string, string>();
const docs = new Map<string, TextDocument>();
const openedDiffs: Array<{ original: Uri; modified: Uri; title: string }> = [];
const shownDocs: Uri[] = [];
const errors: string[] = [];
let failOpenDiff = false;

export function resetVscodeMock(initialFiles: Record<string, string> = {}) {
  files.clear();
  docs.clear();
  openedDiffs.length = 0;
  shownDocs.length = 0;
  errors.length = 0;
  failOpenDiff = false;
  for (const [path, content] of Object.entries(initialFiles)) {
    files.set(path, content);
  }
}

export function setVscodeMockOpenDiffFailure(value: boolean) {
  failOpenDiff = value;
}

export function vscodeMockState() {
  return { files, docs, openedDiffs, shownDocs, errors };
}

export class Uri {
  constructor(public readonly scheme: string, public readonly fsPath: string, private readonly raw: string) {}

  static file(path: string): Uri {
    return new Uri("file", path, `file://${path}`);
  }

  static parse(value: string): Uri {
    const schemeEnd = value.indexOf(":");
    const scheme = schemeEnd >= 0 ? value.slice(0, schemeEnd) : "file";
    return new Uri(scheme, value, value);
  }

  toString(): string {
    return this.raw;
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

export class WorkspaceEdit {
  readonly edits: Array<
    | { kind: "createFile"; uri: Uri }
    | { kind: "deleteFile"; uri: Uri }
    | { kind: "insert"; uri: Uri; text: string }
    | { kind: "replace"; uri: Uri; text: string }
  > = [];

  createFile(uri: Uri): void {
    this.edits.push({ kind: "createFile", uri });
  }

  deleteFile(uri: Uri): void {
    this.edits.push({ kind: "deleteFile", uri });
  }

  insert(uri: Uri, _position: Position, text: string): void {
    this.edits.push({ kind: "insert", uri, text });
  }

  replace(uri: Uri, _range: Range, text: string): void {
    this.edits.push({ kind: "replace", uri, text });
  }
}

export class TextDocument {
  isDirty = false;

  constructor(public readonly uri: Uri, private text: string) {}

  getText(): string {
    return this.text;
  }

  lineAt(line: number) {
    const lines = this.text.split("\n");
    return { range: { end: new Position(line, lines[line]?.length ?? 0) } };
  }

  get lineCount(): number {
    return this.text.split("\n").length;
  }

  setText(text: string): void {
    this.text = text;
    this.isDirty = true;
  }

  async save(): Promise<boolean> {
    files.set(this.uri.fsPath, this.text);
    this.isDirty = false;
    return true;
  }
}

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  readonly event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };

  fire(event: T): void {
    this.listeners.forEach((listener) => listener(event));
  }

  dispose(): void {
    this.listeners = [];
  }
}

export class Disposable {
  static from(...items: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => items.forEach((item) => item.dispose()));
  }

  constructor(private readonly fn: () => void = () => {}) {}

  dispose(): void {
    this.fn();
  }
}

export class TabInputTextDiff {
  constructor(public readonly original: Uri, public readonly modified: Uri) {}
}

export class TabInputText {
  constructor(public readonly uri: Uri) {}
}

export const workspace = {
  registerTextDocumentContentProvider: () => new Disposable(),
  fs: {
    async stat(uri: Uri): Promise<void> {
      if (!files.has(uri.fsPath)) {
        throw new Error("not found");
      }
    },
  },
  async openTextDocument(uri: Uri): Promise<TextDocument> {
    if (docs.has(uri.toString())) {
      return docs.get(uri.toString())!;
    }
    const doc = new TextDocument(uri, files.get(uri.fsPath) ?? "");
    docs.set(uri.toString(), doc);
    return doc;
  },
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    for (const item of edit.edits) {
      if (item.kind === "createFile") {
        files.set(item.uri.fsPath, "");
        continue;
      }
      if (item.kind === "deleteFile") {
        files.delete(item.uri.fsPath);
        docs.delete(item.uri.toString());
        continue;
      }
      const doc = await workspace.openTextDocument(item.uri);
      const next = item.kind === "insert" ? doc.getText() + item.text : item.text;
      doc.setText(next);
    }
    return true;
  },
};

export const window = {
  tabGroups: {
    all: [],
    async close(): Promise<void> {},
  },
  showErrorMessage(message: string): void {
    errors.push(message);
  },
  async showTextDocument(doc: TextDocument): Promise<void> {
    shownDocs.push(doc.uri);
  },
};

export const commands = {
  async executeCommand(command: string, original: Uri, modified: Uri, title: string): Promise<void> {
    if (command === "vscode.diff") {
      if (failOpenDiff) {
        throw new Error("diff failed");
      }
      openedDiffs.push({ original, modified, title });
    }
  },
};
