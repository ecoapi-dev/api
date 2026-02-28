import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { scanWorkspace } from "./scanner/workspace-scanner";
import { analyzeApiCalls } from "./analysis/analysis-service";
import { streamChatResponse } from "./chat/openai-client";
import type { WebviewMessage, HostMessage, SuggestionContext } from "./messages";
import type { EndpointRecord, Suggestion, ScanSummary } from "./analysis/types";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export class EcoSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "eco.sidebarView";

  private _view?: vscode.WebviewView;
  private readonly extensionUri: vscode.Uri;

  // State
  private lastEndpoints: EndpointRecord[] = [];
  private lastSuggestions: Suggestion[] = [];
  private lastSummary: ScanSummary | null = null;
  private chatHistory: ChatMessage[] = [];
  private chatContext: SuggestionContext | null = null;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message)
    );
  }

  public startScan() {
    this._view?.webview.postMessage({ type: "triggerScan" } as HostMessage);
  }

  private postMessage(message: HostMessage) {
    this._view?.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case "startScan":
        await this.handleStartScan();
        break;
      case "chatMessage":
        if (message.context) {
          this.chatContext = message.context;
        }
        await this.handleChatMessage(message.text, message.context ?? this.chatContext);
        break;
      case "applyFix":
        await this.handleApplyFix(message.code, message.file);
        break;
      case "openFile":
        await this.handleOpenFile(message.file, message.line);
        break;
    }
  }

  private async handleStartScan() {
    try {
      this.chatHistory = [];
      this.chatContext = null;

      const apiCalls = await scanWorkspace((progress) => {
        this.postMessage({
          type: "scanProgress",
          file: progress.file,
          index: progress.index,
          total: progress.total,
          endpointsSoFar: progress.endpointsSoFar,
        });
      });

      this.postMessage({ type: "scanComplete" });

      if (apiCalls.length === 0) {
        this.postMessage({
          type: "scanResults",
          endpoints: [],
          suggestions: [],
          summary: {
            totalEndpoints: 0,
            totalCallsPerDay: 0,
            totalMonthlyCost: 0,
            highRiskCount: 0,
          },
        });
        return;
      }

      const projectId = randomUUID();
      const scanId = randomUUID();
      const result = analyzeApiCalls(projectId, scanId, apiCalls);

      this.lastEndpoints = result.endpoints;
      this.lastSuggestions = result.suggestions;
      this.lastSummary = result.summary;

      this.postMessage({
        type: "scanResults",
        endpoints: result.endpoints,
        suggestions: result.suggestions,
        summary: result.summary,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error during scan";
      this.postMessage({ type: "error", message });
    }
  }

  private async handleChatMessage(text: string, context: SuggestionContext | null) {
    const config = vscode.workspace.getConfiguration("eco");
    let apiKey = config.get<string>("openaiApiKey", "");

    if (!apiKey) {
      apiKey = await vscode.window.showInputBox({
        prompt: "Enter your OpenAI API key",
        password: true,
        placeHolder: "sk-...",
      }) ?? "";

      if (!apiKey) {
        this.postMessage({ type: "error", message: "OpenAI API key is required for chat." });
        return;
      }

      await config.update("openaiApiKey", apiKey, vscode.ConfigurationTarget.Global);
    }

    const model = config.get<string>("openaiModel", "gpt-4o-mini");

    // Read affected files for context
    const fileContents = new Map<string, string>();
    if (context?.files) {
      for (const file of context.files.slice(0, 3)) {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (workspaceFolder) {
            const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file);
            const content = await vscode.workspace.fs.readFile(fileUri);
            fileContents.set(file, Buffer.from(content).toString("utf-8"));
          }
        } catch {
          // File not found, skip
        }
      }
    }

    try {
      let fullContent = "";
      const stream = streamChatResponse(
        apiKey,
        model,
        context,
        fileContents,
        text,
        this.chatHistory
      );

      for await (const chunk of stream) {
        fullContent += chunk;
        this.postMessage({ type: "chatStreaming", chunk });
      }

      this.postMessage({ type: "chatDone", fullContent });

      this.chatHistory.push({ role: "user", content: text });
      this.chatHistory.push({ role: "assistant", content: fullContent });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Chat request failed";
      this.postMessage({ type: "error", message });
    }
  }

  private async handleApplyFix(code: string, file: string) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc);

      const position = editor.selection.active;
      await editor.edit((editBuilder) => {
        editBuilder.insert(position, code);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to apply fix";
      vscode.window.showErrorMessage(`ECO: ${message}`);
    }
  }

  private async handleOpenFile(file: string, line?: number) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const selection = line
        ? new vscode.Range(line - 1, 0, line - 1, 0)
        : undefined;
      await vscode.window.showTextDocument(doc, {
        selection,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch {
      // File not found
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.css"));

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>ECO</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
