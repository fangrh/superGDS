# Variable Name Display in Source Console and Clipboard

**Date:** 2026-05-09

**Goal:** Show the Python variable name alongside the instance ref name in the source console, clipboard, and Claude prompt. When the variable is inside a for-loop or the component is part of an array, display contextual warnings with actionable suggestions.

**Motivation:** The `insts["name"]` value can change when the user edits their script. Surfacing the Python variable name provides a second anchor for identifying which code produced a given instance, improving traceability and script coherence.

---

## Architecture

The feature extends the existing provenance pipeline at three layers:

1. **Capture** — `_find_user_frame()` in `gdsfactory/gdsfactory/provenance.py` extracts the LHS variable name from `source_text` and detects loop/array context.
2. **Threading** — `parse_gds.py` passes the new fields through to the viewer, same path as `source_text` and `loop_index`.
3. **Display** — Viewer HTML, clipboard formatter, and Claude prompt builder each render a `Var:` line with contextual warnings.

No new files are created. All changes are in-place modifications to existing files.

---

## Data Model

### New fields in provenance entry (Python sidecar)

| Field | Type | Source |
|---|---|---|
| `variable_name` | `str \| null` | Extracted from `source_text` via regex `^(\w+)\s*=` |
| `variable_in_loop` | `bool` | `true` when `loop_index` is present (the variable is reassigned each iteration) |

### New fields in TypeScript interface

In `src/webview/provenance.ts`, `ComponentProvenance` gains:

```typescript
variable_name?: string;
variable_in_loop?: boolean;
```

These are optional. Existing provenance data without these fields continues to work.

---

## Data Flow

### 1. Capture — `provenance.py`

In `_find_user_frame()`, after `source_text` is captured (line 98), extract the variable name:

```python
source_line = linecache.getline(filepath, current.f_lineno).strip()
# ... existing code ...
user_info = {
    "file": filepath,
    "line": current.f_lineno,
    "function": current.f_code.co_name,
    "source_text": source_line,
    "call_stack": call_stack,
}
```

Add variable name extraction immediately after `user_info` is built:

```python
# Extract LHS variable name from source line
_assign_match = re.match(r"^(\w+)\s*=", source_line)
if _assign_match:
    user_info["variable_name"] = _assign_match.group(1)
```

The `variable_in_loop` flag is derived from `loop_index` presence at the point where `loop_index` is already detected:

```python
loop_index = _try_extract_loop_index(current, source_line)
if loop_index is not None:
    user_info["loop_index"] = loop_index
    if "variable_name" in user_info:
        user_info["variable_in_loop"] = True
```

This goes into the sidecar JSON entry verbatim — no extra processing needed.

### 2. Threading — `parse_gds.py`

In `_build_provenance_from_sidecar()`, pass through the two new fields alongside the existing `source_text` passthrough (lines 87–89):

```python
source_text = entry.get("source_text")
if source_text:
    prov["source_text"] = source_text
variable_name = entry.get("variable_name")
if variable_name:
    prov["variable_name"] = variable_name
variable_in_loop = entry.get("variable_in_loop")
if variable_in_loop:
    prov["variable_in_loop"] = variable_in_loop
```

No signature changes needed — this function already receives the full `entry` dict.

### 3. Display — Viewer (`viewer.html`)

After the existing "Ref" block (lines 556–563), add a "Var" block:

```javascript
// Variable name
var varName = prov.variable_name;
if (varName) {
    var varDiv = document.createElement('div');
    varDiv.className = 'kv';
    varDiv.innerHTML = '<span class="key" style="color:#585b70;">&nbsp;&nbsp;Var</span>'
        + '<span class="val" style="color:#6c7086;">' + esc(varName) + '</span>';
    panel.appendChild(varDiv);

    // Warnings
    if (prov.variable_in_loop) {
        var warnDiv = document.createElement('div');
        warnDiv.className = 'kv';
        var plural = varName + 's';
        warnDiv.innerHTML = '<span class="key" style="color:#f9e2af;">&nbsp;&nbsp;⚠</span>'
            + '<span class="val" style="color:#f9e2af;">loop variable — may be overwritten each iteration</span>';
        panel.appendChild(warnDiv);
        var tipDiv = document.createElement('div');
        tipDiv.className = 'kv';
        tipDiv.innerHTML = '<span class="key" style="color:#89b4fa;">&nbsp;&nbsp;💡</span>'
            + '<span class="val" style="color:#89b4fa;">store in array (e.g. '
            + esc(plural) + '[i] = ' + esc(varName) + ') to reference by variable name</span>';
        panel.appendChild(tipDiv);
    }
    if (prov.array_index && prov.array_index.length > 0) {
        var arrDiv = document.createElement('div');
        arrDiv.className = 'kv';
        arrDiv.innerHTML = '<span class="key" style="color:#f9e2af;">&nbsp;&nbsp;⚠</span>'
            + '<span class="val" style="color:#f9e2af;">array element — variable name refers to the whole array, not this individual element</span>';
        panel.appendChild(arrDiv);
    }
}
```

