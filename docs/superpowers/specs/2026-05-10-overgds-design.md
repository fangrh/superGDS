# OverGDS — Web UI for GDS Script Editing and Visualization

## Context

`superGDS` is a VS Code extension that renders GDSII layout files in an OpenLayers webview, shows provenance (which Python code created each polygon), and lets users inject component context into Claude Code. The extension is tied to VS Code.

Users want a **browser-based version** that works like Overleaf: a split-panel UI where the left side is a code editor and the right side is the GDS visualizer. Users pick a project folder (a git repo on the local filesystem), run a script, and see the rendered GDS update in real-time.

## Architecture Overview

```
overgds/                          # New git repo, sibling to superGDS
├── frontend/                     # Next.js app
│   ├── app/
│   │   ├── layout.tsx           # App shell with split panels
│   │   ├── page.tsx             # Main editor + GDS view
│   │   ├── projects/           # Project folder picker / project list
│   │   └── components/
│   │       ├── FileTree.tsx     # Basic file navigation
│   │       ├── MonacoEditor.tsx # Monaco-based Python editor
│   │       ├── GdsViewer.tsx    # OpenLayers GDS renderer (from viewer.html)
│   │       └── Console.tsx      # Bottom console for provenance output
│   ├── server/
│   │   └── api/
│   │       ├── projects/       # GET /api/projects, POST /api/projects (list/add project folder)
│   │       ├── files/          # GET /api/files?path=X, PUT /api/files (read/write files)
│   │       ├── run/            # POST /api/run (spawn Python subprocess for a script)
│   │       └── gds/            # GET /api/gds?project=X&script=Y (parse GDS → GeoJSON)
│   ├── lib/
│   │   └── pythonBridge.ts     # Spawn Python subprocess (parse_gds.py, run script)
│   └── package.json
├── parse_gds.py                  # Copied from superGDS/python/
└── README.md

superGDS/                         # Existing repo
└── .gitignore                   # Add "overgds/" entry
```

## Tech Stack

- **Frontend:** Next.js (App Router, TypeScript)
- **Editor:** Monaco Editor (React wrapper via `@monaco-editor/react`)
- **GDS Viewer:** OpenLayers 10 — reuse `media/viewer.html` as a React component iframe or direct implementation
- **Backend:** Next.js API Routes + Python subprocess bridge (no separate server process)
- **Python GDS parsing:** Copied from `superGDS/python/parse_gds.py` (klayout-based)
- **File watching:** Polling-based (simple `setInterval`) for GDS output changes
- **Project location:** Local filesystem folders (git repos)

## Key Design Decisions

### Project Model
- A **project** = a local filesystem directory (git repo root or subfolder)
- Users "open" a project by selecting a folder via the Next.js API route
- Project list stored in `~/.config/overgds/projects.json` (persisted on the local machine)
- No database — everything is filesystem-based

### Running Scripts
- User clicks **Run** in the editor toolbar → POST `/api/run` with `{ projectPath, scriptPath }`
- Server spawns `python /path/to/script.py` in a temporary environment, watching for `.gds` output
- Once a `.gds` file appears, automatically triggers `/api/gds` to parse it → returns GeoJSON
- Output (stdout/stderr) streams back via SSE (Server-Sent Events) or polling

### GDS Parsing Flow
1. User opens a project → file tree shows `*.py` files
2. User edits a Python script (e.g., `design.py`)
3. User clicks **Run** → `python design.py` executes in the project directory
4. Script writes a `.gds` file to the `gds/` output folder
5. Backend detects the new GDS → runs `parse_gds.py` via klayout → returns GeoJSON + provenance
6. Frontend updates the OpenLayers viewer with new geometry + provenance data

### Editor-GDS Sync
- **Source panel** in the GDS viewer's console shows highlighted Python source lines
- Clicking a polygon in the GDS view highlights the corresponding source lines in the editor (via Monaco's decoration API)
- "Ask Claude" button: constructs a prompt with component provenance and opens Claude Code with the context

### Layout (Overleaf-style)
```
┌────────────────────────────────────────────────────────────────┐
│ [Project: my_design ▼] [Run ▶] [Save] [Ask Claude 🤖]          │  ← Toolbar
├─────────────────────┬──────────────────────────────────────────┤
│                     │                                          │
│   File Tree         │         Monaco Editor                    │
│   (120px)           │         (flex: 1)                       │
│                     │                                          │
│   design.py         │   from gdsfactory import gf...          │
│   tests/            │   import klayout.db as kdb...           │
│   gds/              │                                          │
│                     ├──────────────────────────────────────────┤
│                     │                                          │
│                     │         GDS Viewer (OpenLayers)         │
│                     │         (flex: 1, min-height: 300px)    │
│                     │                                          │
├─────────────────────┴──────────────────────────────────────────┤
│ Console: Component info, provenance, errors            (200px) │
└────────────────────────────────────────────────────────────────┘
```

Resizable split vertically between Editor and GDS Viewer (top/bottom or left/right — configurable via drag handle).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List saved project paths |
| POST | `/api/projects` | Add a new project path (`{ path }`) |
| DELETE | `/api/projects/:path` | Remove a project path |
| GET | `/api/files?project=:path` | List files in a project (recursive, `*.*`) |
| GET | `/api/files?project=:path&file=:filepath` | Read a specific file |
| PUT | `/api/files` | Write a file (`{ projectPath, filePath, content }`) |
| POST | `/api/run` | Run a Python script (`{ projectPath, scriptPath }`) — returns SSE stream |
| GET | `/api/gds?project=:path&script=:script` | Parse GDS from latest script run → GeoJSON + provenance |
| GET | `/api/gds/status` | Check if GDS is currently indexed |

## Security Considerations

- API routes validate that `projectPath` is an existing directory and `filePath` is within `projectPath` (no path traversal)
- Python subprocess runs with inherited env (no shell access from the web UI)
- No user authentication needed (single-user local server)
- Rate limiting on `/api/run` to prevent runaway processes

## What We're NOT Building (Scope Cut)

- No git operations in the UI (git is managed outside the browser)
- No user accounts / auth
- No project database — filesystem only
- No collaborative editing
- No persistent Python daemon — spawns per-run
- No refactoring / rename features in the web UI (those belong to the VS Code extension)

## Next Steps

1. Scaffold Next.js app in `overgds/`
2. Implement API routes for projects, files, run, gds
3. Build the split-panel layout with Monaco + OpenLayers
4. Wire editor → run → GDS parse → viewer flow
5. Test with an existing gdsfactory project
