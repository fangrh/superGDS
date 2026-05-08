import * as vscode from 'vscode';
import { detectForkStatus, getForkStatus } from './forkDetector';
import { findGdsOutput, getCurrentGdsPath } from './gdsWatcher';
import { parseGdsFile, runPythonFile, initPythonBridge } from './pythonBridge';
import { loadAnnotationsForPythonFile } from './annotations';
import { getOrCreatePanel } from './webview/panel';
import { registerMessageHandlers, setCurrentPythonFile } from './webview/provider';

export async function activate(context: vscode.ExtensionContext) {
    console.log('superGDS extension activated');

    initPythonBridge(context.extensionPath);

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

            // Check if there's already a .gds file from a previous run
            let gdsPath = getCurrentGdsPath();
            const beforeTime = new Date();

            // 1. Run the Python script to build GDS
            if (!gdsPath) {
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
            }

            // 2. Find the generated GDS file
            if (!gdsPath) {
                gdsPath = findGdsOutput(pythonFile, beforeTime);
            }
            if (!gdsPath) {
                vscode.window.showErrorMessage(
                    'No .gds file found after build. Check supergds.gdsOutputDir config.'
                );
                return;
            }

            // 3. Parse and display
            try {
                const geojson = await parseGdsFile(gdsPath);
                const panel = getOrCreatePanel(context);
                registerMessageHandlers(panel);

                const mode = getForkStatus() === 'fork' ? 'full' : 'partial';
                const annotations = loadAnnotationsForPythonFile(pythonFile);
                setCurrentPythonFile(pythonFile);
                const readyListener = panel.webview.onDidReceiveMessage((msg) => {
                    if (msg.type === 'webviewReady') {
                        panel.webview.postMessage({
                            type: 'loadGds',
                            geojson,
                            gdsPath,
                            pythonFile,
                            annotations,
                            mode,
                        });
                        readyListener.dispose();
                    }
                });

                const fs = require('fs');
                const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'viewer.html').fsPath;
                panel.webview.html = fs.readFileSync(htmlPath, 'utf-8');
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed: ${err.message}`);
            }
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
