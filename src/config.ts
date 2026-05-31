import * as vscode from "vscode";
import * as path from "path";
import { EvlampyConfig } from "./types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

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
export function configFilePath(): string {
  const setting =
    vscode.workspace.getConfiguration("evlampy").get<string>("configPath") ||
    ".evlampy/config.json";
  if (path.isAbsolute(setting)) {
    return setting;
  }
  const root = workspaceRoot();
  if (!root) {
    throw new ConfigError("No workspace folder is open.");
  }
  return path.join(root, setting);
}

/** Read + validate the config. Throws ConfigError with a friendly message. */
export async function loadConfig(): Promise<EvlampyConfig> {
  const file = configFilePath();
  const uri = vscode.Uri.file(file);

  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    // Creating a config file if it doesn't exist
    await ensureConfigScaffold(false);
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const raw = Buffer.from(bytes).toString("utf8");

  let parsed: Partial<EvlampyConfig>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Config is not valid JSON: ${(e as Error).message}`);
  }

  const apiKey = interpolateEnv(parsed.apiKey ?? "").trim();
  if (!apiKey) {
    throw new ConfigError('Config is missing "apiKey" (or the referenced env var is empty).');
  }
  const models = parsed.models ?? [];
  if (!Array.isArray(models) || models.length === 0) {
    throw new ConfigError('Config must list at least one model in "models".');
  }

  return {
    userSystemPromptPath: parsed.userSystemPromptPath,
    baseURL: parsed.baseURL?.trim() || DEFAULT_BASE_URL,
    apiKey,
    models,
    defaultModel: parsed.defaultModel || models[0],
    serviceTier: parsed.serviceTier,
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
  "userSystemPromptPath": "AGENTS.md",
  "baseURL": "https://openrouter.ai/api/v1",
  "apiKey": "\${env:EVLAMPY_API_KEY}",
  "models": ["qwen/qwen3-coder-flash"],
  "defaultModel": "qwen/qwen3-coder-flash",
  "serviceTier": "flex"
}
`;

/** Create a starter config if it doest't exist. Open the config if needed. */
export async function ensureConfigScaffold(openConfig = true): Promise<void> {
  const file = configFilePath();
  const uri = vscode.Uri.file(file);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    // Create .evlampy directory, if there is none
    const dir = path.dirname(file);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(SAMPLE_CONFIG, "utf8"));
  }
  if (openConfig) {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }
}
