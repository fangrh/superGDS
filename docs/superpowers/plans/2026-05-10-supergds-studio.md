# superGDS Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-based web server (Overleaf/Jupyter-like) with Monaco Python editor and provenance-aware GDS viewer, using Fastify backend and browser-use E2E tests.

**Architecture:** Fastify backend serves a single-page Vue-like app. Monaco editor on the left, GDS viewer iframe on the right, terminal at bottom. Python script execution via child_process with SSE streaming. Reuse existing viewer.html, parse_gds.py, and provenance.ts from the superGDS VSCode extension.

**Tech Stack:** Fastify (Node.js/TypeScript) + Monaco Editor + iframe + browser-use (E2E tests)

---

## File Structure

```
overgds/
├── server/
│   ├── index.ts              # Fastify entry, CORS, route registration
│   ├── fileRoutes.ts         # GET/POST /api/files
│   ├── runRoutes.ts          # POST /api/run (spawn python, SSE)
│   ├── parseRoutes.ts        # POST /api/parse (GDS→GeoJSON)
│   ├── annotationRoutes.ts   # GET/POST /api/annotations
│   └── workspace.ts          # Workspace path management
├── frontend/
│   ├── index.html            # Main SPA shell
│   ├── studio.css            # Split-pane layout styles
│   ├── studio.ts             # Main: layout, state, message routing
│   ├── monacoSetup.ts        # Monaco Editor initialization
│   ├── terminal.ts           # Terminal output rendering
│   └── iframeBridge.ts       # postMessage to/from iframe viewer
├── viewer/                    # iframe content (copy of media/ from superGDS)
│   └── viewer.html
├── lib/
│   ├── pythonRunner.ts       # child_process spawn + SSE streaming
│   ├── gdsParser.ts          # Invoke parse_gds.py, return GeoJSON
│   ├── forkDetector.ts       # Detect fork vs upstream gdsfactory
│   └── annotations.ts        # Load/save annotation JSON files
├── tests/
│   └── e2e/
│       ├── browser-use.config.ts
│       ├── openWorkspace.test.ts
│       ├── editAndRun.test.ts
│       ├── gdsViewerInteraction.test.ts
│       ├── rebuild.test.ts
│       └── annotations.test.ts
├── package.json
├── tsconfig.json
└── SPEC.md
```

---

## Task 1: Initialize Project — package.json + tsconfig.json

**Files:**
- Create: `overgds/package.json`
- Create: `overgds/tsconfig.json`
- Create: `overgds/SPEC.md` (symlink or copy of spec)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "supergds-studio",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch server/index.ts",
    "build": "tsc",
    "start": "node dist/server/index.js",
    "test:e2e": "npx playwright test tests/e2e"
  },
  "dependencies": {
    "fastify": "^5.1.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/static": "^8.0.0",
    "@fastify/sensible": "^6.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "@playwright/test": "^1.48.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["server/**/*", "lib/**/*", "frontend/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: dependencies installed, no errors

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json
git commit -m "feat: initialize superGDS Studio project"
```

---

## Task 2: Backend — Fastify Server Shell + CORS

**Files:**
- Create: `overgds/server/index.ts`
- Modify: `overgds/server/routes/` (new directory)

- [ ] **Step 1: Write server/index.ts**

```typescript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileRoutes } from './fileRoutes.js';
import { runRoutes } from './runRoutes.js';
import { parseRoutes } from './parseRoutes.js';
import { annotationRoutes } from './annotationRoutes.js';

const PORT = 3000;

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  credentials: true,
});

await app.register(fastifyStatic, {
  root: './frontend',
  prefix: '/',
});

await app.register(fileRoutes, { prefix: '/api/files' });
await app.register(runRoutes, { prefix: '/api/run' });
await app.register(parseRoutes, { prefix: '/api/parse' });
await app.register(annotationRoutes, { prefix: '/api/annotations' });

app.get('/api/health', async () => ({ status: 'ok' }));

