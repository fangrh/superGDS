import * as vscode from 'vscode';
import { getForkStatus } from '../forkDetector';

let _panel: vscode.WebviewPanel | null = null;

export function getOrCreatePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
    if (_panel) {
        _panel.reveal(vscode.ViewColumn.Beside);
        return _panel;
    }

    _panel = vscode.window.createWebviewPanel(
        'supergds.viewer',
        'GDS Viewer',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media')
            ],
        }
    );

    _panel.onDidDispose(() => {
        _panel = null;
    });

    return _panel;
}

export function getPanel(): vscode.WebviewPanel | null {
    return _panel;
}
