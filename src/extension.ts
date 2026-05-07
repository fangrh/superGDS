import * as vscode from 'vscode';
import { detectForkStatus, getForkStatus } from './forkDetector';
import { scanForGds, watchForGds, getCurrentGdsPath } from './gdsWatcher';
import { parseGdsFile, initPythonBridge } from './pythonBridge';
import { getOrCreatePanel } from './webview/panel';
import { registerMessageHandlers } from './webview/provider';

export async function activate(context: vscode.ExtensionContext) {
    console.log('superGDS extension activated');

    // Step 0: Initialize Python bridge with extension path
    initPythonBridge(context.extensionPath);

    // Step 1: Detect fork status on startup
    const forkStatus = await detectForkStatus();
    console.log(`superGDS: gdsfactory fork status = ${forkStatus}`);

    // Step 2: Register the "Show GDS Viewer" command
    context.subscriptions.push(
        vscode.commands.registerCommand('supergds.showGdsViewer', async () => {
            const gdsPath = getCurrentGdsPath();
            if (!gdsPath) {
                const scanned = await scanForGds();
                if (!scanned) {
                    vscode.window.showInformationMessage(
                        'No GDS file found. Run your Python script first to generate a .gds file.'
                    );
                    return;
                }
            }

            const path = getCurrentGdsPath()!;
            try {
                vscode.window.showInformationMessage('Parsing GDS file...');
                const geojson = await parseGdsFile(path);

                const panel = getOrCreatePanel(context);
                registerMessageHandlers(panel);

                const mode = getForkStatus() === 'fork' ? 'full' : 'partial';
                const readyListener = panel.webview.onDidReceiveMessage((msg) => {
                    if (msg.type === 'webviewReady') {
                        panel.webview.postMessage({
                            type: 'loadGds',
                            geojson,
                            gdsPath: path,
                            mode,
                        });
                        readyListener.dispose();
                    }
                });

                const fs = require('fs');
                const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'viewer.html').fsPath;
                let html = fs.readFileSync(htmlPath, 'utf-8');
                panel.webview.html = html;

                vscode.window.showInformationMessage('GDS Viewer opened');
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to parse GDS: ${err.message}`);
            }
        })
    );

    // Step 3: Register detect fork command (manual re-detect)
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

    // Step 4: Listen for Python termination to scan for GDS files
    context.subscriptions.push(
        vscode.tasks.onDidEndTaskProcess(async (e) => {
            if (e.execution.task.source === 'Python' ||
                e.execution.task.name?.toLowerCase().includes('python')) {
                const activeFile = vscode.window.activeTextEditor?.document?.uri?.fsPath;
                if (activeFile?.endsWith('.py')) {
                    const gdsPath = await scanForGds(activeFile);
                    if (gdsPath) {
                        vscode.window.showInformationMessage(
                            `GDS file detected: ${gdsPath.split('/').pop()} — click ⊞ to view`
                        );
                    }
                }
            }
        })
    );

    // Step 5: Listen for active editor changes and watch for GDS files
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor?.document?.languageId === 'python') {
                // Scan for existing GDS and start watching for new ones
                await scanForGds(editor.document.uri.fsPath);
                await watchForGds(editor.document.uri.fsPath);
                // Always show button on Python files (fork detection already set this)
                await vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', true);
            } else {
                await vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', false);
            }
        })
    );
}

export function deactivate() {}
