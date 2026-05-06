# superGDS VS Code Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension that adds a GDS layout viewer (webview) with provenance-to-Claude-Code tracing, integrated alongside the Python run workflow.

**Architecture:** TypeScript VS Code extension with a webview panel (OpenLayers-based GDS viewer). GDS parsing runs inline via venv Python + klayout (no separate service). Fork detection on startup determines provenance capability. Claude Code integration via `claude-vscode.primaryEditor.open` command.

**Tech Stack:** TypeScript (VS Code Extension API), HTML/JS (OpenLayers 10 webview), Python (klayout for GDS parsing), Claude Code VS Code extension API.

**Reference:** `../gitea/gds-services/parser/viewer.html` (GDS viewer), `../gitea/gds-services/parser/main.py` (GDS parser), `../gitea/gdsfactory/gdsfactory/provenance_inject.py` (provenance injection).

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.vscodeignore`
- Create: `src/extension.ts` (stub)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "supergds",
  "displayName": "superGDS",
  "description": "GDS layout viewer with provenance-to-Claude-Code tracing",
  "version": "0.1.0",
  "publisher": "supergds",
  "engines": { "vscode": "^1.85.0" },
  "activationEvents": [
    "onLanguage:python"
  ],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "supergds.showGdsViewer",
        "title": "Show GDS Viewer",
        "icon": "$(graph)"
      },
      {
        "command": "supergds.detectFork",
        "title": "superGDS: Detect gdsfactory version"
      }
    ],
    "menus": {
      "editor/title": [
        {
          "command": "supergds.showGdsViewer",
          "when": "resourceLangId == python && supergds.gdsAvailable",
          "group": "navigation"
        }
      ]
    }
  },
  "scripts": {
    "vscode:prepublish": "tsc -p ./",
    "compile": "tsc -watch -p ./",
    "lint": "eslint src --ext ts"
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    "typescript": "^5.3.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "outDir": "out",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create .vscodeignore**

```
.vscode/**
.git/**
node_modules/**
src/**
tsconfig.json
.gitignore
```

- [ ] **Step 4: Create stub src/extension.ts**

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('superGDS extension activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('supergds.showGdsViewer', () => {
            vscode.window.showInformationMessage('superGDS: Show GDS Viewer');
        })
    );
}

export function deactivate() {}
```

- [ ] **Step 5: Install dependencies and verify build**

```bash
cd D:\gds_argo\Gdslab\superGDS
npm install
npm run compile
```

Expected: `out/extension.js` created without errors.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .vscodeignore src/extension.ts
git commit -m "feat: scaffold VS Code extension project"
```

---

### Task 2: Python Scripts — GDS Parser and Fork Detector

**Files:**
- Create: `python/parse_gds.py`
- Create: `python/detect_fork.py`

- [ ] **Step 1: Create python/parse_gds.py**

Port the core parsing logic from gitea's `gds-services/parser/main.py`, adapted to accept a file path and output JSON to stdout.

```python
"""Parse a .gds file into GeoJSON + provenance. Called from VS Code extension."""
import json
import sys
import os


LAYER_COLORS = [
    "#4ecdc4", "#ff6b6b", "#45b7d1", "#96ceb4",
    "#ffeaa7", "#dfe6e9", "#fd79a8", "#a29bfe",
    "#6c5ce7", "#00b894", "#e17055", "#0984e3",
    "#fab1a0", "#81ecec", "#55efc4", "#74b9ff",
]

PROVENANCE_LAYER = (255, 255)
PLACEMENT_PROP_KEY = 1004
INSTANCE_PROP_KEY = 1005


def _extract_provenance(layout):
    """Return ``{cell_name: provenance_dict}`` from TEXT on layer 255/255."""
    import klayout.db as kdb

    prov = {}
    prov_li = layout.layer(*PROVENANCE_LAYER)
    if prov_li is None:
        return prov
    for ci in range(layout.cells()):
        cell = layout.cell(ci)
        for shape in cell.shapes(prov_li).each(kdb.Shapes.STexts):
            try:
                entry = json.loads(shape.text.string)
                name = entry.get("cell") or cell.name or ""
                if name:
                    prov[name] = entry
            except Exception:
                pass
    return prov


def _polygon_metadata(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    area = 0.5 * abs(sum(
        xs[i] * ys[i + 1] - xs[i + 1] * ys[i]
        for i in range(len(ring) - 1)
    ))
    return {
        "area_um2": round(area, 4),
        "vertex_count": len(ring) - 1,
        "bbox": [round(min(xs), 6), round(min(ys), 6), round(max(xs), 6), round(max(ys), 6)],
    }


def _parse_json_property(value):
    if value in (None, ""):
        return None
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return None


def _shape_to_ring(shape, itrans, dbu):
    import klayout.db as kdb

    polygon = None
    if shape.is_polygon():
        polygon = shape.polygon
    elif shape.is_box():
        polygon = kdb.Polygon(shape.box)
    elif shape.is_path():
        polygon = shape.path.polygon()

    if polygon is None:
        return None

    pts = polygon.transformed(itrans).to_simple_polygon()
    ring = [[p.x * dbu, p.y * dbu] for p in pts.each_point()]
    if len(ring) < 3:
        return None
    ring.append(ring[0])
    return ring


def _get_instance_name(iterator):
    try:
        path = iterator.path()
    except Exception:
        return None
    if not path:
        return None
    try:
        return path[-1].inst().property(0)
    except Exception:
        return None


def _get_feature_provenance(iterator, provenance_by_cell):
    prov = None
    instance_name = _get_instance_name(iterator)

    try:
        path = iterator.path()
    except Exception:
        path = []
    if path:
        try:
            prov = _parse_json_property(path[-1].inst().property(INSTANCE_PROP_KEY))
        except Exception:
            prov = None

    if prov is None:
        try:
            prov = _parse_json_property(iterator.shape().property(PLACEMENT_PROP_KEY))
        except Exception:
            prov = None

    try:
        cell_name = iterator.cell().name
    except Exception:
        cell_name = None

    if prov is None and cell_name:
        prov = provenance_by_cell.get(cell_name)

    if prov is None:
        prov = {}
    else:
        prov = dict(prov)

    if instance_name:
        prov["instance_name"] = instance_name
    if cell_name and "cell" not in prov:
        prov["cell"] = cell_name

    return prov or None


def parse_gds(filepath: str) -> dict:
    """Parse a .gds file and return GeoJSON FeatureCollection."""
    import klayout.db as kdb

    layout = kdb.Layout()
    layout.read(filepath)

    provenance_by_cell = _extract_provenance(layout)

    top = layout.top_cell()
    features = []
    min_x = min_y = float("inf")
    max_x = max_y = float("-inf")
    for li in layout.layer_indexes():
        info = layout.layer_infos()[li]
        if (info.layer, info.datatype) == PROVENANCE_LAYER:
            continue
        it = top.begin_shapes_rec(li)
        if it.at_end():
            continue
        color = LAYER_COLORS[info.layer % len(LAYER_COLORS)]
        while not it.at_end():
            ring = _shape_to_ring(it.shape(), it.itrans(), layout.dbu)
            if ring is not None:
                properties = {
                    "layer": info.layer,
                    "data_type": info.datatype,
                    "color": color,
                    **_polygon_metadata(ring),
                }
                provenance = _get_feature_provenance(it, provenance_by_cell)
                if provenance:
                    properties["provenance"] = provenance
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                    "properties": properties,
                })
                for x, y in ring:
                    min_x = min(min_x, x)
                    max_x = max(max_x, x)
                    min_y = min(min_y, y)
                    max_y = max(max_y, y)
            it.next()

    result = {"type": "FeatureCollection", "features": features}
    if features:
        result["bbox"] = [min_x, min_y, max_x, max_y]
    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: parse_gds.py <file.gds>"}))
        sys.exit(1)

    gds_path = sys.argv[1]
    if not os.path.exists(gds_path):
        print(json.dumps({"error": f"File not found: {gds_path}"}))
        sys.exit(1)

    try:
        result = parse_gds(gds_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create python/detect_fork.py**

```python
"""Detect whether the installed gdsfactory is the fork with provenance support."""
import sys

def detect():
    try:
        import gdsfactory as gf
    except ImportError:
        print("FORK=none")
        return

    # Check for provenance_inject module (fork-only feature)
    has_provenance_inject = False
    try:
        from gdsfactory import provenance_inject  # noqa: F401
        has_provenance_inject = True
    except ImportError:
        pass

    # Check for the post_process hook on Component
    has_store_hook = callable(getattr(gf.Component, 'store_provenance_on_cell', None))

    # Check for provenance module (sidecar mode)
    has_provenance_module = False
    try:
        from gdsfactory import provenance  # noqa: F401
        has_provenance_module = True
    except ImportError:
        pass

    if has_provenance_inject or has_store_hook or has_provenance_module:
        print("FORK=fork")
    else:
        print("FORK=upstream")


if __name__ == "__main__":
    detect()
```

- [ ] **Step 3: Commit**

```bash
git add python/parse_gds.py python/detect_fork.py
git commit -m "feat: add Python GDS parser and fork detector scripts"
```

---

### Task 3: Python Bridge Module

**Files:**
- Create: `src/pythonBridge.ts`

- [ ] **Step 1: Create src/pythonBridge.ts**

```typescript
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
    const scriptPath = path.join(_pythonDir, 'parse_gds.py');

    const result = await runPythonScript(scriptPath, [gdsPath]);
    if (result.exitCode !== 0) {
        try {
            const parsed = JSON.parse(result.stdout);
            throw new Error(parsed.error || result.stderr || 'GDS parse failed');
        } catch (e: any) {
            if (e.message && e.message !== 'GDS parse failed') throw e;
            throw new Error(result.stderr || 'GDS parse failed with unknown error');
        }
    }
    return JSON.parse(result.stdout);
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
```

- [ ] **Step 2: Verify compilation**

```bash
npm run compile
```

Expected: compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/pythonBridge.ts
git commit -m "feat: add Python bridge module for subprocess management"
```

---

### Task 4: Fork Detector Module

**Files:**
- Create: `src/forkDetector.ts`

- [ ] **Step 1: Create src/forkDetector.ts**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/forkDetector.ts
git commit -m "feat: add fork detector with status caching and context keys"
```

---

### Task 5: GDS Watcher Module

**Files:**
- Create: `src/gdsWatcher.ts`

- [ ] **Step 1: Create src/gdsWatcher.ts**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let _currentGdsPath: string | null = null;
let _currentPythonFile: string | null = null;
let _onGdsReady = new vscode.EventEmitter<string>();
let _onGdsCleared = new vscode.EventEmitter<void>();
let _watcher: fs.FSWatcher | null = null;

/** Event: fires when a .gds file is found after Python run. */
export const onGdsReady = _onGdsReady.event;
/** Event: fires when the .gds file is no longer valid. */
export const onGdsCleared = _onGdsCleared.event;

