# superGDS Studio — Web Server Design

> **Status:** Draft — awaiting implementation

## Context

The superGDS VSCode extension provides:
- A Python script editor that runs GDS generation scripts
- A provenance-aware GDS viewer that shows which source code generated each component
- Provenance tracking through call chains (Python loops → KLayout arrays → GDS geometry)

Users want a browser-based equivalent — an Overleaf/Jupyter-like web server that:
1. Runs in a browser with a Monaco-based Python editor
2. Shows the provenance-aware GDS viewer (same as the VSCode plugin)
3. Executes Python scripts and streams build output
4. Works with browser-use for E2E testing

---

## Architecture

```
Browser                                  Server (Fastify)
┌────────────────────────────────────┐  ┌─────────────────────────────────────────┐
│  Monaco Editor (left pane)         │  │  GET  /api/files                        │
│  iframe: GDS Viewer (right pane)   │  │  GET  /api/files/:path                  │
│  Terminal Output (bottom pane)     │  │  POST /api/files/:path                 │
│  Toolbar (top)                     │  │  POST /api/run    → spawn python       │
│                                    │  │  POST /api/parse  → run parse_gds.py   │
│  ┌─────────── postMessage ───────┐│  │  GET  /api/annotations/:pyFile         │
│  │ Studio Frontend (single SPA)   ││  │  POST /api/annotations/:pyFile         │
│  └───────────────────────────────┘│  └─────────────────────────────────────────┘
└────────────────────────────────────┘                                    │
                                                                       Python
                                                               ┌───────▼────────┐
                                                               │ parse_gds.py   │
                                                               │ gds_debug.py   │
                                                               │ gdsfactory     │
                                                               └───────────────┘
```

**Stack:**
- Backend: Fastify (Node.js/TypeScript) + child_process for Python execution
- Frontend: Monaco Editor + reuse `media/viewer.html` in iframe + vanilla TS
- Reuse: `python/parse_gds.py`, `python/gds_debug.py` from existing codebase
- Testing: browser-use with the provided API key

---

## Frontend Layout

Single-page app with resizable split panes:

```
┌─────────────────────────────────────────────────────────────────┐
│ Toolbar: [Open Folder] [▶ Run] [⟳ Rebuild] [file.txt ▼]        │
├───────────────────────────┬───────────────────────────────────┤
│                           │                                   │
│   Monaco Editor           │   iframe: GDS Viewer              │
│   (Python, full syntax)   │   (viewer.html, provenance-aware) │
│                           │                                   │
│                           │                                   │
├───────────────────────────┴───────────────────────────────────┤
│ Terminal Output  [clear]                                       │
│ $ python script.py                                             │
│ Building GDS...                                                │
│ Done.                                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

### `GET /api/files`

List files in the workspace directory.

**Response:** `200 OK`
```json
{ "files": ["script.py", "config.py", "subdir/module.py"] }
```

---

### `GET /api/files/:path`

Read a file's contents.

**Response:** `200 OK`
```json
{ "content": "import gdsfactory as kf\n...", "path": "script.py" }
```

**Errors:** `404` if file not found

---

### `POST /api/files/:path`

Write file contents. Body: `{ "content": string }`.

**Response:** `200 OK`
```json
{ "success": true }
```

---

### `POST /api/run`

Execute a Python script and stream output.

**Request:**
```json
{ "pythonFile": "script.py", "gdsOutputDir": "./" }
```

**Response (SSE stream):**
```
event: start
data: {"status": "running", "pythonFile": "script.py"}

event: stdout
data: {"line": "Building GDS..."}

event: stdout
data: {"line": "Done."}

