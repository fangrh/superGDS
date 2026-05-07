# Provenance Sidecar Integration Design

## Goal

Connect the gdsfactory fork's provenance tracking (sidecar JSON + shape properties) to the superGDS VS Code extension, so clicking a GDS component in the viewer shows its source file, line number, and full call chain in the built-in console panel.

## Context

The gdsfactory fork (`feat/provenance-tracking` branch) writes provenance data in two places:

1. **GDS shape property 1002**: Each polygon/label shape gets an integer `prov_id`
2. **Sidecar JSON** (`<filename>.provenance.json`): Maps `prov_id` → `{file, line, function, call_stack, ...}`

The VS Code extension's `parse_gds.py` currently reads GDS properties 1004/1005 and layer 255/255 for provenance, but does NOT read the sidecar JSON. This means provenance data is incomplete — only cell names are available, not file/line/function/call_chain.

## Architecture

### Data Flow

```
User Python script (GDS_PROVENANCE=1)
  │
  ├─ Component.add_polygon() → shape.property(1002) = prov_id
  │                          → sidecar entry {id, file, line, function, call_stack}
  │
  └─ Component.write_gds("foo.gds")
       ├─ writes foo.gds
       └─ writes foo.provenance.json

parse_gds.py
  │
  ├─ Read GDS file → shapes with property(1002) = prov_id
  ├─ Read sidecar JSON → {id → {file, line, function, call_stack}}
  │
  └─ Merge: shape's prov_id → lookup sidecar → full provenance
       │
       └─ GeoJSON feature.properties.provenance = {
            file, line, function, call_chain, cell, instance_name
          }

viewer.html (webview)
  │
  └─ User clicks polygon → Source tab shows file:line links
       └─ Click link → opens in VS Code editor at that line
```

### Sidecar JSON Format (produced by gdsfactory)

```json
{
  "version": 1,
  "entries": [
    {
      "id": 0,
      "component": "sub_cell",
      "element_type": "polygon",
      "file": "/path/to/user_script.py",
      "line": 42,
      "function": "make_sub",
      "source_text": "c.add_polygon(...)",
      "call_stack": ["user_script.py:10 in make_top", "user_script.py:50 in <module>"]
    }
  ]
}
```

## Changes

### File: `python/parse_gds.py`

**Add sidecar reading.** In `parse_gds()`:

1. After loading the GDS layout, check for `<gds_path_without_suffix>.provenance.json`
2. If sidecar exists, parse it and build `dict[int, entry]` keyed by `id`
3. Add new constant `PROV_ID_PROP_KEY = 1002`
4. In the shape iteration loop, read `shape.property(1002)` to get `prov_id`
5. If `prov_id` is found and sidecar has matching entry, construct provenance dict:
   ```python
   {
       "file": entry["file"],
       "line": entry["line"],
       "function": entry["function"],
       "call_chain": [
           {"file": entry["file"], "line": entry["line"], "function": entry["function"]},
           ...parse call_stack strings into structured format...
       ],
       "cell": cell_name,
       "source_text": entry.get("source_text", ""),
   }
   ```
6. The `call_stack` strings in sidecar are `"filename:line in function"` format — parse these into the structured `call_chain` array that the TypeScript `provenance.ts` already handles.

**No changes to gdsfactory code.** The fork's `feat/provenance-tracking` branch is used as-is.

### File: `src/webview/provider.ts`

**Remove `_outputChannel` output.** The user wants provenance displayed in the webview's built-in console (Source tab), not VS Code's Output panel.

1. Remove `showSelectionOutput()` call from `selectComponents` handler
2. Remove `_outputChannel` creation and related code
3. Keep `highlightOpenSourceLocations()` — editor decorations are still useful

### File: `media/viewer.html`

**No changes needed.** The Source tab already reads `feature.properties.provenance` from GeoJSON and renders source links. Once `parse_gds.py` provides complete provenance data (with `file`, `line`, `call_chain`), the existing webview code will display it.

### File: `src/webview/provenance.ts`

**No changes needed.** Already handles `call_chain` array format with `{file, line, function}` objects.

## Call Stack String Parsing

Sidecar `call_stack` entries are strings like `"user_script.py:10 in make_top"`. These need to be parsed into:

```typescript
{ file: "user_script.py", line: 10, function: "make_top" }
```

This parsing happens in `parse_gds.py` when building the provenance dict, so the TypeScript side receives clean structured data.

## What Success Looks Like

1. Run `suspended_superconductor_standalone.py` with `GDS_PROVENANCE=1`
2. GDS file generates alongside `.provenance.json` sidecar
3. Open GDS in superGDS viewer → polygons render on map
4. Click a polygon → Source tab shows source file:line link
5. Click the link → VS Code opens the Python file at that line
6. Call chain shows the full user-code path (e.g., `make_electrodes` → `main`)

## Out of Scope

- Modifying gdsfactory provenance implementation (use as-is)
- Sidecar file management / cleanup
- Provenance for non-shape elements (paths, text labels)
- Multi-file provenance correlation across GDS files
