---
date: 2026-05-08
status: approved
---

# Loop Index Provenance Tracking

## Problem

When components are generated in loops (user-script `for` loops or gdsfactory array placement via `add_ref(columns=N, rows=M)`), all shapes from the same source line look identical in the provenance system. There is no way to tell which iteration produced a given shape.

## Approach

Tag at placement time: store loop iteration indices in provenance entries when they are captured, rather than reverse-computing them from geometry later.

No performance impact — the provenance tracker already runs once per `add_ref` call. We only add integer fields to the dict it already builds. KLayout instance internals are untouched.

## Changes

### 1. Python provenance capture (`gdsfactory/provenance.py`)

**Array dimensions in `track_instance`**: Thread `columns`/`rows` through from `add_ref` and store as `loop_index`:

```python
def track_instance(self, parent_name, ref_name, instance_path, transform,
                   columns=1, rows=1):
    ...
    if columns > 1 or rows > 1:
        entry["loop_index"] = [columns, rows]
```

**User-script loop index in `_find_user_frame`**: After finding the user frame, check if the source line contains `enumerate` and look for common index variables (`i`, `idx`, `ix`, `iy`, etc.) in `frame.f_locals`. If found, store `[value]`. Best-effort heuristic — silently skips when detection fails.

```python
source_line = linecache.getline(filepath, current.f_lineno).strip()
loop_index = _try_extract_loop_index(current, source_line)
if loop_index is not None:
    user_info["loop_index"] = loop_index
```

**Thread `columns`/`rows` in `component.py`**: Pass array params from `add_ref` to `track_instance`.

### 2. Sidecar JSON format

New optional `loop_index` field (array of integers). Absent on non-loop entries for backward compatibility.

```json
{"id": 42, "component": "top", "element_type": "instance", "file": "top.py", "line": 20, "loop_index": [3, 5]}
{"id": 43, "component": "top", "element_type": "instance", "file": "top.py", "line": 35, "loop_index": [2]}
{"id": 44, "component": "top", "element_type": "instance", "file": "top.py", "line": 50}
```

### 3. TypeScript types (`src/webview/provenance.ts`)

Remove unused `call_index`, add `loop_index`:

```typescript
export interface ComponentProvenance {
    file?: string;
    line?: number | string;
    function?: string;
    class_name?: string;
    loop_index?: number[];      // [2] or [3, 5] etc.
    call_chain?: Array<{ file?: string; line?: number | string; function?: string }>;
    call_stack?: string[];
    cell?: string;
    instance_name?: string;
    area_um2?: number;
}
```

Python parser (`python/parse_gds.py`) passes through `loop_index` if present.

### 4. Source panel display (`src/webview/provenance.ts`)

New helper appended to file:line wherever provenance is shown:

```typescript
function formatLoopLabel(provenance: ComponentProvenance): string {
    if (!provenance.loop_index || provenance.loop_index.length === 0) return '';
    return ` (loop index [${provenance.loop_index.join(', ')}])`;
}
```

Display examples:

- `top.py:20 (loop index [3, 5])` — array placement
- `cells/ring.py:42 (loop index [2])` — user-script loop
- `cells/ring.py:42 (loop index [1, 3, 2])` — nested/multi-dim loop
- `cells/ring.py:12` — no loop info, unchanged

Applied in: source panel, info panel, `formatMentions` output to Claude.