event: complete
data: {"gdsPath": "output.gds", "geojson": {...}, "annotations": [...], "mode": "full"}
```

**Errors:**
- `400` if `pythonFile` missing
- `500` if script fails

---

### `POST /api/parse`

Parse a GDS file to GeoJSON + provenance.

**Request:** `{ "gdsPath": "output.gds" }`

**Response:** `200 OK`
```json
{ "geojson": {...}, "mode": "full", "annotations": [...] }
```

---

### `GET /api/annotations/:pythonFile`

Load annotations for a Python file.

**Response:** `200 OK`
```json
{ "annotations": [{ "jsonPath": "...", "shape": {...}, "layer": "WG" }] }
```

---

### `POST /api/annotations/:pythonFile`

Save an annotation.

**Request:** `{ "jsonPath": "...", "shape": {...}, "layer": "WG" }`

**Response:** `200 OK`
```json
{ "success": true }
```

---

## Provenance Bridge (Frontend)

The Monaco editor and GDS viewer iframe communicate via `postMessage`:

1. **Editor → Viewer**: When user selects a component in the viewer, the iframe sends `selectComponents` message. The frontend highlights the corresponding line in Monaco via the source location data.
2. **Viewer ← Frontend**: After `/api/run` completes, the frontend sends `loadGds` message to the iframe (same shape as VSCode plugin's `panel.webview.postMessage`).

Message types mirror those in `src/webview/provider.ts`:
- `loadGds` — `{ type, geojson, gdsPath, pythonFile, annotations, mode }`
- `selectComponents` — `{ type, components, claudeMode }` (forwarded to Monaco)
- `askClaude` — `{ type, components, question }`
- `webviewReady` — `{ type }` (iframe → frontend on load)

---

## Workspace Management

- User opens a folder via `<input type="file" webkitdirectory>` (or native folder picker)
- The selected folder path is stored in `sessionStorage` (browser tab session only)
- All file operations (`/api/files`) are relative to this workspace root
- Script execution runs with the workspace root as `cwd`
- No persistent server-side state — each browser tab is an independent workspace

---

## Project Structure

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
│       ├── browser-use.config.ts   # API key + browser config
│       ├── openWorkspace.test.ts    # Open folder, verify file tree
│       ├── editAndRun.test.ts       # Edit script, run, verify output
│       ├── gdsViewerInteraction.test.ts  # Select component, verify provenance
│       └── annotations.test.ts     # Draw annotation, save, reload
├── package.json
├── tsconfig.json
└── SPEC.md                   # This file
```

---

## Reused Components

| Component | Source | Purpose |
|-----------|--------|---------|
| `parse_gds.py` | `../python/parse_gds.py` | GDS → GeoJSON + provenance |
| `gds_debug.py` | `../python/gds_debug.py` | GDS debugging annotations |
| `forkDetector.ts` | `../src/forkDetector.ts` | Detect fork vs upstream |
| `provenance.ts` | `../src/webview/provenance.ts` | Source location formatting |
| `viewer.html` | `../media/viewer.html` | GDS viewer iframe content |
| `viewer.css` | inline in viewer.html | GDS viewer styles |

---

## Security Considerations

- Workspace is browser-session only — no server-side storage of user files
- Python script execution is sandboxed to the workspace directory (`cwd`)
- File read/write restricted to workspace subtree
- No shell execution — only `python` subprocess with script path
- Provenance data is purely informational — no user-controlled injection vectors

---

## Testing Strategy

browser-use E2E tests against `http://localhost:3000`:

1. **openWorkspace.test.ts** — Open folder picker, verify file tree loads
2. **editAndRun.test.ts** — Open `script.py`, edit, click Run, verify terminal output
3. **gdsViewerInteraction.test.ts** — Click component in viewer, verify source link appears in sidebar
4. **rebuild.test.ts** — Click Rebuild, verify viewer reloads with new GDS
5. **annotations.test.ts** — Draw rectangle annotation, save, close tab, reopen, verify persistence

browser-use API key configured via environment: `BROWSER_USE_API_KEY=<set in your shell; never commit real keys>`

---

## Deferred / Out of Scope

- Multi-tab / multi-workspace (per user question, Approach 1 only)
- GDS-specific DSL scripting (Python only for now)
- Authentication / user management
- Persistent workspace storage (server-side)
- Mobile / touch interactions
