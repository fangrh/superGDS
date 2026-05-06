# superGDS VS Code Extension — Design Spec

**Goal:** A VS Code extension that adds a GDS layout viewer (webview) with provenance-to-Claude-Code tracing, integrated alongside the Python run workflow.

**Reference implementation:** gitea repo at `../gitea/` — gdsfactory fork, gds-parser/builder microservices, viewer.html (OpenLayers).

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────┐
│  VS Code Extension (TypeScript)                      │
│                                                      │
│  ┌──────────────────┐   ┌────────────────────────┐  │
│  │ Extension Core    │   │ Webview: GDS Canvas     │  │
│  │                   │   │                         │  │
│  │ - Python run 监听  │◄─►│ - OpenLayers 渲染       │  │
│  │ - venv/fork 检测   │   │ - 点击 → provenance     │  │
│  │ - Python 子进程解析 │   │ - 多选/图层/绘制        │  │
│  │ - Claude Code 桥接 │   │ - YAML 导出             │  │
│  └──────┬───────────┘   └────────────────────────┘  │
│         │                                             │
│         │ spawn (venv python)                         │
│  ┌──────▼───────────┐                                │
│  │ Python 解析脚本   │  klayout 读取 GDS → GeoJSON    │
│  │ parse_gds.py     │  + provenance 提取             │
│  └──────────────────┘                                │
│                                                      │
│  ┌──────────────────────┐                            │
│  │ Claude Code           │  ← 按需注入 provenance     │
│  │ (primaryEditor.open)  │                            │
│  └──────────────────────┘                            │
└─────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **TypeScript extension** — standard VS Code extension model, best ecosystem support
- **Inline GDS parsing** — spawn venv's Python with klayout to parse `.gds` → GeoJSON + provenance; no separate microservice
- **Webview renderer** — port gitea's `viewer.html` (OpenLayers 10, vanilla JS), adapted to VS Code webview via `postMessage`
- **Lazy Claude Code injection** — provenance collected on click, injected only when user clicks "Ask Claude"

---

## 2. Feature Layers

### P0 — Core Rendering
- OpenLayers GIS rendering of GDS geometry (Polygon, Path, Box)
- 16-color palette per layer
- Zoom, pan, fit-to-window
- Left sidebar: file list showing `.gds` files from current run

### P0 — Provenance Interaction
- Single-click polygon → properties panel (file, function, line, class, call_index)
- Ctrl+click multi-select → aggregate provenance display
- Box selection
- Source code preview tab (shows provenance-targeted source lines)
- **"Ask Claude" button** → injects selected components' provenance into Claude Code

### P1 — Drawing Tools
- Draw: rectangle, circle, line, polygon
- Select, Modify, Translate
- Snap to grid/feature toggle
- Delete key support
- YAML export for drawn shapes (describes "add waveguide here" to Claude)

### P1 — Layer Control + Export
- Layer visibility toggle (legend panel)
- Color legend
- Copy YAML (single + multi-component aggregate)
- Measurement tools (distance, area)

---

## 3. Python Run Button Integration

The "Show GDS" button sits next to the Python extension's run button in the editor title bar.

```
┌─ editor tab: my_design.py ─────────────────────────┐
│                                              ▶ │ ⊞  │
│                                            run │ gds │
└────────────────────────────────────────────────────┘
```

**Registration:** VS Code `contributes.menus` → `editor/title`, scoped to `resourceLangId == python`.

**Button states:**

| State | Icon | Meaning |
|-------|------|---------|
| Waiting | ⊞ gray | Python not run yet, or no `.gds` found |
| Ready | ⊞ green | `.gds` found, fork gdsfactory detected (full provenance) |
| No provenance | ⊞ orange | `.gds` found, upstream gdsfactory (geometry only) |

**Detection flow:**
1. Listen for `pythonTerminate` or file changes after Python run
2. Scan expected `.gds` output location (configurable, defaults to `./gds/` relative to workspace)
3. Find `.gds` newer than last run → run fork detector → update button state
4. Click button → open/activate webview panel → run `parse_gds.py` → render

---

## 4. GDS Parsing (Inline, via venv Python)

`python/parse_gds.py` — spawned as child process using venv's python:

```
Input:  path/to/file.gds
Output: JSON { geojson: FeatureCollection, provenance: { provId -> {file, function, line, class, call_index} } }
```

- Uses `klayout.db` to read GDSII binary
- Extracts geometry as GeoJSON Polygon/LineString features
- Extracts TEXT elements on layer 255/255 as provenance (matches gitea fork convention)
- Reads PROPATTR keys 1004/1005 for placement provenance
- Runs in venv's Python — inherits whatever gdsfactory/klayout version is installed

---

## 5. Fork Detection

`python/detect_fork.py` — spawned once at extension startup:

```python
import gdsfactory as gf
has_provenance = hasattr(gf.Component, '_capture_provenance') or \
                 callable(getattr(gf.Component, 'store_provenance_on_cell', None))
print(f"FORK={'true' if has_provenance else 'false'}")
```

