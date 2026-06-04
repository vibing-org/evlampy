import * as vscode from "vscode";
import * as path from "path";
import { EvlampyConfig } from "./types";

export class ConfigError extends Error { }

/** Resolve ${env:VAR} references inside a string. */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
    return process.env[name] ?? "";
  });
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Absolute path to the config file, honoring the evlampy.configPath setting. */
export function configFilePath(): string | undefined {
  const setting =
    vscode.workspace.getConfiguration("evlampy").get<string>("configPath") ||
    ".evlampy/config.json";
  if (path.isAbsolute(setting)) {
    return setting;
  }
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }
  return path.join(root, setting);
}

/** Read + validate the config. Throws ConfigError with a friendly message. */
export async function loadConfig(): Promise<EvlampyConfig> {
  const vsConfig = vscode.workspace.getConfiguration("evlampy");
  
  let config: Partial<EvlampyConfig> = {
    userSystemPromptPath: vsConfig.get<string>("userSystemPromptPath"),
    baseURL: vsConfig.get<string>("baseURL"),
    apiKey: vsConfig.get<string>("apiKey"),
    models: vsConfig.get<string[]>("models"),
    serviceTier: vsConfig.get<string>("serviceTier"),
  };

  const file = configFilePath();
  if (file) {
    const uri = vscode.Uri.file(file);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.File) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = Buffer.from(bytes).toString("utf8");
        const parsed = JSON.parse(raw);
        config = { ...config, ...parsed };
      }
    } catch {
      // Ignore if local config doesn't exist or is invalid
    }
  }

  const apiKey = interpolateEnv(config.apiKey ?? "").trim();
  const models = config.models ?? [];

  return {
    userSystemPromptPath: config.userSystemPromptPath,
    baseURL: config.baseURL?.trim() ?? "",
    apiKey,
    models,
    serviceTier: config.serviceTier,
  };
}

/** Read the user system prompt file, or "" if none/unreadable. */
export async function loadUserSystemPrompt(cfg: EvlampyConfig): Promise<string> {
  const root = workspaceRoot();
  if (!root || !cfg.userSystemPromptPath) {
    return "";
  }
  let file = cfg.userSystemPromptPath;
  if (!path.isAbsolute(file)) {
    file = path.join(root, file);
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    return Buffer.from(bytes).toString("utf8").trim();
  } catch {
    return "";
  }
}

const SAMPLE_CONFIG = `{
  // This file overrides VS Code global settings for Evlampy.
  // You can define project-specific settings here.
  "userSystemPromptPath": "AGENTS.md"
  // "baseURL": "https://openrouter.ai/api/v1",
  // "apiKey": "\${env:EVLAMPY_API_KEY}",
  // "models": ["openai/gpt-5.5"],
  // "serviceTier": "flex"
}
`;

/** Create a starter config if it doesn't exist. Open the config. */
export async function overrideConfigForProject(): Promise<void> {
  const file = configFilePath();
  if (!file) {
    throw new ConfigError("No workspace folder is open.");
  }
  const uri = vscode.Uri.file(file);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const dir = path.dirname(file);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(SAMPLE_CONFIG, "utf8"));
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}