/** Get the current .gds file path, if any. */
export function getCurrentGdsPath(): string | null {
    return _currentGdsPath;
}

/** Get the current Python file. */
export function getCurrentPythonFile(): string | null {
    return _currentPythonFile;
}

/**
 * Start watching for GDS output from a Python file.
 * Scans configured output directory for a .gds matching the Python filename.
 */
export async function watchForGds(pythonFile: string): Promise<void> {
    _currentPythonFile = pythonFile;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const gdsDir = vscode.workspace.getConfiguration('supergds').get<string>('gdsOutputDir') || 'gds';
    const gdsDirPath = path.join(workspaceRoot, gdsDir);

    // Watch the directory for changes
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
        // Directory doesn't exist yet — check directly for files
        const baseName = path.basename(pythonFile, '.py');
        const candidatePath = path.join(gdsDirPath, `${baseName}.gds`);
        if (fs.existsSync(candidatePath)) {
            _currentGdsPath = candidatePath;
            _onGdsReady.fire(candidatePath);
            await vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', true);
        }
    }
}

/** Manually scan for a GDS file (called after Python termination). */
export async function scanForGds(pythonFile?: string): Promise<string | null> {
    const file = pythonFile || _currentPythonFile;
    if (!file) return null;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return null;

    const gdsDir = vscode.workspace.getConfiguration('supergds').get<string>('gdsOutputDir') || 'gds';
    const baseName = path.basename(file, '.py');
    const gdsDirPath = path.join(workspaceRoot, gdsDir);

    // Scan for matching files
    const patterns = [
        path.join(gdsDirPath, `${baseName}.gds`),
        path.join(gdsDirPath, `${baseName}_*.gds`),
    ];

    for (const pattern of patterns) {
        if (fs.existsSync(pattern)) {
            _currentGdsPath = pattern;
            _onGdsReady.fire(pattern);
            await vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', true);
            return pattern;
        }
    }

    // Check inside subdirectories too
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

/** Clear the current GDS state. */
export function clearGdsState(): void {
    _currentGdsPath = null;
    _onGdsCleared.fire();
    vscode.commands.executeCommand('setContext', 'supergds.gdsAvailable', false);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/gdsWatcher.ts
git commit -m "feat: add GDS watcher for detecting Python run outputs"
```

---

### Task 6: Claude Code Bridge Module

**Files:**
- Create: `src/claudeBridge.ts`

- [ ] **Step 1: Create src/claudeBridge.ts**

```typescript
import * as vscode from 'vscode';

interface ComponentProvenance {
    file?: string;
    function?: string;
    line?: number | string;
    class_name?: string;
    call_index?: number;
    call_chain?: Array<{ file: string; function: string; line: number }>;
    cell?: string;
    instance_name?: string;
    layer?: string;
    bbox?: number[];
    area_um2?: number;
}

/**
 * Ask Claude about selected components. Opens Claude Code with provenance
 * context pre-filled as the initial prompt.
 */
export async function askClaude(
    components: ComponentProvenance[],
    userQuestion: string
): Promise<void> {
    const prompt = buildPrompt(components, userQuestion);

    try {
        await vscode.commands.executeCommand(
            'claude-vscode.primaryEditor.open',
            null,        // new conversation
            prompt       // pre-filled prompt
        );
    } catch {
        // Claude Code extension not installed — fallback to clipboard
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage(
            'Claude Code extension not found. Provenance context copied to clipboard.'
        );
    }
}

/** Build the prompt string from component provenance data. */
function buildPrompt(components: ComponentProvenance[], question: string): string {
    const lines: string[] = [];
    lines.push('## Selected GDS Components');
    lines.push('');

    const seenCallChain = new Set<string>();

    components.forEach((prov, idx) => {
        const label = prov.cell || prov.instance_name || `Component ${idx + 1}`;
        const layerInfo = prov.layer ? ` (${prov.layer})` : '';

        lines.push(`### ${label}${layerInfo}`);

        if (prov.file && prov.line) {
            lines.push(`- Source: ${prov.file}:${prov.line} in \`${prov.function || '<module>'}\``);
        }
        if (prov.class_name) {
            lines.push(`- Class: ${prov.class_name}`);
        }
        if (prov.bbox && prov.bbox.length === 4) {
            lines.push(`- BBox: [(${prov.bbox[0].toFixed(4)}, ${prov.bbox[1].toFixed(4)}), (${prov.bbox[2].toFixed(4)}, ${prov.bbox[3].toFixed(4)})]`);
        }
        if (prov.area_um2 !== undefined) {
            lines.push(`- Area: ${prov.area_um2} um²`);
        }

        // Call chain
        const chain = prov.call_chain || [];
        if (chain.length > 0) {
            lines.push('- Call chain:');
            chain.forEach((cc) => {
                const key = `${cc.file}:${cc.line}`;
                if (!seenCallChain.has(key)) {
                    seenCallChain.add(key);
                    const fn = cc.function ? ` (${cc.function})` : '';
                    lines.push(`  - ${cc.file}:${cc.line}${fn}`);
                }
            });
        }
        lines.push('');
    });

    lines.push('---');
    lines.push('');
    lines.push(question);

    return lines.join('\n');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/claudeBridge.ts
git commit -m "feat: add Claude Code bridge for provenance context injection"
```

---

### Task 7: Webview Panel Manager

**Files:**
- Create: `src/webview/panel.ts`

- [ ] **Step 1: Create src/webview/panel.ts**

```typescript
import * as vscode from 'vscode';
import { getForkStatus } from '../forkDetector';

let _panel: vscode.WebviewPanel | null = null;

/**
 * Create or reveal the GDS Viewer webview panel.
 * Returns the panel instance.
 */
export function getOrCreatePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
    if (_panel) {
        _panel.reveal(vscode.ViewColumn.Beside);
        return _panel;
    }

    _panel = vscode.window.createWebviewPanel(
        'supergds.viewer',
        'GDS Viewer',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media')
            ],
        }
    );

    _panel.onDidDispose(() => {
        _panel = null;
    });

    return _panel;
}