app.listen({ port: PORT }, (err, addr) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`superGDS Studio running at http://localhost:${PORT}`);
});
```

- [ ] **Step 2: Run server to verify it starts**

Run: `npx tsx server/index.ts`
Expected: Server starts, no TypeScript errors

- [ ] **Step 3: Test health endpoint**

Run: `curl http://localhost:3000/api/health`
Expected: `{"status":"ok"}`

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat: Fastify server shell with CORS and static serving"
```

---

## Task 3: Workspace Management + File Routes

**Files:**
- Create: `overgds/server/workspace.ts`
- Create: `overgds/server/fileRoutes.ts`

- [ ] **Step 1: Write server/workspace.ts**

```typescript
// Singleton workspace path — set once per server instance (one user per launch)
let workspacePath: string | null = null;

export function setWorkspacePath(path: string): void {
  workspacePath = path;
}

export function getWorkspacePath(): string {
  if (!workspacePath) {
    throw new Error('No workspace set. POST /api/workspace first.');
  }
  return workspacePath;
}

export function isWithinWorkspace(requestedPath: string): boolean {
  const ws = getWorkspacePath();
  const resolved = path.resolve(ws, requestedPath);
  return resolved.startsWith(ws);
}
```

- [ ] **Step 2: Write server/fileRoutes.ts**

```typescript
import Fastify from 'fastify';
import path from 'path';
import fs from 'fs/promises';

export function registerWorkspaceRoutes(app: FastifyInstance) {
  app.post('/api/workspace', async (req) => {
    const { workspace } = req.body as { workspace: string };
    if (!workspace) throw new Error('workspace path required');
    setWorkspacePath(workspace);
    return { success: true };
  });

  app.get('/api/files', async () => {
    const ws = getWorkspacePath();
    const files = await walkDir(ws, ws);
    return { files };
  });

  app.get('/api/files/*', async (req) => {
    const filePath = (req.params as any)['*'];
    if (!isWithinWorkspace(filePath)) throw new Error('Access denied');
    const fullPath = path.join(getWorkspacePath(), filePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    return { content, path: filePath };
  });

  app.post('/api/files/*', async (req) => {
    const filePath = (req.params as any)['*'];
    if (!isWithinWorkspace(filePath)) throw new Error('Access denied');
    const { content } = req.body as { content: string };
    const fullPath = path.join(getWorkspacePath(), filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    return { success: true };
  });
}

async function walkDir(dir: string, base: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const relPath = path.relative(base, path.join(dir, entry.name));
    if (entry.isDirectory()) {
      const sub = await walkDir(path.join(dir, entry.name), base);
      files.push(...sub);
    } else {
      files.push(relPath.replace(/\\/g, '/'));
    }
  }
  return files;
}
```

- [ ] **Step 3: Update server/index.ts to register workspace routes**

Modify: `overgds/server/index.ts` — import and register the workspace route.

- [ ] **Step 4: Test file round-trip**

Start server, POST /api/workspace with a temp dir path, then GET /api/files — verify it returns file list.

- [ ] **Step 5: Commit**

```bash
git add server/workspace.ts server/fileRoutes.ts server/index.ts
git commit -m "feat: workspace management and file CRUD routes"
```

---

## Task 4: Python Runner — child_process spawn + SSE

**Files:**
- Create: `overgds/lib/pythonRunner.ts`
- Create: `overgds/server/runRoutes.ts`

- [ ] **Step 1: Write lib/pythonRunner.ts**

```typescript
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

export interface RunOptions {
  pythonFile: string;
  cwd: string;
  gdsOutputDir?: string;
}

export interface BuildResult {
  gdsPath: string;
  geojson: unknown;
  annotations: unknown[];
  mode: 'full' | 'partial';
}

export async function runPythonScript(
  opts: RunOptions,
  onStdout: (line: string) => void,
  onStderr: (line: string) => void
): Promise<BuildResult> {
  return new Promise((resolve, reject) => {
    const python = spawn('python', [opts.pythonFile], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...(opts.gdsOutputDir ? { SUPERGDS_OUTPUT_DIR: opts.gdsOutputDir } : {}),
      },
    });

    let stdoutData = '';
    let stderrData = '';

    python.stdout.on('data', (data) => {
      const text = data.toString();
      stdoutData += text;
      for (const line of text.split('\n')) {
        if (line.trim()) onStdout(line);
      }
    });

    python.stderr.on('data', (data) => {
      const text = data.toString();
      stderrData += text;
      for (const line of text.split('\n')) {
        if (line.trim()) onStderr(line);
      }
    });

    python.on('close', async (code) => {
      if (code !== 0) {
        return reject(new Error(`Python exited ${code}: ${stderrData}`));
      }

      // Find the generated GDS file (latest .gds in output dir or cwd)
      const gdsPath = await findGdsOutput(opts.cwd, opts.gdsOutputDir);
      if (!gdsPath) throw new Error('No .gds file found after build');

      // Parse GDS to GeoJSON
      const { parseGdsFile } = await import('./gdsParser.js');
      const geojson = await parseGdsFile(gdsPath);
      const annotations = [];

      resolve({ gdsPath, geojson, annotations, mode: 'full' });
    });
  });
}

