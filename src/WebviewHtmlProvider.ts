import * as vscode from "vscode";
import * as crypto from "crypto";

// Isolates the logic for generating initial HTML for the Webview.
// Returns strictly valid HTML with configured CSP and bound resources.
export class WebviewHtmlProvider {

  public static getHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "style.css")
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "images", "icon.png")
    );
    
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Evlampy</title>
</head>
<body>
  <div id="welcome">
    <img src="${iconUri}" alt="Evlampy" class="welcome-icon" />
    <div class="welcome-title">Evlampy</div>
    <div class="welcome-tagline">One request, one response. No agentic loop.</div>
    <div class="welcome-text">
      <ul class="welcome-list">
        <li>Run <code>Evlampy: Open Global Config</code> to set your API key and other settings</li>
        <li>Run <code>Evlampy: Override config for project</code> to override defaults</li>
        <li>Define global rules in <code>AGENTS.md</code></li>
      </ul>
    </div>
  </div>
  <div id="messages"></div>
  <div id="attachmentBar">
    <div id="attachments"></div>
  </div>
  <div id="suggestions" class="hidden"></div>
  <div id="composer">
    <textarea id="input" rows="3" placeholder="Ask…  (@ to attach a file / entire folder, ⌘/Ctrl+I to add the open file/selection)"></textarea>
    <div id="controls">
      <div class="selectors">
        <select id="model" title="Model"></select>
        <select id="effort" title="Effort"></select>
      </div>
      <span id="cost" class="cost"></span>
      <button id="send" title="Send (Enter)">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
