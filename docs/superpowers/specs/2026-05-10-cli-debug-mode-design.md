---
date: 2026-05-10
status: approved
---

# CLI Debug Mode for superGDS

## Problem

The superGDS viewer runs inside a VS Code webview. Testing and debugging
provenance logic (loop_index, array_index, Ctrl+A grouping) requires manually
clicking in the GUI. AI agents like Claude cannot interact with the webview
directly, making autonomous testing impossible.

## Goal

A headless Python CLI that exposes the same data-level operations as the
viewer — parse, click/select, Ctrl+A L1/L2 grouping, and provenance
diagnostics — so an AI agent can run commands via Bash, inspect JSON output,
and iteratively test and debug the provenance pipeline without VS Code or a
browser.

## Approach

Single Python script (`python/gds_debug.py`) with subcommands, pickle-based
caching for fast repeated queries, and JSON output. Reuses the existing
`parse_gds.parse_gds()` parser and ports the viewer's JS grouping logic to
Python as a reference implementation.

## Command Interface

All commands target a `.gds` file and output JSON to stdout. Errors go to
stderr with a JSON `{"status": "error"}` envelope on stdout.

Cache is enabled by default. Parsed data is saved to `<stem>.debug_cache.pkl`
alongside the GDS file. Cache invalidates when the GDS file's mtime changes.
Use `--no-cache` to force re-parse.

| Command | Description |
|---------|-------------|
| `parse <file.gds>` | Parse GDS, print summary (feature count, layers, bbox) |
| `click <file.gds> --at x,y` | Select feature nearest to (x,y) |
| `click <file.gds> --index N` | Select feature by index |
| `ctrl-a <file.gds> --index N --level 1\|2` | Simulate Ctrl+A L1 or L2 grouping |
| `diagnose <file.gds>` | Provenance health check with warnings |

`--verbose` flag adds human-readable formatting alongside JSON.

## Architecture

```
gds_debug.py
├── GdsCache          # pickle cache with mtime validation
├── GdsSession        # parsed state + query operations
│   ├── parse()           # calls parse_gds.parse_gds()
│   ├── click(x, y)       # nearest-centroid lookup
│   ├── click_index(n)    # direct feature access
│   ├── ctrl_a(index, level)  # L1/L2 grouping (ported from viewer.html)
│   └── diagnose()        # provenance health analysis
└── main()            # argparse subcommands → JSON output
```

### Key decisions

1. **Reuse `parse_gds.parse_gds()`** — no duplicate parsing logic. `GdsSession`
   calls the existing function and holds the resulting FeatureCollection.

2. **Port JS grouping to Python** — the L1 (instance_name base matching) and
   L2 (loop_index comparison) grouping logic from `viewer.html handleCtrlA()` is
   pure data manipulation. Porting it to Python gives the CLI identical behavior
   and serves as a testable reference implementation.

3. **Click = nearest centroid** — finds the feature whose geometry centroid is
   closest to (x,y). Purpose is feature identification, not pixel-perfect hit
   testing.

4. **Pickle cache** — a 10MB GDS takes 1-2s to parse but <100ms to load from
   pickle. Cache stores the parse_gds output dict plus the GDS mtime.

## Output Formats

### `parse`

```json
{"status": "ok", "features": 1204, "layers": ["1/0", "2/0"], "bbox": [...], "cache": "hit"}
```

### `click --at x,y`

```json
{
  "status": "ok",
  "index": 42,
  "distance": 3.5,
  "layer": "1/0",
  "bbox": [97.0, 195.0, 103.0, 205.0],
  "provenance": {"file": "top.py", "line": 15, "instance_name": "ring_0", "array_index": [2, 0], "loop_index": [1]},
  "cache": "hit"
}
```

### `click --index N`

Same structure as `click --at` but without the `distance` field.

### `ctrl-a --index N --level 1|2`

```json
{
  "status": "ok",
  "anchor_index": 42,
  "anchor_instance_base": "ring",
  "level": 1,
  "group_indices": [39, 40, 41, 42, 43, 44],
  "group_provenance": [
    {"index": 39, "instance_name": "ring_0", "array_index": [0,0], "loop_index": [0]},
    ...
  ],
  "cache": "hit"
}
```

### `diagnose`

```json
{
  "status": "ok",
  "total_features": 1204,
  "with_provenance": 1100,
  "with_loop_index": 600,
  "with_array_index": 300,
  "loop_index_distribution": {"[0]": 200, "[1]": 200, "[2]": 200},
  "warnings": [
    {"type": "shared_cell_overwrite", "cell": "rectangle", "placements": 6},
    {"type": "ambiguous_loop_index", "loop_index": [0], "distinct_sources": 2, "files": ["top.py:10", "top.py:20"]}
  ],
  "cache": "hit"
}
```

### Errors

```json
{"status": "error", "message": "No feature found near (99999, 99999)"}
```

## Diagnostics

The `diagnose` command flags three classes of provenance issues:

### Warning: shared_cell_overwrite

When the same child component is placed multiple times (e.g. in two for-loops),
`tag_shapes_with_placement` overwrites shape property 1004 on the shared child
cell. All instances end up with the last placement's `instance_prov_id`, so all
shapes get the wrong `loop_index`.

Detection: count distinct instances referencing the same cell name. If more
than one and all shape properties 1004 point to the same `instance_prov_id`,
emit a warning.

### Warning: ambiguous_loop_index

Two sequential for-loops with the same range produce identical `loop_index`
values. L2 grouping cannot distinguish them.

Detection: find features with the same `loop_index` but different source
file+line combinations. If `loop_index` [0] appears at both `top.py:10` and
`top.py:20`, emit a warning.

### Warning: missing_provenance

Shapes without PROV_ID, instance_name, or expected loop_index.

Detection: features where provenance dict is empty or missing expected keys.

## Files

| File | Action |
|------|--------|
| `python/gds_debug.py` | Create |
