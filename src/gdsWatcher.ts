import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let _currentGdsPath: string | null = null;
let _currentPythonFile: string | null = null;
let _onGdsReady = new vscode.EventEmitter<string>();
let _onGdsCleared = new vscode.EventEmitter<void>();
let _watcher: fs.FSWatcher | null = null;

export const onGdsReady = _onGdsReady.event;
export const onGdsCleared = _onGdsCleared.event;

export function getCurrentGdsPath(): string | null {
    return _currentGdsPath;
}

export function getCurrentPythonFile(): string | null {
    return _currentPythonFile;
}

export async function watchForGds(pythonFile: string): Promise<void> {
    _currentPythonFile = pythonFile;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const gdsDir = vscode.workspace.getConfiguration('supergds').get<string>('gdsOutputDir') || 'gds';
    const gdsDirPath = path.join(workspaceRoot, gdsDir);

    if (_watcher) _watcher.close();
    try {
        _watcher = fs.watch(gdsDirPath, { persistent: false }, async (eventType, filename) => {
            if (!filename || !filename.endsWith('.gds')) return;
            const baseName = path.basename(pythonFile, '.py');
            if (filename.startsWith(baseName) || filename === `${baseName}.gds`) {
                const gdsPath = path.join(gdsDirPath, filename);
                if (fs.existsSync(gdsPath)) {
                    _currentGdsPath = gdsPath;
                    _onGdsReady.fire(gdsPath);
                    await vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', true);
                }
            }
        });
    } catch {
        const baseName = path.basename(pythonFile, '.py');
        const candidatePath = path.join(gdsDirPath, `${baseName}.gds`);
        if (fs.existsSync(candidatePath)) {
            _currentGdsPath = candidatePath;
            _onGdsReady.fire(candidatePath);
            await vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', true);
        }
    }
}

export async function scanForGds(pythonFile?: string): Promise<string | null> {
    const file = pythonFile || _currentPythonFile;
    if (!file) return null;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return null;

    const gdsDir = vscode.workspace.getConfiguration('supergds').get<string>('gdsOutputDir') || 'gds';
    const baseName = path.basename(file, '.py');
    const gdsDirPath = path.join(workspaceRoot, gdsDir);

    // Exact match first
    const exactPath = path.join(gdsDirPath, `${baseName}.gds`);
    if (fs.existsSync(exactPath)) {
        _currentGdsPath = exactPath;
        _onGdsReady.fire(exactPath);
        await vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', true);
        return exactPath;
    }

    if (fs.existsSync(gdsDirPath)) {
        const files = fs.readdirSync(gdsDirPath, { recursive: true }) as string[];
        const match = files.find(f => typeof f === 'string' && f.endsWith('.gds') && f.includes(baseName));
        if (match) {
            const fullPath = path.join(gdsDirPath, match);
            _currentGdsPath = fullPath;
            _onGdsReady.fire(fullPath);
            await vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', true);
            return fullPath;
        }
    }

    return null;
}

/**
 * Find a .gds file for the given Python file, only if modified after afterTime.
 * Used to discover GDS output after running a build.
 */
export function findGdsOutput(
    pythonFile: string,
    afterTime: Date
): string | null {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return null;

    const gdsDir = vscode.workspace.getConfiguration('supergds').get<string>('gdsOutputDir') || 'gds';
    const baseName = path.basename(pythonFile, '.py');
    const gdsDirPath = path.join(workspaceRoot, gdsDir);

    // Exact match first
    const exactPath = path.join(gdsDirPath, `${baseName}.gds`);
    if (fs.existsSync(exactPath)) {
        const stat = fs.statSync(exactPath);
        if (stat.mtime > afterTime) {
            _currentGdsPath = exactPath;
            return exactPath;
        }
    }

    // Scan all .gds files in the output directory
    if (fs.existsSync(gdsDirPath)) {
        const files = fs.readdirSync(gdsDirPath, { recursive: true }) as string[];
        for (const f of files) {
            if (typeof f === 'string' && f.endsWith('.gds') && f.includes(baseName)) {
                const fullPath = path.join(gdsDirPath, f);
                const stat = fs.statSync(fullPath);
                if (stat.mtime > afterTime) {
                    _currentGdsPath = fullPath;
                    return fullPath;
                }
            }
        }
    }

    return null;
}

export function clearGdsState(): void {
    _currentGdsPath = null;
    _onGdsCleared.fire();
    vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', false);
}