/** Get the current panel, or null if not open. */
export function getPanel(): vscode.WebviewPanel | null {
    return _panel;
}

/**
 * Load GDS data into the viewer.
 */
export async function loadGdsInViewer(
    geojson: any,
    gdsPath: string,
    context: vscode.ExtensionContext
): Promise<void> {
    const panel = getOrCreatePanel(context);
    const mode = getForkStatus() === 'fork' ? 'full' : 'partial';

    panel.webview.html = getViewerHtml(context, panel.webview);

    // Wait for webview to be ready, then send data
    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'webviewReady') {
            panel.webview.postMessage({
                type: 'loadGds',
                geojson,
                gdsPath,
                mode,
            });
        }
    });
}

/** Generate the viewer HTML with proper CSP and resource URIs. */
function getViewerHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const viewerUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'viewer.html')
    );

    // Read the viewer HTML and inject CSP
    const fs = require('fs');
    const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'viewer.html').fsPath;
    let html = fs.readFileSync(htmlPath, 'utf-8');

    // Replace CDN references with local or webview-compatible URIs
    // We keep CDN for OpenLayers since local bundling complicates distribution
    const csp = `
        <meta http-equiv="Content-Security-Policy"
              content="default-src 'none';
                       style-src 'unsafe-inline' https://cdn.jsdelivr.net;
                       script-src 'unsafe-inline' https://cdn.jsdelivr.net;
                       img-src data:;
                       connect-src 'none';">
    `;
    html = html.replace('<head>', '<head>' + csp);

    return html;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/webview/panel.ts
git commit -m "feat: add webview panel manager for GDS viewer"
```

---

### Task 8: Webview Message Provider

**Files:**
- Create: `src/webview/provider.ts`

- [ ] **Step 1: Create src/webview/provider.ts**

```typescript
import * as vscode from 'vscode';
import { askClaude } from '../claudeBridge';

interface ComponentSelection {
    provId: string;
    layer: string;
    bbox: number[];
    provenance: Record<string, any>;
}

/**
 * Register message handlers for webview ↔ extension communication.
 * Returns a disposable.
 */
export function registerMessageHandlers(
    panel: vscode.WebviewPanel
): vscode.Disposable {
    return panel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.type) {
                case 'selectComponents':
                    // Cache the current selection
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
                    // Log drawn shapes for potential use
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

/** Open a source file at a specific line in the editor. */
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
```

- [ ] **Step 2: Commit**

```bash
git add src/webview/provider.ts
git commit -m "feat: add webview message provider for extension-viewer communication"
```

---

### Task 9: Extension Entry Point

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Rewrite src/extension.ts**

Replace the stub with the full activation logic, wiring up all modules.

```typescript
import * as vscode from 'vscode';
import { detectForkStatus, getForkStatus } from './forkDetector';
import { scanForGds, getCurrentGdsPath, getCurrentPythonFile } from './gdsWatcher';
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
                // Try to scan
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
                // Wait for webview ready signal, then send data
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

                // Set the HTML (triggers loading, viewer will send 'webviewReady')
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

    // Step 5: Listen for active editor changes to update GDS availability
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor?.document?.languageId === 'python') {
                const gdsPath = await scanForGds(editor.document.uri.fsPath);
                await vscode.commands.executeCommand(
                    'setContext',
                    'supergds.gdsAvailable',
                    !!gdsPath
                );
            } else {
                await vscode.commands.executeCommand(
                    'setContext',
                    'supergds.gdsAvailable',
                    false
                );
            }
        })
    );
}