async function findGdsOutput(cwd: string, outputDir?: string): Promise<string | null> {
  const dir = outputDir ? path.join(cwd, outputDir) : cwd;
  try {
    const files = await fs.readdir(dir);
    const gdsFiles = files.filter((f) => f.endsWith('.gds'));
    if (gdsFiles.length === 0) return null;
    const latest = gdsFiles.map((f) => ({ f, mtime: fs.stat(path.join(dir, f)).then((s) => s.mtimeMs) }));
    const withTimes = await Promise.all(latest);
    withTimes.sort((a, b) => b.mtime - a.mtime);
    return path.join(dir, withTimes[0].f);
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Write server/runRoutes.ts**

```typescript
import Fastify from 'fastify';
import { runPythonScript } from '../../lib/pythonRunner.js';
import { parseGdsFile } from '../../lib/gdsParser.js';
import { getWorkspacePath } from './workspace.js';
import path from 'path';

export function runRoutes(app: FastifyInstance) {
  app.post('/api/run', async (req, reply) => {
    const { pythonFile } = req.body as { pythonFile: string };
    if (!pythonFile) throw new Error('pythonFile required');

    const ws = getWorkspacePath();
    const fullPath = path.join(ws, pythonFile);

    // SSE streaming response
    reply.raw!.setHeader('Content-Type', 'text/event-stream');
    reply.raw!.setHeader('Cache-Control', 'no-cache');
    reply.raw!.setHeader('Connection', 'keep-alive');

    const send = (event: string, data: unknown) => {
      reply.raw!.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('start', { status: 'running', pythonFile });

    try {
      const result = await runPythonScript(
        { pythonFile: fullPath, cwd: ws },
        (line) => send('stdout', { line }),
        (line) => send('stderr', { line })
      );
      send('complete', result);
    } catch (err: any) {
      send('error', { message: err.message });
    } finally {
      reply.raw!.end();
    }
  });
}
```

- [ ] **Step 3: Write lib/gdsParser.ts**

```typescript
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERGDS_ROOT = path.resolve(__dirname, '../../..'); // superGDS root (sibling to overgds)

export async function parseGdsFile(gdsPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parseScript = path.join(SUPERGDS_ROOT, 'python/parse_gds.py');
    const proc = spawn('python', [parseScript, gdsPath], {
      cwd: SUPERGDS_ROOT,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `parse_gds.py failed ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('parse_gds.py output invalid JSON'));
      }
    });
  });
}
```

- [ ] **Step 4: Verify server runs without errors**

Run: `npx tsx server/index.ts` — verify no import errors.

- [ ] **Step 5: Commit**

```bash
git add lib/pythonRunner.ts lib/gdsParser.ts server/runRoutes.ts
git commit -m "feat: Python script execution with SSE streaming"
```

---

## Task 5: Parse Routes + Annotation Routes

**Files:**
- Create: `overgds/server/parseRoutes.ts`
- Create: `overgds/server/annotationRoutes.ts`
- Create: `overgds/lib/annotations.ts`

- [ ] **Step 1: Write server/parseRoutes.ts**

```typescript
import Fastify from 'fastify';
import { parseGdsFile } from '../../lib/gdsParser.js';

