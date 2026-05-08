import * as path from 'path';
import * as vscode from 'vscode';
import { askClaude } from '../claudeBridge';
import { deleteAnnotation, saveAnnotation, type DrawnShapePayload } from '../annotations';
import {
    getSourceChain,
    getSelectionSourceLocations,
    formatMentions,
    formatSourceLocationIndexLabel,
    type ComponentSelection,
    type SourceLocation,
} from './provenance';

type ClaudeMode = 'auto' | 'clipboard' | 'off';

export function registerMessageHandlers(
    panel: vscode.WebviewPanel
): vscode.Disposable {
    return panel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.type) {
                case 'selectComponents':
                    _currentSelection = message.components as ComponentSelection[];
                    highlightOpenSourceLocations(_currentSelection);
                    await syncClaudeContext(_currentSelection, message.claudeMode as ClaudeMode);
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

                case 'viewerContext':
                    _currentPythonFile = String(message.pythonFile || '');
                    break;

                case 'saveAnnotation': {
                    if (!_currentPythonFile) {
                        vscode.window.showErrorMessage('Cannot save annotation: no Python source file is active.');
                        break;
                    }
                    const saved = saveAnnotation(_currentPythonFile, message.shape as DrawnShapePayload);
                    panel.webview.postMessage({
                        type: 'annotationSaved',
                        clientId: message.clientId,
                        annotation: saved,
                    });
                    break;
                }

                case 'deleteAnnotation': {
                    const jsonPath = String(message.jsonPath || '');
                    if (jsonPath) {
                        deleteAnnotation(jsonPath);
                    }
                    break;
                }

                case 'rebuild': {
                    if (!_currentPythonFile) {
                        panel.webview.postMessage({ type: 'rebuildError', error: 'No Python file is active.' });
                        break;
                    }
                    // Dynamic import to avoid circular dependency (extension.ts → provider.ts → extension.ts)
                    const { rebuildAndReload } = await import('../extension');
                    await rebuildAndReload(_currentPythonFile);
                    break;
                }

            }
        },
        undefined,
        []
    );
}

let _currentSelection: ComponentSelection[] = [];
let _currentPythonFile = '';

export function setCurrentPythonFile(pythonFile: string): void {
    _currentPythonFile = pythonFile;
}
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
): Promise<boolean> {
    const text = formatClaudeChatMentions(locations);
    if (!text) return false;

    await vscode.env.clipboard.writeText(text);

    const editor = vscode.window.activeTextEditor;
    if (!editor) return false;

    const editorPath = normalizePath(editor.document.uri.fsPath);
    const targetPath = normalizePath(resolveWorkspacePath(locations[0].file));
    if (editorPath !== targetPath) return false;

    const sameFileLocations = locations.filter(
        (loc) => normalizePath(resolveWorkspacePath(loc.file)) === editorPath
    );
    const range = locationsToSelectionRange(editor.document, sameFileLocations);
    if (!range) return false;

    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    return true;
}

async function injectClipboardOnly(
    components: ComponentSelection[]
): Promise<void> {
    // Build per-component mention lines so each selected component appears
    // in the clipboard, even if multiple components share the same file:line.
    const lines: string[] = [];
    for (const component of components) {
        const locations = getSourceChain(component);
        if (locations.length === 0) continue;
        const primary = locations[0];
        let mention = `@${toWorkspaceRelativePath(primary.file)}#L${primary.line}${formatSourceLocationIndexLabel(primary)}`;
        for (let i = 1; i < locations.length; i++) {
            mention += ` <- @${toWorkspaceRelativePath(locations[i].file)}:${locations[i].line}`;
        }
        lines.push(mention);
    }

    if (lines.length === 0) return;
    const text = lines.join('\n');

    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Claude mentions copied to clipboard');
}

async function injectViaTerminal(
    terminal: vscode.Terminal,
    locations: SourceLocation[]
): Promise<void> {
    const text = formatMentions(locations, toWorkspaceRelativePath);
    if (!text) return;
    terminal.show();
    await delay(50);
    await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
        text: '\u0001\u000b',
    });
    terminal.sendText(text, false);
}

async function syncClaudeContext(
    components: ComponentSelection[],
    mode: ClaudeMode = 'auto'
): Promise<void> {
    if (components.length === 0) {
        return;
    }

    const allLocations = getSelectionSourceLocations(components);
    if (allLocations.length === 0) return;

    if (mode === 'off') return;

    if (mode === 'clipboard') {
        await injectClipboardOnly(components);
        return;
    }

    // mode === 'auto'
    const terminal = detectCliTerminal();
    if (terminal) {
        await injectViaTerminal(terminal, allLocations);
        return;
    }

    await injectViaSidebar(allLocations);
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

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toWorkspaceRelativePath(filePath: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        return normalizePath(filePath);
    }

    const resolved = resolveWorkspacePath(filePath);
    const relative = path.relative(workspaceRoot, resolved);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return normalizePath(relative);
    }

    return normalizePath(filePath);
}

function formatClaudeChatMentions(locations: SourceLocation[]): string {
    return locations
        .map((loc) => `@${toWorkspaceRelativePath(loc.file)}#L${loc.line}${formatSourceLocationIndexLabel(loc)}`)
        .join(' ');
}

function locationsToSelectionRange(
    document: vscode.TextDocument,
    locations: SourceLocation[]
): vscode.Range | undefined {
    const ranges = locations
        .map((location) => lineToRange(document, location.line))
        .filter((range): range is vscode.Range => range !== undefined);
    if (ranges.length === 0) return undefined;

    const start = ranges.reduce((earliest, range) =>
        range.start.isBefore(earliest) ? range.start : earliest,
        ranges[0].start
    );
    const end = ranges.reduce((latest, range) =>
        range.end.isAfter(latest) ? range.end : latest,
        ranges[0].end
    );

    return new vscode.Range(start, end);
}

function lineToRange(document: vscode.TextDocument, line: number): vscode.Range | undefined {
    const index = line - 1;
    if (!Number.isInteger(index) || index < 0 || index >= document.lineCount) {
        return undefined;
    }

    return document.lineAt(index).range;
}
