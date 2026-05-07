# Provenance Sidecar Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect gdsfactory fork's provenance sidecar JSON to parse_gds.py so clicking a GDS component shows source file, line number, and call chain in the viewer's built-in console.

**Architecture:** parse_gds.py reads the `.provenance.json` sidecar (written by gdsfactory when `GDS_PROVENANCE=1`), maps shape `property(1002)` IDs to sidecar entries, and outputs structured `call_chain` in GeoJSON. The viewer.html and provenance.ts already handle this format — no webview changes needed. provider.ts removes the `_outputChannel` since display goes to the built-in console.

**Tech Stack:** Python (parse_gds.py), TypeScript (provider.ts), klayout.db for GDS property reading

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `python/parse_gds.py` | Modify | Read sidecar JSON, map prov_id → provenance |
| `src/webview/provider.ts` | Modify | Remove `_outputChannel` output |

---

### Task 1: Add sidecar reading to parse_gds.py

**Files:**
- Modify: `python/parse_gds.py`

This task adds the `_load_sidecar()` function and integrates it into the shape iteration loop.

- [ ] **Step 1: Add PROV_ID_PROP_KEY constant and _load_sidecar function**

Add after line 16 (`INSTANCE_PROP_KEY = 1005`):

```python
PROV_ID_PROP_KEY = 1002


def _load_sidecar(gds_path):
    """Load .provenance.json sidecar and return {id: entry} mapping.

    Returns empty dict if sidecar doesn't exist or is malformed.
    """
    sidecar_path = os.path.splitext(gds_path)[0] + ".provenance.json"
    if not os.path.exists(sidecar_path):
        return {}
    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        entries = data.get("entries", [])
        return {e["id"]: e for e in entries if "id" in e}
    except (json.JSONDecodeError, OSError):
        return {}
```

- [ ] **Step 2: Add _parse_call_stack_string helper**

Add after `_load_sidecar`:

```python
def _parse_call_stack_string(frame_str):
    """Parse 'filename:line in function' into {file, line, function} dict."""
    import re
    m = re.match(r"^(.+?):(\d+)\s+in\s+(.+)$", frame_str)
    if not m:
        return None
    return {"file": m.group(1), "line": int(m.group(2)), "function": m.group(3)}
```

- [ ] **Step 3: Add _build_provenance_from_sidecar function**

Add after `_parse_call_stack_string`:

```python
def _build_provenance_from_sidecar(entry, cell_name):
    """Build provenance dict from a sidecar entry.

    Converts sidecar format to the provenance structure expected by
    the VS Code extension (provenance.ts / viewer.html).
    """
    prov = {
        "file": entry.get("file", ""),
        "line": entry.get("line", 0),
        "function": entry.get("function", ""),
    }

    # Build call_chain from primary source + call_stack strings
    call_chain = [{"file": prov["file"], "line": prov["line"], "function": prov["function"]}]
    for cs in entry.get("call_stack", []):
        parsed = _parse_call_stack_string(cs)
        if parsed is not None:
            call_chain.append(parsed)
    prov["call_chain"] = call_chain

    if entry.get("source_text"):
        prov["source_text"] = entry["source_text"]
    if cell_name:
        prov["cell"] = cell_name

    return prov
```

- [ ] **Step 4: Update _get_feature_provenance to use sidecar**

Replace the existing `_get_feature_provenance` function (lines 100-138) with:

```python
def _get_feature_provenance(iterator, provenance_by_cell, sidecar_by_id):
    """Build provenance dict for a shape.

    Priority:
      1. Sidecar entry (via shape property 1002 prov_id)
      2. Instance property (1005)
      3. Shape property (1004)
      4. Cell-level provenance (layer 255/255)
    """
    instance_name = _get_instance_name(iterator)

    try:
        path = iterator.path()
    except Exception:
        path = []

    # Try sidecar first (highest fidelity: has file/line/call_chain)
    prov = None
    try:
        prov_id = iterator.shape().property(PROV_ID_PROP_KEY)
        if prov_id is not None:
            entry = sidecar_by_id.get(int(prov_id))
            if entry is not None:
                try:
                    cell_name = iterator.cell().name
                except Exception:
                    cell_name = None
                prov = _build_provenance_from_sidecar(entry, cell_name)
    except Exception:
        pass

    # Fallback: instance property (1005)
    if prov is None and path:
        try:
            prov = _parse_json_property(path[-1].inst().property(INSTANCE_PROP_KEY))
        except Exception:
            pass

    # Fallback: shape property (1004)
    if prov is None:
        try:
            prov = _parse_json_property(iterator.shape().property(PLACEMENT_PROP_KEY))
        except Exception:
            pass

    # Fallback: cell-level provenance
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
```

- [ ] **Step 5: Update parse_gds() to load sidecar and pass to _get_feature_provenance**

In the `parse_gds()` function, add the sidecar loading after `provenance_by_cell = _extract_provenance(layout)` (line 148):

```python
    sidecar_by_id = _load_sidecar(filepath)
```

Then update the call to `_get_feature_provenance` on line 173 from:

```python
                provenance = _get_feature_provenance(it, provenance_by_cell)
```

to:

```python
                provenance = _get_feature_provenance(it, provenance_by_cell, sidecar_by_id)
```

- [ ] **Step 6: Verify with test script**

Run:

