import * as path from 'path';
import * as vscode from 'vscode';
import { askClaude } from '../claudeBridge';
import {
    getSourceChain,
    filterLocationsByFile,
    formatMentions,
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
                    await syncClaudeContext(_currentSelection);
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

function detectSidebarVisible(): boolean {
    for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
            if (tab.label.includes('Claude Code')) {
                return true;
            }
        }
    }
    return false;
}

function detectCliTerminal(): vscode.Terminal | undefined {
    for (const terminal of vscode.window.terminals) {
        if (terminal.name.toLowerCase().includes('claude')) {
            return terminal;
        }
    }
    return undefined;
}

async function injectViaSidebar(
    locations: SourceLocation[]
): Promise<void> {
    const text = formatMentions(locations);
    if (!text) return;
    await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', null, text);
}

async function injectViaTerminal(
    terminal: vscode.Terminal,
    locations: SourceLocation[]
): Promise<void> {
    const text = formatMentions(locations);
    if (!text) return;
    terminal.show();
    terminal.sendText(text);
}

async function syncClaudeContext(
    components: ComponentSelection[]
): Promise<void> {
    if (components.length === 0) {
        if (detectSidebarVisible()) {
            await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', null, '');
        }
        return;
    }

    const allLocations = components.flatMap(getSourceChain);
    if (allLocations.length === 0) return;

    const primaryFile = allLocations[0].file;
    const fileLocations = filterLocationsByFile(
        allLocations,
        primaryFile,
        resolveWorkspacePath
    );

    if (detectSidebarVisible()) {
        await injectViaSidebar(fileLocations);
        return;
    }

    const terminal = detectCliTerminal();
    if (terminal) {
        await injectViaTerminal(terminal, fileLocations);
        return;
    }
}

async function openSourceFile(filePath: string, line?: number): Promise<void> {
    const resolved = resolveWorkspacePath(filePath);
    const fullPath = vscode.Uri.file(resolved);
    try {
        const doc = await vscode.workspace.openTextDocument(fullPath);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        if (line != null && line > 0) {
            const range = lineToRange(doc, line);
            if (range) {
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.setDecorations(_sourceHighlight, [range]);
            }
        }
    } catch {
        vscode.window.showErrorMessage(`File not found: ${filePath}`);
    }
}

function resolveWorkspacePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
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
