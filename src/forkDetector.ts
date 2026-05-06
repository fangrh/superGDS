import * as vscode from 'vscode';
import { detectFork } from './pythonBridge';

export type ForkStatus = 'fork' | 'upstream' | 'none' | 'unknown';

let _cachedStatus: ForkStatus = 'unknown';
let _statusEmitter = new vscode.EventEmitter<ForkStatus>();

/** Event that fires when fork status changes. */
export const onForkStatusChanged = _statusEmitter.event;

/** Get the cached fork detection result. */
export function getForkStatus(): ForkStatus {
    return _cachedStatus;
}

/** Run fork detection (called at startup and on venv change). */
export async function detectForkStatus(): Promise<ForkStatus> {
    try {
        const result = await detectFork();
        _cachedStatus = result as ForkStatus;
    } catch {
        _cachedStatus = 'none';
    }
    _statusEmitter.fire(_cachedStatus);

    // Set context key so editor/title menu shows/hides the GDS button
    await vscode.commands.executeCommand(
        'setContext',
        'supergds.gdsAvailable',
        _cachedStatus !== 'unknown'
    );

    return _cachedStatus;
}