```bash
GDS_PROVENANCE=1 /opt/anaconda3/bin/python -c "
import gdsfactory as gf
gf.gpdk.PDK.activate()

def make_sub():
    c = gf.Component('sub_cell')
    c.add_polygon([(0,0),(5,0),(5,5),(0,5)], layer=(1,0))
    return c

def make_top():
    c = gf.Component('top_cell')
    sub = make_sub()
    ref = c << sub
    c.add_polygon([(0,0),(20,0),(20,20),(0,20)], layer=(3,0))
    c.write_gds('/tmp/test_prov_plan.gds')

make_top()
"

/opt/anaconda3/bin/python /Users/fangruihuan/Desktop/aalto/superGDS/python/parse_gds.py /tmp/test_prov_plan.gds | /opt/anaconda3/bin/python -m json.tool | head -40
```

Expected: Each feature in the GeoJSON has a `provenance` object with `file`, `line`, `function`, and `call_chain` array (not just `cell` name).

- [ ] **Step 7: Commit**

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS
git add python/parse_gds.py
git commit -m "feat: read provenance sidecar JSON in parse_gds.py"
```

---

### Task 2: Remove _outputChannel from provider.ts

**Files:**
- Modify: `src/webview/provider.ts`

The user wants provenance displayed in the webview's built-in console (Source tab), not VS Code's Output panel. The `_outputChannel` and `showSelectionOutput` should be removed.

- [ ] **Step 1: Remove _outputChannel and showSelectionOutput**

Remove these lines from provider.ts:

```typescript
// Remove the import of formatSelectionForOutput (no longer needed)
// Change line 3-8 from:
import {
    formatSelectionForOutput,
    getSourceChain,
    type ComponentSelection,
    type SourceLocation,
} from './provenance';

// To:
import {
    getSourceChain,
    type ComponentSelection,
    type SourceLocation,
} from './provenance';
```

Remove the `_outputChannel` constant (line 65):

```typescript
// DELETE this line:
const _outputChannel = vscode.window.createOutputChannel('superGDS');
```

Remove the entire `showSelectionOutput` function (lines 73-79):

```typescript
// DELETE this entire function:
function showSelectionOutput(components: ComponentSelection[]): void {
    _outputChannel.appendLine('');
    _outputChannel.appendLine('='.repeat(72));
    _outputChannel.appendLine(new Date().toISOString());
    _outputChannel.appendLine(formatSelectionForOutput(components));
    _outputChannel.show(true);
}
```

- [ ] **Step 2: Remove showSelectionOutput call from selectComponents handler**

In the `selectComponents` case, remove the `showSelectionOutput` call:

```typescript
// Change from:
case 'selectComponents':
    _currentSelection = message.components as ComponentSelection[];
    if (_currentSelection.length > 0) {
        showSelectionOutput(_currentSelection);
    }
    highlightOpenSourceLocations(_currentSelection);
    break;

// To:
case 'selectComponents':
    _currentSelection = message.components as ComponentSelection[];
    highlightOpenSourceLocations(_currentSelection);
    break;
```

- [ ] **Step 3: Verify TypeScript compiles**

Run:

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS
git add src/webview/provider.ts
git commit -m "refactor: remove outputChannel, provenance displays in viewer console only"
```

---

### Task 3: End-to-end verification with real script

**Files:**
- No file changes — verification only

- [ ] **Step 1: Generate GDS with provenance using the real script**

Run:

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS
GDS_PROVENANCE=1 /opt/anaconda3/bin/python gds_test/suspended_superconductor_standalone.py
```

Expected: `Generated: gds/suspended_superconductor_standalone.gds` and a `gds/suspended_superconductor_standalone.provenance.json` file appears.

- [ ] **Step 2: Verify parse_gds.py produces provenance data**

Run:

```bash
/opt/anaconda3/bin/python python/parse_gds.py gds/suspended_superconductor_standalone.gds | /opt/anaconda3/bin/python -c "
import json, sys
data = json.load(sys.stdin)
with_prov = [f for f in data['features'] if 'provenance' in f.get('properties', {})]
with_chain = [f for f in with_prov if 'call_chain' in f['properties']['provenance']]
print(f'Total features: {len(data[\"features\"])}')
print(f'With provenance: {len(with_prov)}')
print(f'With call_chain: {len(with_chain)}')
if with_chain:
    p = with_chain[0]['properties']['provenance']
    print(f'Example provenance:')
    print(f'  file: {p.get(\"file\", \"?\")}')
    print(f'  line: {p.get(\"line\", \"?\")}')
    print(f'  function: {p.get(\"function\", \"?\")}')
    print(f'  call_chain entries: {len(p.get(\"call_chain\", []))}')
"
```

Expected: Most features have provenance with `file`, `line`, `function`, and `call_chain`.

- [ ] **Step 3: Build extension and verify in VS Code**

Run:

```bash
cd /Users/fangruihuan/Desktop/aalto/superGDS
npx tsc -p ./
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Final commit (if any build artifacts need updating)**

If `package.json` test script needs updating or any other fixes were needed:

```bash
git add -A
git commit -m "feat: provenance sidecar integration complete"
```

---

## Self-Review

**Spec coverage:**
1. parse_gds.py reads sidecar JSON → Task 1
2. Maps prov_id (property 1002) to sidecar entries → Task 1
3. Parses call_stack strings into structured call_chain → Task 1
4. Remove _outputChannel from provider.ts → Task 2
5. End-to-end verification → Task 3

**Placeholder scan:** No TBDs, TODOs, or vague steps. All code is complete.

**Type consistency:** `_build_provenance_from_sidecar` produces `{file, line, function, call_chain: [{file, line, function}]}` which matches the `ComponentProvenance` interface in `provenance.ts` (which has `call_chain?: Array<{ file?: string; line?: number | string; function?: string }>`).
