import * as vscode from "vscode";
import { EcoSidebarProvider } from "./webview-provider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new EcoSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EcoSidebarProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const openPanelCommand = vscode.commands.registerCommand("eco.openPanel", () => {
    vscode.commands.executeCommand("eco.sidebarView.focus");
  });

  const scanCommand = vscode.commands.registerCommand("eco.scanWorkspace", () => {
    vscode.commands.executeCommand("eco.sidebarView.focus");
    provider.startScan();
  });

  context.subscriptions.push(openPanelCommand, scanCommand);
}

export function deactivate() {}