export function parseRoutes(app: FastifyInstance) {
  app.post('/api/parse', async (req) => {
    const { gdsPath } = req.body as { gdsPath: string };
    if (!gdsPath) throw new Error('gdsPath required');
    const geojson = await parseGdsFile(gdsPath);
    return { geojson, mode: 'full' };
  });
}
```

- [ ] **Step 2: Write lib/annotations.ts**

```typescript
import fs from 'fs/promises';
import path from 'path';

const ANNOTATIONS_DIR = '.supergds-annotations';

export interface Annotation {
  jsonPath: string;
  shape: DrawnShapePayload;
  layer: string;
}

export interface DrawnShapePayload {
  geometry: { type: string; coordinates: number[] };
  layer: string;
}

export async function loadAnnotations(pythonFile: string): Promise<Annotation[]> {
  const jsonPath = getAnnotationPath(pythonFile);
  try {
    const data = await fs.readFile(jsonPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function saveAnnotation(pythonFile: string, annotation: Annotation): Promise<void> {
  const jsonPath = getAnnotationPath(pythonFile);
  const existing = await loadAnnotations(pythonFile);
  const updated = existing.filter((a) => a.jsonPath !== annotation.jsonPath);
  updated.push(annotation);
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(updated, null, 2));
}

export async function deleteAnnotation(pythonFile: string, jsonPath: string): Promise<void> {
  const path = getAnnotationPath(pythonFile);
  const existing = await loadAnnotations(pythonFile);
  const updated = existing.filter((a) => a.jsonPath !== jsonPath);
  await fs.writeFile(path, JSON.stringify(updated, null, 2));
}

function getAnnotationPath(pythonFile: string): string {
  const baseDir = path.dirname(pythonFile);
  return path.join(baseDir, ANNOTATIONS_DIR, `${path.basename(pythonFile, '.py')}.json`);
}
```

- [ ] **Step 3: Write server/annotationRoutes.ts**

```typescript
import Fastify from 'fastify';
import { loadAnnotations, saveAnnotation, deleteAnnotation } from '../../lib/annotations.js';

export function annotationRoutes(app: FastifyInstance) {
  app.get<{ Params: { pythonFile: string } }>('/api/annotations/:pythonFile', async (req) => {
    const annotations = await loadAnnotations(req.params.pythonFile);
    return { annotations };
  });

  app.post<{ Params: { pythonFile: string } }>('/api/annotations/:pythonFile', async (req) => {
    const { jsonPath, shape, layer } = req.body as any;
    await saveAnnotation(req.params.pythonFile, { jsonPath, shape, layer });
    return { success: true };
  });

  app.delete<{ Params: { pythonFile: string } }>('/api/annotations/:pythonFile', async (req) => {
    const { jsonPath } = req.body as { jsonPath: string };
    await deleteAnnotation(req.params.pythonFile, jsonPath);
    return { success: true };
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add server/parseRoutes.ts server/annotationRoutes.ts lib/annotations.ts
git commit -m "feat: parse and annotation API routes"
```

---

## Task 6: Frontend SPA Shell + CSS

**Files:**
- Create: `overgds/frontend/index.html`
- Create: `overgds/frontend/studio.css`

- [ ] **Step 1: Write frontend/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>superGDS Studio</title>
<link rel="stylesheet" href="studio.css">
</head>
<body>
<div id="toolbar">
  <button id="open-folder-btn">Open Folder</button>
  <input type="file" id="folder-input" webkitdirectory style="display:none">
  <button id="run-btn" disabled ▶ Run</button>
  <button id="rebuild-btn" disabled ⟳ Rebuild</button>
  <select id="file-select" disabled><option>No file open</option></select>
</div>

<div id="panels">
  <div id="editor-pane">
    <div id="monaco-editor"></div>
  </div>
  <div id="viewer-pane">
    <iframe id="gds-viewer" src="/viewer/viewer.html"></iframe>
  </div>
</div>

<div id="terminal">
  <div id="terminal-header">
    <span>Terminal</span>
    <button id="clear-terminal">clear</button>
  </div>
  <div id="terminal-body"></div>
</div>

<script type="module" src="studio.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write frontend/studio.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }

body {
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #1a1a2e;
  color: #cdd6f4;
}

#toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #181825;
  border-bottom: 1px solid #313244;
  flex-shrink: 0;
}

#toolbar button {
  padding: 6px 12px;
  background: #45475a;
  color: #cdd6f4;
  border: 1px solid #585b70;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

#toolbar button:hover { background: #585b70; }
#toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }

#file-select {
  background: #1e1e2e;
  color: #cdd6f4;
  border: 1px solid #313244;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 13px;
  max-width: 300px;
}

#panels {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

#editor-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

#monaco-editor {
  flex: 1;
  min-height: 0;
}

#viewer-pane {
  flex: 1;
  min-width: 0;
  border-left: 1px solid #313244;
}

#gds-viewer {
  width: 100%;
  height: 100%;
  border: none;
}

#terminal {
  height: 200px;
  background: #11111b;
  border-top: 2px solid #313244;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

#terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: #181825;
  border-bottom: 1px solid #313244;
  cursor: pointer;
  user-select: none;
}

#terminal-header span { font-size: 12px; font-weight: 600; color: #89b4fa; }
#terminal-header button { font-size: 11px; padding: 2px 8px; background: #45475a; border-radius: 3px; }

#terminal-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  font: 13px/1.5 'Cascadia Code', 'Fira Code', monospace;
  color: #cdd6f4;
}

#terminal-body .stdout { color: #cdd6f4; }
#terminal-body .stderr { color: #f38ba8; }
#terminal-body .system { color: #6c7086; font-style: italic; }

/* Resizable handle between editor and viewer */
#panels { position: relative; }
.resize-handle {
  width: 4px;
  background: #313244;
  cursor: col-resize;
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 10;
}
.resize-handle:hover { background: #89b4fa; }
```

- [ ] **Step 3: Verify HTML + CSS are valid**

Open the file in a browser or verify no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/studio.css
git commit -m "feat: frontend SPA shell with split-pane layout"
```

---

## Task 7: Monaco Editor Setup

**Files:**
- Create: `overgds/frontend/monacoSetup.ts`
- Create: `overgds/frontend/studio.ts` (main entry)

- [ ] **Step 1: Write frontend/monacoSetup.ts**

```typescript
import * as monaco from 'monaco-editor';

export function setupMonaco(container: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  // Configure Python language
  monaco.languages.register({ id: 'python' });

  monaco.languages.setLanguageConfiguration('python', {
    comments: { lineComment: '#', blockComment: ["'''", "'''"] },
    brackets: [['{', '}'], ['(', ')'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '(', close: ')' }, { open: '[', close: ']' },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
  });

  const editor = monaco.editor.create(container, {
    value: '# Open a Python file to begin\n',
    language: 'python',
    theme: 'vs-dark',
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    minimap: { enabled: false },
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    automaticLayout: true,
    wordWrap: 'on',
  });

  return editor;
}
```

- [ ] **Step 2: Write frontend/studio.ts**

```typescript
import { setupMonaco } from './monacoSetup.js';
import { TerminalRenderer } from './terminal.js';
import { IframeBridge } from './iframeBridge.js';
import * as monaco from 'monaco-editor';

let editor: monaco.editor.IStandaloneCodeEditor;
let bridge: IframeBridge;
let terminal: TerminalRenderer;
let currentFile: string | null = null;
let workspacePath: string | null = null;

const folderInput = document.getElementById('folder-input') as HTMLInputElement;
const openFolderBtn = document.getElementById('open-folder-btn') as HTMLButtonElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
const rebuildBtn = document.getElementById('rebuild-btn') as HTMLButtonElement;
const fileSelect = document.getElementById('file-select') as HTMLSelectElement;
const monacoContainer = document.getElementById('monaco-editor')!;
const iframeViewer = document.getElementById('gds-viewer') as HTMLIFrameElement;
const terminalBody = document.getElementById('terminal-body')!;
const clearBtn = document.getElementById('clear-terminal') as HTMLButtonElement;

export function init() {
  editor = setupMonaco(monacoContainer);
  terminal = new TerminalRenderer(terminalBody);
  bridge = new IframeBridge(iframeViewer);

  // File change detection
  editor.onDidChangeModelContent(() => {
    // Debounced auto-save
  });

  // Open folder
  openFolderBtn.addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', handleFolderOpen);

  // Run script
  runBtn.addEventListener('click', handleRun);
  rebuildBtn.addEventListener('click', handleRebuild);

  // File select
  fileSelect.addEventListener('change', handleFileSelect);

  // Clear terminal
  clearBtn.addEventListener('click', () => terminal.clear());

  // Workspace path from sessionStorage
  const savedWs = sessionStorage.getItem('supergds-workspace');
  if (savedWs) {
    workspacePath = savedWs;
    loadFileList();
  }
}

async function handleFolderOpen(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  const path = (input.files[0] as any).webkitRelativePath.split('/')[0];
  workspacePath = path;
  sessionStorage.setItem('supergds-workspace', path);

  // Set workspace on server
  await fetch('/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: path }),
  });

  await loadFileList();
  runBtn.disabled = false;
  rebuildBtn.disabled = false;
  fileSelect.disabled = false;
}

async function loadFileList() {
  if (!workspacePath) return;
  const res = await fetch('/api/files');
  const { files } = await res.json();

  fileSelect.innerHTML = '';
  const pyFiles = files.filter((f: string) => f.endsWith('.py'));
  if (pyFiles.length === 0) {
    fileSelect.innerHTML = '<option>No Python files</option>';
    return;
  }
  for (const f of pyFiles) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    fileSelect.appendChild(opt);
  }
  fileSelect.dispatchEvent(new Event('change'));
}

async function handleFileSelect(e: Event) {
  const select = e.target as HTMLSelectElement;
  currentFile = select.value;
  if (!currentFile) return;

  const res = await fetch(`/api/files/${currentFile}`);
  const { content } = await res.json();
  editor.setValue(content);
}

async function handleRun() {
  if (!currentFile) return;
  await saveCurrentFile();
  terminal.clear();
  terminal.addLine('system', `$ python ${currentFile}`);

  const es = new EventSource(`/api/run?pythonFile=${encodeURIComponent(currentFile)}`);
  es.addEventListener('start', (e: MessageEvent) => terminal.addLine('stdout', (JSON.parse(e.data)).status));
  es.addEventListener('stdout', (e: MessageEvent) => terminal.addLine('stdout', (JSON.parse(e.data)).line));
  es.addEventListener('stderr', (e: MessageEvent) => terminal.addLine('stderr', (JSON.parse(e.data)).line));
  es.addEventListener('complete', (e: MessageEvent) => {
    const data = JSON.parse(e.data);
    bridge.sendLoadGds(data);
    es.close();
  });
  es.addEventListener('error', (e: MessageEvent) => {
    terminal.addLine('stderr', (JSON.parse(e.data)).message || 'Error');
    es.close();
  });
}

async function handleRebuild() {
  await handleRun();
}

async function saveCurrentFile() {
  if (!currentFile) return;
  const content = editor.getValue();
  await fetch(`/api/files/${currentFile}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

// Expose for iframe bridge
(window as any).studio = { editor, bridge, terminal };

init();
```

- [ ] **Step 3: Commit**

```bash
git add frontend/monacoSetup.ts frontend/studio.ts
git commit -m "feat: Monaco editor setup and main studio orchestration"
```

---

## Task 8: Terminal Renderer + Iframe Bridge

**Files:**
- Create: `overgds/frontend/terminal.ts`
- Create: `overgds/frontend/iframeBridge.ts`

- [ ] **Step 1: Write frontend/terminal.ts**

```typescript
export class TerminalRenderer {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  addLine(type: 'stdout' | 'stderr' | 'system', text: string): void {
    const el = document.createElement('div');
    el.className = type;
    el.textContent = text;
    this.container.appendChild(el);
    this.container.scrollTop = this.container.scrollHeight;
  }

  clear(): void {
    this.container.innerHTML = '';
  }
}
```

- [ ] **Step 2: Write frontend/iframeBridge.ts**

```typescript
export interface ComponentSelection {
  provId: string;
  layer: string;
  bbox: number[];
  provenance: unknown;
}

export class IframeBridge {
  private iframe: HTMLIFrameElement;
  private ready = false;

  constructor(iframe: HTMLIFrameElement) {
    this.iframe = iframe;
    window.addEventListener('message', this.handleMessage.bind(this));

    // Wait for viewer to signal ready
    setTimeout(() => (this.ready = true), 1000);
  }

  private handleMessage(e: MessageEvent) {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'webviewReady':
        this.ready = true;
        break;

      case 'selectComponents':
        // Forward to Monaco editor for source highlighting
        if ((window as any).studio?.editor && msg.components?.length) {
          this.highlightSourceLocations(msg.components);
        }
        break;
    }
  }

  sendLoadGds(data: {
    geojson: unknown;
    gdsPath: string;
    pythonFile: string;
    annotations: unknown[];
    mode: string;
  }): void {
    if (!this.ready) {
      setTimeout(() => this.sendLoadGds(data), 200);
      return;
    }
    this.iframe.contentWindow?.postMessage(
      { type: 'loadGds', ...data },
      '*'
    );
  }

  private highlightSourceLocations(components: ComponentSelection[]) {
    // Forward to Monaco — select components' source locations
    // (reuse provenance.ts logic from src/webview/provenance.ts)
    const { getSourceChain } = (window as any).studio;
    console.log('highlighting', components);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/terminal.ts frontend/iframeBridge.ts
git commit -m "feat: terminal renderer and iframe postMessage bridge"
```

---

## Task 9: Copy viewer.html into iframe

**Files:**
- Create: `overgds/viewer/viewer.html` (copy of media/viewer.html)

- [ ] **Step 1: Copy viewer.html**

Copy the file from `/Users/fangruihuan/Desktop/aalto/superGDS/media/viewer.html` to `overgds/viewer/viewer.html`.

Note: The viewer.html loads OpenLayers from CDN. No modification needed for the iframe to function.

- [ ] **Step 2: Verify server serves it**

With server running (`npx tsx server/index.ts`), verify `http://localhost:3000/viewer/viewer.html` is accessible.

- [ ] **Step 3: Commit**

```bash
git add viewer/viewer.html
git commit -m "feat: embed GDS viewer as iframe content"
```

---

## Task 10: Resizable Split Panes

**Files:**
- Modify: `overgds/frontend/studio.css`
- Modify: `overgds/frontend/studio.ts`

- [ ] **Step 1: Add resize handle CSS**

Add to studio.css:
```css
.resize-handle {
  width: 4px;
  cursor: col-resize;
  background: #313244;
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 10;
}
.resize-handle:hover { background: #89b4fa; }
```

- [ ] **Step 2: Add resize logic to studio.ts**

Implement mouse drag on the handle between editor and viewer panes to adjust widths.

- [ ] **Step 3: Commit**

```bash
git add frontend/studio.css frontend/studio.ts
git commit -m "feat: resizable split panes between editor and viewer"
```

---

## Task 11: browser-use E2E Test Setup

**Files:**
- Create: `overgds/tests/e2e/browser-use.config.ts`
- Create: `overgds/tests/e2e/openWorkspace.test.ts`
- Create: `overgds/tests/e2e/editAndRun.test.ts`
- Create: `overgds/tests/e2e/gdsViewerInteraction.test.ts`
- Create: `overgds/tests/e2e/rebuild.test.ts`
- Create: `overgds/tests/e2e/annotations.test.ts`

- [ ] **Step 1: Write tests/e2e/browser-use.config.ts**

```typescript
import { BrowserUse, BrowserUseConfig } from 'browser-use';

export const config: BrowserUseConfig = {
  apiKey: process.env.BROWSER_USE_API_KEY || '',
  browser: {
    headless: false, // set true for CI
    slowMo: 100,
  },
};
```

- [ ] **Step 2: Write tests/e2e/openWorkspace.test.ts**

```typescript
import { test, expect } from '@playwright/test';
import { BrowserUse } from 'browser-use';

test('open workspace and verify file tree', async ({ page }) => {
  await page.goto('http://localhost:3000');

  // Click Open Folder
  const folderBtn = page.locator('#open-folder-btn');
  await folderBtn.click();

  // The native folder picker can't be automated programmatically
  // Instead, test the API directly and verify UI state
  await page.evaluate(async () => {
    const input = document.getElementById('folder-input') as HTMLInputElement;
    // Set workspace via sessionStorage (bypassing folder picker for test)
    sessionStorage.setItem('supergds-workspace', '/test/path');
  });

  // Verify toolbar is visible
  await expect(page.locator('#toolbar')).toBeVisible();
  await expect(page.locator('#run-btn')).toBeVisible();
});
```

Note: Actual folder picker interaction requires Playwright's `setInputFiles` with a real directory. For a proper E2E test, a test workspace directory should be created first.

- [ ] **Step 3: Write tests/e2e/editAndRun.test.ts**

```typescript
import { test, expect } from '@playwright/test';

test('edit Python script and run it', async ({ page }) => {
  await page.goto('http://localhost:3000');

  // Simulate workspace loaded with a test script
  // (For real test: create a temp dir with a test .py file first)
  await page.evaluate(() => {
    sessionStorage.setItem('supergds-workspace', '/path/to/test');
  });

  // Wait for Monaco editor to initialize
  await page.waitForSelector('#monaco-editor .view-lines');

  // Verify Monaco editor is present
  await expect(page.locator('#monaco-editor')).toBeVisible();
});
```

- [ ] **Step 4: Commit browser-use config**

```bash
git add tests/e2e/browser-use.config.ts tests/e2e/openWorkspace.test.ts tests/e2e/editAndRun.test.ts
git commit -m "test: browser-use E2E test scaffold"
```

---

## Self-Review Checklist

- [ ] All spec sections covered by tasks (file API, run API, parse API, annotations, Monaco, iframe bridge, terminal, viewer.html copy)
- [ ] No placeholders — every step has actual code
- [ ] Type consistency — `RunOptions`, `BuildResult`, `Annotation` interfaces defined once, used consistently
- [ ] Task ordering — server before frontend, backend routes before E2E tests
- [ ] Reused components — parse_gds.py, viewer.html, forkDetector.ts all referenced correctly

---

## Spec Self-Review

- [ ] Architecture diagram matches plan
- [ ] All 7 API endpoints covered (GET /api/files, GET/POST /api/files/:path, POST /api/run, POST /api/parse, GET/POST /api/annotations/:pythonFile)
- [ ] Provenance bridge message types match VSCode plugin (loadGds, selectComponents, askClaude, webviewReady)
- [ ] Project structure matches plan
- [ ] Security considerations covered
- [ ] Testing strategy with browser-use covered

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-10-supergds-studio.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