export function deactivate() {}
```

- [ ] **Step 2: Verify compilation**

```bash
npm run compile
```

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire up extension entry point with all modules"
```

---

### Task 10: GDS Viewer Webview (Port from viewer.html)

**Files:**
- Create: `media/viewer.html`

- [ ] **Step 1: Create media/viewer.html**

Port the complete viewer.html from gitea, adapting it for VS Code webview by:
1. Replacing `fetch('/data?...')` with `postMessage` to the extension
2. Replacing `fetch('/source?...')` with `postMessage('requestSource', ...)`
3. Adding `webviewReady` message on load
4. Adding an "Ask Claude" button in the console header
5. Listening for `loadGds` message from extension instead of `loadGDS()` via fetch
6. Keeping all OpenLayers rendering, drawing tools, selection, YAML export logic intact

This is the largest file in the project (~1400 lines). Create it with the full ported content.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GDS Viewer</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ol@10/ol.css">
<script src="https://cdn.jsdelivr.net/npm/ol@10/dist/ol.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { display: flex; height: 100vh; background: #1a1a2e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
#sidebar { width: 220px; background: #1e1e2e; color: #cdd6f4; overflow-y: auto; padding: 12px; flex-shrink: 0; }
#sidebar h4 { margin: 0 0 8px 0; color: #89b4fa; font-size: 13px; }
#sidebar button { width: 100%; margin-bottom: 8px; padding: 6px 10px; background: #45475a; color: #cdd6f4; border: 1px solid #585b70; border-radius: 4px; cursor: pointer; font-size: 12px; }
#sidebar button:hover { background: #585b70; }
#map-container { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#console { height: 200px; background: #11111b; color: #cdd6f4; font: 13px/1.5 'Cascadia Code', 'Fira Code', 'Consolas', monospace; overflow-y: auto; border-top: 2px solid #313244; flex-shrink: 0; transition: height 0.15s; }
#console.collapsed { height: 32px; overflow-y: hidden; }
#console-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: #181825; border-bottom: 1px solid #313244; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1; }
#console-header span { font-size: 12px; font-weight: 600; color: #89b4fa; }
#console-header button { padding: 3px 10px; background: #45475a; color: #cdd6f4; border: 1px solid #585b70; border-radius: 3px; cursor: pointer; font-size: 11px; font-family: inherit; margin-left: 4px; }
#console-header button:hover { background: #585b70; }
#console-header button.copied { background: #1a6640; border-color: #2e8b57; }
#console-header button.ask-claude { background: #5c3f82; border-color: #7b5ea7; }
#console-header button.ask-claude:hover { background: #7b5ea7; }
#console-body { padding: 8px 12px; }
#console-body .kv { display: flex; gap: 8px; padding: 1px 0; }
#console-body .kv .key { color: #6c7086; min-width: 90px; flex-shrink: 0; text-align: right; }
#console-body .kv .val { color: #cdd6f4; word-break: break-all; }
#console-body .kv .val.hl { color: #f9e2af; }
#console-body .placeholder { color: #585b70; font-style: italic; padding: 20px 0; text-align: center; }
#ask-section { display: none; padding: 8px 12px; background: #181825; border-top: 1px solid #313244; }
#ask-section.visible { display: flex; gap: 6px; align-items: center; }
#ask-section input { flex: 1; padding: 4px 8px; background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a; border-radius: 3px; font: 12px monospace; }
#ask-section input::placeholder { color: #585b70; }
#ask-section button { padding: 4px 12px; background: #5c3f82; color: #cdd6f4; border: 1px solid #7b5ea7; border-radius: 3px; cursor: pointer; font: 12px monospace; }
.file-item { padding: 6px 8px; cursor: pointer; border-radius: 4px; margin-bottom: 2px; font-size: 13px; word-break: break-all; }
.file-item:hover { background: #313244; }
.file-item.active { background: #45475a; }
.legend-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 12px; cursor: pointer; }
.swatch { width: 14px; height: 14px; border-radius: 2px; flex-shrink: 0; }
.swatch.hidden { opacity: 0.2; }
.tab-btn { padding: 2px 8px; border-radius: 4px 4px 0 0; cursor: pointer; font-size: 11px; color: #6c7086; border-bottom: 2px solid transparent; }
.tab-btn.active { color: #89b4fa; border-bottom-color: #89b4fa; }
.tab-btn:hover { color: #cdd6f4; }
#source-panel { height: 100%; overflow-y: auto; }
.src-line { display: flex; font: 12px/1.6 'Cascadia Code', 'Fira Code', 'Consolas', monospace; padding: 0 8px; margin: 0; }
.src-line.hl { background: rgba(250, 200, 80, 0.15); border-left: 3px solid #f9e2af; }
.src-line .ln { color: #585b70; min-width: 44px; text-align: right; padding-right: 12px; user-select: none; flex-shrink: 0; }
.src-line .code { color: #cdd6f4; white-space: pre; overflow-x: auto; }
.ol-dragbox { border: 2px dashed #89b4fa !important; background-color: rgba(137,180,250,0.1) !important; }
.file-section { margin: 4px 0; border: 1px solid #313244; border-radius: 4px; }
.file-section-header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: #181825; cursor: pointer; user-select: none; font-size: 12px; }
.file-section-header:hover { background: #1e1e2e; }
.file-section-header .arrow { color: #585b70; font-size: 10px; transition: transform 0.15s; }
.file-section-header .arrow.open { transform: rotate(90deg); }
.file-section-header .fname { color: #89b4fa; }
.file-section-header .lines { color: #6c7086; margin-left: auto; }
.file-section-body { max-height: 0; overflow: hidden; transition: max-height 0.2s; }
.file-section-body.open { max-height: 400px; overflow-y: auto; }
#map-row { display: flex; flex: 1; min-height: 0; }
#draw-toolbar { width: 40px; background: #1e1e2e; border-left: 1px solid #313244; display: flex; flex-direction: column; align-items: center; padding: 8px 0; gap: 4px; flex-shrink: 0; }
.tool-btn { width: 32px; height: 32px; background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #6c7086; padding: 0; }
.tool-btn:hover { background: #313244; color: #cdd6f4; }
.tool-btn.active { background: #45475a; color: #89b4fa; border-color: #89b4fa; }
.tool-btn svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
#mode-indicator { position: absolute; top: 8px; right: 8px; padding: 4px 12px; background: #1e1e2e; color: #cdd6f4; font-size: 12px; border-radius: 4px; z-index: 100; border: 1px solid #313244; }
#mode-indicator.partial { border-color: #e17055; color: #e17055; }
</style>
</head>
<body>
<div id="sidebar">
    <h4>GDS File</h4>
    <div id="file-info" style="color:#6c7086;font-size:12px;margin-bottom:8px;"></div>
    <button onclick="fitView()">Fit View</button>
    <div id="mode-indicator">Loading...</div>
    <div class="legend-section" id="legend"></div>
</div>
<div id="map-container">
    <div id="map-row">
        <div id="map" style="flex:1;"></div>
        <div id="draw-toolbar">
            <button class="tool-btn active" data-mode="select" title="Select (1)" onclick="setMode('select')">
                <svg viewBox="0 0 24 24"><path d="M5 3l14 9-7 2-3 7z"/></svg>
            </button>
            <button class="tool-btn" data-mode="rectangle" title="Rectangle (2)" onclick="setMode('rectangle')">
                <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>
            </button>
            <button class="tool-btn" data-mode="circle" title="Circle (3)" onclick="setMode('circle')">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>
            </button>
            <button class="tool-btn" data-mode="line" title="Line (4)" onclick="setMode('line')">
                <svg viewBox="0 0 24 24"><line x1="5" y1="19" x2="19" y2="5"/></svg>
            </button>
            <button class="tool-btn" data-mode="polygon" title="Polygon (5)" onclick="setMode('polygon')">
                <svg viewBox="0 0 24 24"><path d="M12 3l9 7-3 10H6L3 10z"/></svg>
            </button>
            <div style="height:1px;width:24px;background:#313244;margin:4px 0;"></div>
            <button class="tool-btn" data-mode="delete" title="Delete drawn" onclick="deleteDrawn()">
                <svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
            </button>
            <button class="tool-btn" data-mode="snap" title="Snap (S)" onclick="toggleSnap()">
                <svg viewBox="0 0 24 24"><path d="M6 16c0-3.3 2.7-6 6-6s6 2.7 6 6v3H6z"/><line x1="12" y1="3" x2="12" y2="7"/></svg>
            </button>
        </div>
    </div>
    <div id="ask-section">
        <input type="text" id="ask-input" placeholder="Ask Claude about selected components..." onkeydown="if(event.key==='Enter')sendAskClaude()">
        <button onclick="sendAskClaude()">Ask Claude</button>
    </div>
    <div id="console">
        <div id="console-header">
            <span style="display:flex;align-items:center;gap:2px;">
                <span class="tab-btn active" data-tab="info" onclick="switchTab(event, 'info')">Info</span>
                <span class="tab-btn" data-tab="source" onclick="switchTab(event, 'source')">Source</span>
            </span>
            <span style="display:flex;align-items:center;gap:6px;">
                <button id="ask-claude-btn" class="ask-claude" onclick="showAskSection()" title="Ask Claude about selection">Ask Claude</button>
                <button id="copy-btn" onclick="copyYAML(event)">Copy YAML</button>
                <span onclick="toggleConsole()" title="Collapse" style="cursor:pointer;color:#6c7086;font-size:14px;">&#9660;</span>
            </span>
        </div>
        <div id="console-body">
            <div id="info-panel"><p class="placeholder">Click a polygon to inspect</p></div>
            <div id="source-panel" style="display:none;"><p class="placeholder">Click a polygon, then switch to Source tab to view code</p></div>
        </div>
    </div>
</div>

<script>
// ============================================================
// VS Code Webview API
// ============================================================
const vscode = acquireVsCodeApi();

// ============================================================
// State
// ============================================================
var currentGdsPath = '';
var currentMode2 = 'partial';  // 'full' | 'partial'
var selectedFeatures = new ol.Collection();
var ctrlPressed = false;
var activeTab = 'info';
var sourceCache = {};
var expandedFiles = {};
var allFeatures = [];
var layerColors = {};
var currentMode = 'select';
var snapActive = false;
var drawInteractions = {};
var drawSource = new ol.source.Vector();

// ============================================================
// Draw styles
// ============================================================
var drawStyleDefault = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: '#f38ba8', width: 2, lineDash: [8, 4] }),
    fill: new ol.style.Fill({ color: 'rgba(243, 139, 168, 0.1)' })
});
var drawStyleSelected = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
    fill: new ol.style.Fill({ color: 'rgba(243, 139, 168, 0.3)' })
});
var drawLayer = new ol.layer.Vector({
    source: drawSource,
    style: function(feature) {
        return feature.get('selected') ? drawStyleSelected : drawStyleDefault;
    }
});

// ============================================================
// Keyboard handling
// ============================================================
document.addEventListener('keydown', function(e) {
    if (e.key === 'Control' || e.key === 'Meta') ctrlPressed = true;
    if (e.key === 'Escape') {
        if (currentMode !== 'select') setMode('select');
        clearSelection();
        hideAskSection();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedFeatures.getArray().some(function(f) { return f.get('isDrawn'); })) {
            e.preventDefault();
            deleteDrawn();
        }
    }
    if (e.key === '1') setMode('select');
    if (e.key === '2') setMode('rectangle');
    if (e.key === '3') setMode('circle');
    if (e.key === '4') setMode('line');
    if (e.key === '5') setMode('polygon');
    if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) toggleSnap();
});
document.addEventListener('keyup', function(e) {
    if (e.key === 'Control' || e.key === 'Meta') ctrlPressed = false;
});

// ============================================================
// Selection management
// ============================================================
function addToSelection(features) {
    features.forEach(function(f) {
        if (!selectedFeatures.getArray().includes(f)) {
            selectedFeatures.push(f);
            f.set('selected', true);
        }
    });
}
function removeFromSelection(features) {
    features.forEach(function(f) {
        selectedFeatures.remove(f);
        f.set('selected', false);
    });
}
function replaceSelection(features) {
    selectedFeatures.forEach(function(f) { f.set('selected', false); });
    selectedFeatures.clear();
    features.forEach(function(f) {
        selectedFeatures.push(f);
        f.set('selected', true);
    });
}
function clearSelection() {
    selectedFeatures.forEach(function(f) { f.set('selected', false); });
    selectedFeatures.clear();
    vectorLayer.changed();
    drawLayer.changed();
    onSelectionChanged();
}

// ============================================================
// Mode switching
// ============================================================
function setMode(mode) {
    if (mode === currentMode && mode !== 'select') {
        mode = 'select';
    }
    currentMode = mode;
    Object.keys(drawInteractions).forEach(function(key) {
        drawInteractions[key].setActive(false);
    });
    var isDrawMode = (mode !== 'select');
    selectClick.setActive(!isDrawMode);
    dragBox.setActive(!isDrawMode);
    if (isDrawMode && drawInteractions[mode]) {
        drawInteractions[mode].setActive(true);
    }
    document.querySelectorAll('.tool-btn[data-mode]').forEach(function(btn) {
        if (btn.dataset.mode === 'snap' || btn.dataset.mode === 'delete') return;
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
}

function deleteDrawn() {
    var drawn = selectedFeatures.getArray().filter(function(f) { return f.get('isDrawn'); });
    if (drawn.length === 0) return;
    drawn.forEach(function(f) {
        selectedFeatures.remove(f);
        drawSource.removeFeature(f);
    });
    drawLayer.changed();
    onSelectionChanged();
}

// ============================================================
// Map setup (must be after all function definitions)
// ============================================================
var gdsGeoJsonFmt = new ol.format.GeoJSON({
    dataProjection: 'EPSG:3857',
    featureProjection: 'EPSG:3857',
});
var source = new ol.source.Vector();
var highlightStyle = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
    fill: new ol.style.Fill({ color: 'rgba(255,255,255,0.3)' })
});
var vectorLayer = new ol.layer.Vector({
    source: source,
    style: function(feature) {
        var selected = feature.get('selected');
        if (selected) return highlightStyle;
        var color = feature.get('color') || '#fff';
        var visible = feature.get('visible') !== false;
        if (!visible) return new ol.style.Style({});
        return new ol.style.Style({
            stroke: new ol.style.Stroke({ color: color, width: 1 }),
            fill: new ol.style.Fill({ color: color + '80' })
        });
    }
});
var map = new ol.Map({
    target: 'map',
    layers: [vectorLayer, drawLayer],
    view: new ol.View({ center: [0, 0], zoom: 2, minZoom: -20, maxZoom: 40 }),
    controls: [new ol.control.Zoom()]
});

// Select interaction
var selectClick = new ol.interaction.Select({
    layers: [vectorLayer, drawLayer],
    style: null,
    multi: true
});
map.addInteraction(selectClick);
selectClick.on('select', function(e) {
    var clicked = e.selected.length > 0 ? e.selected[0] : null;
    if (clicked) {
        var alreadySelected = selectedFeatures.getArray().includes(clicked);
        if (ctrlPressed) {
            if (alreadySelected) {
                removeFromSelection([clicked]);
            } else {
                addToSelection([clicked]);
            }
        } else {
            replaceSelection([clicked]);
        }
    } else {
        clearSelection();
        return;
    }
    selectClick.getFeatures().clear();
    vectorLayer.changed();
    drawLayer.changed();
    onSelectionChanged();
});

// DragBox
var dragBox = new ol.interaction.DragBox({
    condition: function(mapBrowserEvent) {
        return ol.events.condition.mouseActionButton(mapBrowserEvent) &&
               ol.events.condition.noModifierKeys(mapBrowserEvent) ||
               ol.events.condition.platformModifierKeyOnly(mapBrowserEvent);
    }
});
map.addInteraction(dragBox);
var dragStartPixel = null;
dragBox.on('boxstart', function(e) { dragStartPixel = e.mapBrowserEvent.pixel; });
dragBox.on('boxend', function(e) {
    var extent = dragBox.getGeometry().getExtent();
    var endPixel = e.mapBrowserEvent.pixel;
    var dragDist = Math.sqrt(
        Math.pow(endPixel[0] - dragStartPixel[0], 2) +
        Math.pow(endPixel[1] - dragStartPixel[1], 2)
    );
    if (dragDist < 5) return;
    var featuresInBox = [];
    source.forEachFeatureInExtent(extent, function(f) {
        if (f.get('visible') !== false) {
            var geom = f.getGeometry();
            if (geom && ol.extent.intersects(extent, geom.getExtent())) {
                featuresInBox.push(f);
            }
        }
    });
    drawSource.forEachFeatureInExtent(extent, function(f) {
        var geom = f.getGeometry();
        if (geom && ol.extent.intersects(extent, geom.getExtent())) {
            featuresInBox.push(f);
        }
    });
    if (ctrlPressed) {
        addToSelection(featuresInBox);
    } else {
        replaceSelection(featuresInBox);
    }
    vectorLayer.changed();
    drawLayer.changed();
    onSelectionChanged();
});

// Draw interactions
var drawRectangle = new ol.interaction.Draw({
    source: drawSource, type: 'Circle',
    geometryFunction: ol.interaction.Draw.createBox()
});
drawRectangle.setActive(false);
map.addInteraction(drawRectangle);
drawInteractions['rectangle'] = drawRectangle;

var drawCircle = new ol.interaction.Draw({ source: drawSource, type: 'Circle' });
drawCircle.setActive(false);
map.addInteraction(drawCircle);
drawInteractions['circle'] = drawCircle;

var drawLine = new ol.interaction.Draw({ source: drawSource, type: 'LineString' });
drawLine.setActive(false);
map.addInteraction(drawLine);
drawInteractions['line'] = drawLine;

var drawPolygon = new ol.interaction.Draw({ source: drawSource, type: 'Polygon' });
drawPolygon.setActive(false);
map.addInteraction(drawPolygon);
drawInteractions['polygon'] = drawPolygon;

Object.keys(drawInteractions).forEach(function(key) {
    drawInteractions[key].on('drawend', function(e) {
        var feature = e.feature;
        feature.set('isDrawn', true);
        feature.set('shapeType', key);
        feature.set('selected', false);
        setTimeout(function() { setMode('select'); }, 50);
    });
});

// Modify & Translate
var modifyInteraction = new ol.interaction.Modify({
    source: drawSource,
    style: new ol.style.Style({
        image: new ol.style.Circle({
            radius: 5,
            fill: new ol.style.Fill({ color: '#f38ba8' }),
            stroke: new ol.style.Stroke({ color: '#ffffff', width: 1 })
        })
    })
});
modifyInteraction.setActive(false);
map.addInteraction(modifyInteraction);

var translateInteraction = new ol.interaction.Translate({ layers: [drawLayer] });
translateInteraction.setActive(false);
map.addInteraction(translateInteraction);

// Snap
var gridSource = new ol.source.Vector();
var snapGds = new ol.interaction.Snap({ source: source, pixelTolerance: 10 });
var snapDraw = new ol.interaction.Snap({ source: drawSource, pixelTolerance: 10 });
var snapGrid = new ol.interaction.Snap({ source: gridSource, pixelTolerance: 10 });
snapGds.setActive(false);
snapDraw.setActive(false);
snapGrid.setActive(false);
map.addInteraction(snapGds);
map.addInteraction(snapDraw);
map.addInteraction(snapGrid);

function toggleSnap() {
    snapActive = !snapActive;
    snapGds.setActive(snapActive);
    snapDraw.setActive(snapActive);
    snapGrid.setActive(snapActive);
    var btn = document.querySelector('.tool-btn[data-mode="snap"]');
    btn.classList.toggle('active', snapActive);
    if (snapActive) { updateGridSnap(); } else { gridSource.clear(); }
}
function updateGridSnap() {
    if (!snapActive) return;
    var view = map.getView();
    var resolution = view.getResolution();
    var extent = view.calculateExtent(map.getSize());
    var rawSpacing = resolution * 80;
    var exponent = Math.floor(Math.log10(rawSpacing));
    var spacing = Math.pow(10, exponent);
    var minX = Math.floor(extent[0] / spacing) * spacing;
    var minY = Math.floor(extent[1] / spacing) * spacing;
    var maxX = Math.ceil(extent[2] / spacing) * spacing;
    var maxY = Math.ceil(extent[3] / spacing) * spacing;
    var maxPoints = 2000;
    var countX = Math.round((maxX - minX) / spacing) + 1;
    var countY = Math.round((maxY - minY) / spacing) + 1;
    if (countX * countY > maxPoints) return;
    gridSource.clear();
    for (var x = minX; x <= maxX; x += spacing) {
        for (var y = minY; y <= maxY; y += spacing) {
            gridSource.addFeature(new ol.Feature({ geometry: new ol.geom.Point([x, y]) }));
        }
    }
}
map.getView().on('change:resolution', function() { if (snapActive) updateGridSnap(); });
map.on('moveend', function() { if (snapActive) updateGridSnap(); });

function fitView() {
    var extent = source.getExtent();
    if (extent && isFinite(extent[0])) {
        map.getView().fit(extent, { padding: [40, 40, 40, 40], duration: 300 });
    }
}

// ============================================================
// Load GDS data (receives GeoJSON from extension)
// ============================================================
function loadGdsData(geojson, gdsPath, mode) {
    currentGdsPath = gdsPath;
    currentMode2 = mode;
    source.clear();
    allFeatures = [];
    layerColors = {};
    sourceCache = {};
    expandedFiles = {};

    // Update mode indicator
    var indicator = document.getElementById('mode-indicator');
    if (mode === 'full') {
        indicator.textContent = 'Provenance: ON';
        indicator.className = '';
    } else {
        indicator.textContent = 'Provenance: OFF';
        indicator.className = 'partial';
    }

    // Update file info
    var fileName = gdsPath.split(/[/\\]/).pop();
    document.getElementById('file-info').textContent = fileName;

    geojson.features.forEach(function(feature) {
        var props = feature.properties || {};
        var layerId = props.layer;
        var dataType = props.data_type;
        var color = props.color;
        var key = layerId + '/' + dataType;
        layerColors[key] = color;
        var geom = gdsGeoJsonFmt.readGeometry(feature.geometry);
        var f = new ol.Feature({ geometry: geom });
        f.set('layer', key);
        f.set('color', color);
        f.set('layerKey', key);
        f.set('visible', true);
        f.set('selected', false);
        f.set('provenance', props.provenance || {});
        f.set('meta', {
            area_um2: props.area_um2,
            vertex_count: props.vertex_count,
            bbox: props.bbox || []
        });
        allFeatures.push(f);
        source.addFeature(f);
    });

    if (allFeatures.length > 0) fitView();
    clearInspect();
    buildLegend();

    // Update ask button visibility
    var askBtn = document.getElementById('ask-claude-btn');
    askBtn.style.display = (mode === 'full') ? '' : 'none';
}

function buildLegend() {
    var container = document.getElementById('legend');
    // Clear previous legend items (keep the h4)
    var existing = container.querySelectorAll('.legend-row');
    existing.forEach(function(el) { el.remove(); });

    // Add h4 if not present
    if (!container.querySelector('h4')) {
        var h4 = document.createElement('h4');
        h4.style.cssText = 'margin:0 0 6px 0;color:#89b4fa;';
        h4.textContent = 'Layers';
        container.appendChild(h4);
    }

    var keys = Object.keys(layerColors);
    if (!keys.length) return;
    keys.forEach(function(key) {
        var row = document.createElement('div');
        row.className = 'legend-row';
        row.innerHTML = '<span class="swatch" style="background:' + layerColors[key] + ';" data-key="' + key + '"></span> ' + key;
        row.onclick = function() {
            var swatch = row.querySelector('.swatch');
            var hidden = swatch.classList.toggle('hidden');
            allFeatures.forEach(function(f) { if (f.get('layerKey') === key) f.set('visible', !hidden); });
            vectorLayer.changed();
        };
        container.appendChild(row);
    });
}

// ============================================================
// Console / Info panel
// ============================================================
function onSelectionChanged() {
    var features = selectedFeatures.getArray();
    var count = features.length;
    var hasDrawn = count > 0 && features.some(function(f) { return f.get('isDrawn'); });
    modifyInteraction.setActive(hasDrawn);
    translateInteraction.setActive(hasDrawn);

    // Show/hide ask section
    var hasGdsSelection = features.some(function(f) { return !f.get('isDrawn'); });
    var askSection = document.getElementById('ask-section');
    if (hasGdsSelection && currentMode2 === 'full') {
        askSection.classList.add('visible');
    } else {
        askSection.classList.remove('visible');
    }

    if (count === 0) {
        clearInspect();
        return;
    }

    var drawnFeatures = features.filter(function(f) { return f.get('isDrawn'); });
    var gdsFeatures = features.filter(function(f) { return !f.get('isDrawn'); });

    if (drawnFeatures.length > 0 && gdsFeatures.length === 0) {
        if (drawnFeatures.length === 1) {
            showDrawnInspect(drawnFeatures[0]);
        } else {
            showDrawnMultiInspect(drawnFeatures);
        }
    } else if (drawnFeatures.length === 0) {
        if (gdsFeatures.length === 1) {
            showInspect(gdsFeatures[0]);
        } else {
            showMultiInspect(gdsFeatures);
        }
    } else {
        showMixedInspect(gdsFeatures, drawnFeatures);
    }
}

// --- All the showInspect, showMultiInspect, showDrawnInspect, etc. ---
// (These functions are identical to the gitea viewer.html implementation)
// Keeping them in the actual file but omitted here for brevity.
// Refer to: D:\gds_argo\Gdslab\gitea\gds-services\parser\viewer.html
// lines 869-1062 for the complete implementations.

// ============================================================
// Ask Claude integration
// ============================================================
function showAskSection() {
    if (selectedFeatures.getArray().length === 0) return;
    var askSection = document.getElementById('ask-section');
    askSection.classList.add('visible');
    document.getElementById('ask-input').focus();
}
function hideAskSection() {
    document.getElementById('ask-section').classList.remove('visible');
    document.getElementById('ask-input').value = '';
}
function sendAskClaude() {
    var question = document.getElementById('ask-input').value.trim();
    if (!question) return;
    var gdsFeatures = selectedFeatures.getArray().filter(function(f) { return !f.get('isDrawn'); });
    if (gdsFeatures.length === 0) return;
    var components = gdsFeatures.map(function(f) {
        return {
            provId: f.ol_uid,
            layer: f.get('layer') || '',
            bbox: (f.get('meta') || {}).bbox || [],
            provenance: f.get('provenance') || {}
        };
    });
    vscode.postMessage({ type: 'askClaude', components: components, question: question });
    hideAskSection();
}

// ============================================================
// Copy YAML
// ============================================================
function copyYAML(e) {
    e.stopPropagation();
    var features = selectedFeatures.getArray();
    if (features.length === 0) return;

    // ... (same YAML generation logic as gitea viewer.html lines 1098-1161)
    // Build YAML lines, then:
    var text = lines.join('\n');
    vscode.postMessage({ type: 'exportYaml', yaml: text });

    // Visual feedback
    var btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = 'Copy YAML'; btn.classList.remove('copied'); }, 2000);
}

// ============================================================
// Utility
// ============================================================
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function frag() { return document.createDocumentFragment(); }
function clearInspect() {
    document.getElementById('info-panel').innerHTML = '<p class="placeholder">Click a polygon to inspect</p>';
    document.getElementById('source-panel').innerHTML = '<p class="placeholder">Click a polygon, then switch to Source tab to view code<br><small style="color:#585b70;">Requires provenance data embedded in the GDS file.</small></p>';
}
function switchTab(e, tab) {
    e.stopPropagation();
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.getElementById('info-panel').style.display = tab === 'info' ? '' : 'none';
    document.getElementById('source-panel').style.display = tab === 'source' ? '' : 'none';
}
function toggleConsole() {
    var c = document.getElementById('console');
    var icon = document.querySelector('#console-header span[title="Collapse"]');
    c.classList.toggle('collapsed');
    if (icon) {
        icon.innerHTML = c.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
    }
}
function addKV(parent, key, val, hl) {
    var row = document.createElement('div');
    row.className = 'kv';
    row.innerHTML = '<span class="key">' + esc(key) + '</span><span class="val' + (hl ? ' hl' : '') + '">' + esc(val) + '</span>';
    parent.appendChild(row);
}
function addSep(parent) {
    var sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:#313244;margin:4px 0;';
    parent.appendChild(sep);
}
function min(arr) { return arr.reduce(function(a, b) { return Math.min(a, b); }); }
function max(arr) { return arr.reduce(function(a, b) { return Math.max(a, b); }); }

// ============================================================
// Handle messages from extension
// ============================================================
window.addEventListener('message', function(event) {
    var message = event.data;
    switch (message.type) {
        case 'loadGds':
            loadGdsData(message.geojson, message.gdsPath, message.mode);
            break;
        case 'setMode':
            currentMode2 = message.mode;
            document.getElementById('mode-indicator').textContent =
                message.mode === 'full' ? 'Provenance: ON' : 'Provenance: OFF';
            document.getElementById('mode-indicator').className =
                message.mode === 'full' ? '' : 'partial';
            break;
    }
});

// ============================================================
// Signal ready to extension
// ============================================================
vscode.postMessage({ type: 'webviewReady' });
</script>
</body>
</html>
```

- [ ] **Step 2: Verify the file is complete and all JS functions are present**

The viewer.html must include the following functions that were omitted in the snippet above for brevity. Copy them verbatim from `D:\gds_argo\Gdslab\gitea\gds-services\parser\viewer.html`:
- `showInspect(feature)` (lines 869-925)
- `showMultiInspect(features)` (lines 276-379)
- `showDrawnInspect(feature)` (lines 1002-1020)
- `showDrawnMultiInspect(features)` (lines 1022-1040)
- `showMixedInspect(gdsFeatures, drawnFeatures)` (lines 1042-1062)
- `getShapeGeom(feature)` (lines 958-1000)
- `shapeToYAML(sg)` (lines 1064-1076)
- `polyMeta(ring)` (lines 807-818)
- `updateMultiSourcePanel(fileMap)` (lines 381-423)
- `toggleFileSection(filePath, bodyEl)` (lines 425-442)
- `loadFileSource(filePath, container, highlightLines)` (lines 444-464)
- `renderSourceLines(code, container, highlightLines)` (lines 466-480)
- `_normalizeCallChain(prov)` (lines 849-865)
- All `addKV`, `addSep` helpers (lines 942-957)

- [ ] **Step 3: Commit**

```bash
git add media/viewer.html
git commit -m "feat: port GDS viewer webview from gitea with Claude Code integration"
```

---

### Task 11: Icons

**Files:**
- Create: `media/icons/gds-ready.svg`
- Create: `media/icons/gds-partial.svg`
- Create: `media/icons/gds-waiting.svg`

- [ ] **Step 1: Create SVG icons**

Create `media/icons/gds-ready.svg` (green graph icon):
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <path fill="#40a02b" d="M1.5 14L5 8l3 3 5-7 1.5 1L8 13l-3-3-2.5 4z"/>
</svg>
```

Create `media/icons/gds-partial.svg` (orange graph icon):
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <path fill="#fe640b" d="M1.5 14L5 8l3 3 5-7 1.5 1L8 13l-3-3-2.5 4z"/>
</svg>
```

Create `media/icons/gds-waiting.svg` (gray graph icon):
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <path fill="#6c7086" d="M1.5 14L5 8l3 3 5-7 1.5 1L8 13l-3-3-2.5 4z"/>
</svg>
```

- [ ] **Step 2: Commit**

```bash
git add media/icons/
git commit -m "feat: add GDS button state icons"
```

---

### Task 12: ESLint config and final wiring

**Files:**
- Create: `.eslintrc.json`
- Create: `.gitignore`

- [ ] **Step 1: Create .eslintrc.json**

```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "ecmaVersion": 2022,
    "sourceType": "module"
  },
  "plugins": ["@typescript-eslint"],
  "rules": {
    "@typescript-eslint/no-explicit-any": "off"
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
out/
node_modules/
*.vsix
.DS_Store
```

- [ ] **Step 3: Install TypeScript ESLint dev dependencies**

```bash
npm install --save-dev @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint
```

- [ ] **Step 4: Full compilation check**

```bash
npm run compile
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add .eslintrc.json .gitignore
git commit -m "chore: add eslint config and gitignore"
```

---

### Task 13: Add configuration schema and finalize package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add configuration contribution to package.json**

Add to the `"contributes"` section of `package.json`:

```json
"configuration": {
  "title": "superGDS",
  "properties": {
    "supergds.gdsOutputDir": {
      "type": "string",
      "default": "gds",
      "description": "Directory where .gds files are generated (relative to workspace root)"
    }
  }
}
```

- [ ] **Step 2: Verify final package.json structure**

Run `npm run compile` to verify the full project builds.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add supergds.gdsOutputDir configuration"
```
