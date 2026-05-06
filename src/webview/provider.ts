import * as vscode from 'vscode';
import { askClaude } from '../claudeBridge';

interface ComponentSelection {
    provId: string;
    layer: string;
    bbox: number[];
    provenance: Record<string, any>;
}

export function registerMessageHandlers(
    panel: vscode.WebviewPanel
): vscode.Disposable {
    return panel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.type) {
                case 'selectComponents':
                    _currentSelection = message.components as ComponentSelection[];
                    break;

                case 'askClaude': {
                    const components = (message.components as ComponentSelection[]) || _currentSelection || [];
                    const question = message.question || '';
                    if (components.length > 0 && question) {
                        const provData = components.map(c => ({
                            ...c.provenance,
                            layer: c.layer,
                            bbox: c.bbox,
                        }));
                        await askClaude(provData, question);
                    }
                    break;
                }

                case 'exportYaml': {
                    const yaml = message.yaml as string;
                    await vscode.env.clipboard.writeText(yaml);
                    vscode.window.showInformationMessage('YAML copied to clipboard');
                    break;
                }

                case 'requestSource': {
                    const { file, line } = message;
                    if (file) {
                        await openSourceFile(file, line);
                    }
                    break;
                }

                case 'drawShape': {
                    console.log('GDS Viewer: shape drawn', message.geometry);
                    break;
                }
            }
        },
        undefined,
        []
    );
}

let _currentSelection: ComponentSelection[] = [];

async function openSourceFile(filePath: string, line?: number): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) return;

    const fullPath = vscode.Uri.joinPath(workspaceRoot, filePath);
    try {
        const doc = await vscode.workspace.openTextDocument(fullPath);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        if (line && line > 0) {
            const position = new vscode.Position(line - 1, 0);
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
            );
            editor.selection = new vscode.Selection(position, position);
        }
    } catch {
        vscode.window.showErrorMessage(`File not found: ${filePath}`);
    }
}
