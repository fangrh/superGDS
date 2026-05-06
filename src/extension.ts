import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('superGDS extension activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('supergds.showGdsViewer', () => {
            vscode.window.showInformationMessage('superGDS: Show GDS Viewer');
        })
    );
}

export function deactivate() {}
