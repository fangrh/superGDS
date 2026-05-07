import * as vscode from 'vscode';
import { askClaude } from '../claudeBridge';
import {
    getSourceChain,
    type ComponentSelection,
    type SourceLocation,
} from './provenance';

export function registerMessageHandlers(
    panel: vscode.WebviewPanel
): vscode.Disposable {
    return panel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.type) {
                case 'selectComponents':
                    _currentSelection = message.components as ComponentSelection[];
                    highlightOpenSourceLocations(_currentSelection);
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
const _sourceHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
    isWholeLine: true,
});

function highlightOpenSourceLocations(components: ComponentSelection[]): void {
    const locations = components.flatMap(getSourceChain);
    const byFile = new Map<string, SourceLocation[]>();

    for (const location of locations) {
        const key = normalizePath(resolveWorkspacePath(location.file));
        const existing = byFile.get(key) || [];
        existing.push(location);
        byFile.set(key, existing);
    }

    for (const editor of vscode.window.visibleTextEditors) {
        const editorPath = normalizePath(editor.document.uri.fsPath);
        const fileLocations = byFile.get(editorPath) || [];
        const ranges = fileLocations
            .map((location) => lineToRange(editor.document, location.line))
            .filter((range): range is vscode.Range => range !== undefined);
        editor.setDecorations(_sourceHighlight, ranges);
    }
}

async function openSourceFile(filePath: string, line?: number): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) return;

    const fullPath = vscode.Uri.file(resolveWorkspacePath(filePath));
    try {
        const doc = await vscode.workspace.openTextDocument(fullPath);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        if (line && line > 0) {
            const range = lineToRange(doc, line);
            if (range) {
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                editor.selection = new vscode.Selection(range.start, range.start);
                editor.setDecorations(_sourceHighlight, [range]);
            }
        }
    } catch {
        vscode.window.showErrorMessage(`File not found: ${filePath}`);
    }
}

function resolveWorkspacePath(filePath: string): string {
    if (vscode.Uri.file(filePath).fsPath === filePath && filePath.startsWith('/')) {
        return filePath;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return workspaceRoot ? vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), filePath).fsPath : filePath;
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function lineToRange(document: vscode.TextDocument, line: number): vscode.Range | undefined {
    const index = line - 1;
    if (!Number.isInteger(index) || index < 0 || index >= document.lineCount) {
        return undefined;
    }

    return document.lineAt(index).range;
}
