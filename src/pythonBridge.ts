import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';

export interface PythonResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** Path to the extension's python/ directory. Set by extension.ts on activate. */
let _pythonDir: string = '';

/** Call once during extension activation with context.extensionPath. */
export function initPythonBridge(extensionPath: string): void {
    _pythonDir = path.join(extensionPath, 'python');
}

/**
 * Run a Python script using the active venv's python interpreter.
 * Reads the Python extension's selected interpreter path.
 */
export function getPythonPath(): string {
    const ext = vscode.extensions.getExtension('ms-python.python');
    if (ext && ext.isActive) {
        const pythonPath = ext.exports?.settings?.getExecutionDetails?.()?.execCommand?.[0];
        if (pythonPath) return pythonPath;
    }
    return vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath') || 'python';
}

/**
 * Run a Python script with arguments in the workspace directory.
 */
export function runPythonScript(
    scriptPath: string,
    args: string[] = [],
    cwd?: string
): Promise<PythonResult> {
    const pythonPath = getPythonPath();
    const workspaceRoot = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    return new Promise((resolve) => {
        execFile(
            pythonPath,
            [scriptPath, ...args],
            { cwd: workspaceRoot, maxBuffer: 50 * 1024 * 1024 },
            (error, stdout, stderr) => {
                resolve({
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    exitCode: error ? (error as any).code || 1 : 0,
                });
            }
        );
    });
}

/**
 * Parse GDS file to GeoJSON + provenance using venv Python.
 */
export async function parseGdsFile(gdsPath: string): Promise<any> {
    if (!_pythonDir) {
        throw new Error('pythonBridge not initialized. Call initPythonBridge() first.');
    }

    const scriptPath = path.join(_pythonDir, 'parse_gds.py');

    const result = await runPythonScript(scriptPath, [gdsPath]);
    if (result.exitCode !== 0) {
        try {
            const parsed = JSON.parse(result.stdout);
            throw new Error(parsed.error || result.stderr || 'GDS parse failed');
        } catch (e: any) {
            if (e instanceof SyntaxError) {
                throw new Error(result.stderr || `GDS parse script failed with exit code ${result.exitCode}`);
            }
            if (e.message && e.message !== 'GDS parse failed') throw e;
            throw new Error(result.stderr || 'GDS parse failed with unknown error');
        }
    }
    return JSON.parse(result.stdout);
}

/**
 * Run a Python file as a script using the venv Python interpreter.
 * Returns stdout, stderr, and exit code.
 */
export function runPythonFile(
    filePath: string,
    cwd?: string
): Promise<PythonResult> {
    const pythonPath = getPythonPath();
    const workingDir = cwd || path.dirname(filePath);

    return new Promise((resolve) => {
        execFile(
            pythonPath,
            [filePath],
            { cwd: workingDir, maxBuffer: 50 * 1024 * 1024 },
            (error, stdout, stderr) => {
                resolve({
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    exitCode: error ? (error as any).code || 1 : 0,
                });
            }
        );
    });
}

/**
 * Detect gdsfactory version (fork / upstream / none).
 * Returns "fork" | "upstream" | "none".
 */
export async function detectFork(): Promise<string> {
    const scriptPath = path.join(_pythonDir, 'detect_fork.py');

    const result = await runPythonScript(scriptPath);

    const match = result.stdout.match(/^FORK=(.+)$/m);
    if (match) {
        return match[1].trim();
    }
    return 'none';
}