Result cached for the session. Reevaluated on venv change.

---

## 6. Graceful Degradation

| Level | Condition | Geometry | Provenance | Ask Claude |
|-------|-----------|----------|------------|------------|
| **Full** | venv has fork gdsfactory | Full OpenLayers render | Full call chain | Enabled |
| **Partial** | venv has upstream gdsfactory | Full OpenLayers render | None | Disabled (button grayed) |
| **None** | No klayout in venv | Basic polygon outlines via TS GDS parser | None | Disabled |

- In Partial mode, hovering over components shows tooltip: "Install fork gdsfactory to enable provenance tracing"
- In None mode, falls back to a minimal TypeScript GDS binary reader (outline-only rendering)

---

## 7. Claude Code Injection

Uses Claude Code VS Code extension's public command API: `claude-vscode.primaryEditor.open(sessionId, initialPrompt)`.

### Flow

```
User clicks component(s) in viewer
  → webview posts selectComponents to extension
  → extension caches current selection
  → user clicks "Ask Claude" + types question
  → webview posts askClaude {components, question}
  → claudeBridge constructs prompt (see below)
  → vscode.commands.executeCommand(
      "claude-vscode.primaryEditor.open",
      null,  // new conversation
      prompt // pre-filled, user reviews before sending
    )
```

### Prompt format

```
## Selected GDS Components

### coupler_ring (WG layer)
- Source: designs/my_design.py:42 in ring_resonator()
- BBox: [(-10, -5), (10, 5)]
- Call chain: ring_resonator:42 -> mzi:15 -> add_ring:8

### waveguide_straight (WG layer)
- Source: designs/my_design.py:45 in ring_resonator()
- BBox: [(0, 0), (50, 5)]
- Call chain: ring_resonator:45 -> straight:22

---

<user's question>
```

---

## 8. Webview ↔ Extension Message Protocol

### Extension → Webview

| Message | Trigger | Payload |
|---------|---------|---------|
| `loadGds` | Show GDS button clicked | `{geojson, provenance, gdsPath, mode}` |
| `updateSelection` | External highlight request | `{provIds: string[]}` |
| `setMode` | Fork detection complete | `{mode: "full"\|"partial"}` |

### Webview → Extension

| Message | Trigger | Payload |
|---------|---------|---------|
| `selectComponents` | Click/multi-select components | `{components: [{provId, layer, bbox, provenance}]}` |
| `askClaude` | Ask Claude button + question | `{components, question}` |
| `exportYaml` | Copy YAML clicked | `{yaml}` |
| `drawShape` | Shape drawn | `{geometry, layer}` |
| `requestSource` | Source tab opened | `{file, line}` |

---

## 9. Project Structure

```
superGDS/
├── package.json              # VS Code extension manifest
├── tsconfig.json
├── src/
│   ├── extension.ts          # Entry: activate, register commands, coordinate
│   ├── pythonBridge.ts       # Spawn venv Python subprocess
│   ├── forkDetector.ts       # Detect fork/upstream/none
│   ├── gdsWatcher.ts         # Watch Python run → discover .gds files
│   ├── claudeBridge.ts       # Call claude-vscode command to inject context
│   └── webview/
│       ├── panel.ts          # Webview panel management
│       └── provider.ts       # Message handler for viewer communication
├── python/
│   ├── parse_gds.py          # GDS → GeoJSON + provenance (klayout)
│   └── detect_fork.py        # Detect gdsfactory version capabilities
├── media/
│   ├── viewer.html           # Ported from gitea viewer.html, adapted for webview
│   ├── viewer.css
│   ├── viewer.js             # OpenLayers rendering + postMessage communication
│   └── icons/
│       ├── gds-ready.svg     # Green ⊞
│       ├── gds-partial.svg   # Orange ⊞
│       └── gds-waiting.svg   # Gray ⊞
├── .vscodeignore
└── README.md
```

### Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `extension.ts` | Entry point, `activate()` registers commands, wires up modules |
| `pythonBridge.ts` | Unified interface for running scripts in venv python, returns stdout |
| `forkDetector.ts` | Runs detect_fork.py on startup, caches result, emits state changes |
| `gdsWatcher.ts` | Listens for `pythonTerminate`, scans for `.gds`, compares timestamps |
| `claudeBridge.ts` | Constructs prompt, calls `claude-vscode.primaryEditor.open` |
| `panel.ts` | Creates/manages webview panel lifecycle |
| `provider.ts` | Handles postMessage routing between extension and viewer |

---

## 10. Error Handling

- **No venv active:** Show info message "Activate a Python virtual environment to use GDS Viewer"
- **klayout not installed:** Detect in parse_gds.py; return error code; extension shows notification with install instructions
- **GDS parse failure:** Show error in viewer panel with stderr output
- **Claude Code not installed:** "Ask Claude" button hidden; show tooltip on hover
- **Fork gdsfactory not detected:** Degrade to Partial mode; show orange button with tooltip
- **Python run not detected:** Button stays gray; hover text "Run your Python script first"