Warning colors use Catppuccin Mocha palette (already used in the viewer): `#f9e2af` for warnings (yellow), `#89b4fa` for tips (blue).

### 4. Display — Clipboard (`provider.ts`)

In `formatComponentMentions()`, after the existing `Ref:` line, add:

```typescript
const varName = components[i].provenance?.variable_name;
if (varName) {
    lines.push(`  Var: ${varName}`);
    if (components[i].provenance?.variable_in_loop) {
        const plural = varName + 's';
        lines.push(`  ⚠ loop variable — may be overwritten each iteration`);
        lines.push(`  💡 store in array (e.g. ${plural}[i] = ${varName}) to reference by variable name`);
    }
    if (components[i].provenance?.array_index && components[i].provenance.array_index.length > 0) {
        lines.push(`  ⚠ array element — variable name refers to the whole array, not this individual element`);
    }
}
```

### 5. Display — Claude Prompt (`claudeBridge.ts`)

Same format as clipboard. The `buildPrompt()` function already accesses `instance_name`; add `variable_name` in the same location.

---

## Display Format Summary

### Normal case (not in loop, not array)

```
Selected #1: @file.py#380
  ← @helper.py#25
  Ref: Via1_Horizontal
  Var: electrode
```

### Variable in for-loop

```
Selected #1: @file.py#380 (loop index [3])
  ← @helper.py#25
  Ref: Via1_Horizontal
  Var: hole
  ⚠ loop variable — may be overwritten each iteration
  💡 store in array (e.g. holes[i] = hole) to reference by variable name
```

### Array element

```
Selected #1: @file.py#380 (array index [2, 1])
  ← @helper.py#25
  Ref: Via1_Horizontal
  Var: via_array
  ⚠ array element — variable name refers to the whole array, not this individual element
```

### No variable name (e.g. bare expression without assignment)

```
Selected #1: @file.py#380
  ← @helper.py#25
  Ref: Via1_Horizontal
```

No `Var:` line shown — falls back to current behavior.

---

## Edge Cases

| Case | Behavior |
|---|---|
| `source_text` has no `=` sign | No `variable_name` captured, no `Var:` line |
| Multiple assignments on one line | Regex matches first `word =`, which is the LHS |
| Variable name is `_` (throwaway) | Still captured — user chose that name |
| Chained assignment `a = b = func()` | Captures `a` (first LHS) |
| Walrus operator `(x := expr)` | Not matched by `^(\w+)\s*=` — correctly skipped |
| Both loop and array | Both warnings shown |

---

## Files to Modify

| File | Change |
|---|---|
| `gdsfactory/gdsfactory/provenance.py` | Extract `variable_name` in `_find_user_frame()` |
| `python/parse_gds.py` | Pass through `variable_name` and `variable_in_loop` in `_build_provenance_from_sidecar()` |
| `src/webview/provenance.ts` | Add `variable_name?` and `variable_in_loop?` to `ComponentProvenance` interface |
| `media/viewer.html` | Add `Var:` line and warnings after `Ref:` block |
| `src/webview/provider.ts` | Add `Var:` line and warnings in `formatComponentMentions()` |
| `src/claudeBridge.ts` | Add `Var:` line and warnings in `buildPrompt()` |

---

## Testing

1. Build a GDS with provenance enabled (`GDS_PROVENANCE=1`) using a script that has:
   - A normal component with assignment (`electrode = gf.Component(...)`)
   - A component inside a for-loop (`hole = gf.Component(...)` inside `for h in holes:`)
   - An arrayed component reference
2. Verify the `.provenance.json` sidecar contains `variable_name` and `variable_in_loop` fields
3. Open the GDS viewer, select each component type, verify the source console shows:
   - `Var: electrode` (no warning)
   - `Var: hole` with loop warning and suggestion
   - `Var: via_array` with array warning
4. Copy to clipboard and verify the same format appears
5. Verify Claude prompt includes `Var:` information
