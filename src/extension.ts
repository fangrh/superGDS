import * as vscode from 'vscode';
import { detectForkStatus, getForkStatus } from './forkDetector';
import { findGdsOutput, getCurrentGdsPath, clearGdsState } from './gdsWatcher';
import { parseGdsFile, runPythonFile, initPythonBridge } from './pythonBridge';
import { loadAnnotationsForPythonFile } from './annotations';
import { getOrCreatePanel } from './webview/panel';
import { registerMessageHandlers, setCurrentPythonFile } from './webview/provider';

let _context: vscode.ExtensionContext | undefined;

/**
 * Re-run the Python script, re-parse the GDS output, and send fresh
 * data to the webview.  Used by both the showGdsViewer command and
 * the rebuild message handler.
 *
 * Returns `true` on success, `false` on failure (error shown to user).
 */
export async function rebuildAndReload(pythonFile: string): Promise<boolean> {
    if (!_context) return false;

    const panel = getOrCreatePanel(_context);
    registerMessageHandlers(panel);
    setCurrentPythonFile(pythonFile);

    // Clear cached GDS path so we always re-discover after rebuild
    clearGdsState();

    const beforeTime = new Date();

    // 1. Run the Python script
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Building GDS...',
                cancellable: false,
            },
            async () => {
                const result = await runPythonFile(pythonFile);
                if (result.exitCode !== 0) {
                    const msg = result.stderr || result.stdout || 'Build failed with unknown error';
                    throw new Error(msg);
                }
            }
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`Build failed: ${err.message}`);
        panel.webview.postMessage({ type: 'rebuildError', error: err.message });
        return false;
    }

    // 2. Find the generated GDS file
    const gdsPath = findGdsOutput(pythonFile, beforeTime);
    if (!gdsPath) {
        const msg = 'No .gds file found after build. Check supergds.gdsOutputDir config.';
        vscode.window.showErrorMessage(msg);
        panel.webview.postMessage({ type: 'rebuildError', error: msg });
        return false;
    }

    // 3. Parse and send to webview
    try {
        const geojson = await parseGdsFile(gdsPath);
        const mode = getForkStatus() === 'fork' ? 'full' : 'partial';
        const annotations = loadAnnotationsForPythonFile(pythonFile);

        panel.webview.postMessage({
            type: 'loadGds',
            geojson,
            gdsPath,
            pythonFile,
            annotations,
            mode,
        });
        return true;
    } catch (err: any) {
        vscode.window.showErrorMessage(`Parse failed: ${err.message}`);
        panel.webview.postMessage({ type: 'rebuildError', error: err.message });
        return false;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('superGDS extension activated');

    initPythonBridge(context.extensionPath);
    _context = context;

    const forkStatus = await detectForkStatus();
    console.log(`superGDS: gdsfactory fork status = ${forkStatus}`);

    // ── ⊞ Show GDS Viewer: build + parse + display ──
    context.subscriptions.push(
        vscode.commands.registerCommand('supergds.showGdsViewer', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'python') {
                vscode.window.showErrorMessage('Open a Python file to view GDS.');
                return;
            }

            const pythonFile = editor.document.uri.fsPath;
            setCurrentPythonFile(pythonFile);

            const panel = getOrCreatePanel(context);
            registerMessageHandlers(panel);

            const fs = require('fs');
            const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'viewer.html').fsPath;
            panel.webview.html = fs.readFileSync(htmlPath, 'utf-8');

            // Wait for webview to be ready, then rebuild
            const readyListener = panel.webview.onDidReceiveMessage((msg) => {
                if (msg.type === 'webviewReady') {
                    rebuildAndReload(pythonFile);
                    readyListener.dispose();
                }
            });
        })
    );

    // ── Detect fork command ──
    context.subscriptions.push(
        vscode.commands.registerCommand('supergds.detectFork', async () => {
            const status = await detectForkStatus();
            const labels: Record<string, string> = {
                fork: 'Fork gdsfactory detected — full provenance support',
                upstream: 'Upstream gdsfactory detected — geometry only, no provenance',
                none: 'No gdsfactory found in current environment',
                unknown: 'Could not determine gdsfactory version',
            };
            vscode.window.showInformationMessage(labels[status] || status);
        })
    );

    // ── Show ⊞ button whenever a Python file is active ──
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            await vscode.commands.executeCommand(
                'setContext',
                'supergds.gdsAvailable',
                editor?.document?.languageId === 'python'
            );
        })
    );
}

export function deactivate() {}
