# Variable Name Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the Python variable name alongside the instance ref name in the source console, clipboard, and Claude prompt, with warnings for loop variables and array elements.

**Architecture:** Extend `_find_user_frame()` to extract the LHS variable name via regex. Thread the two new fields (`variable_name`, `variable_in_loop`) through the provenance pipeline (sidecar → parse_gds → TypeScript interface). Add `Var:` display lines with contextual warnings in viewer, clipboard, and Claude prompt.

**Tech Stack:** Python (gdsfactory provenance tracker), TypeScript (VS Code extension), JavaScript (OpenLayers viewer)

---

### Task 1: Capture variable name in provenance tracker

**Files:**
- Modify: `gdsfactory/gdsfactory/provenance.py:111-121`
- Test: `python/provenance_tracker.test.py`

- [ ] **Step 1: Add variable name extraction to `_find_user_frame()`**

In `gdsfactory/gdsfactory/provenance.py`, after the `user_info` dict is built (line 117) and before the `loop_index` block (line 118), add variable name extraction:

Change lines 111–121 from:

```python
                user_info = {
                    "file": filepath,
                    "line": current.f_lineno,
                    "function": current.f_code.co_name,
                    "source_text": source_line,
                    "call_stack": call_stack,
                }
                loop_index = _try_extract_loop_index(current, source_line)
                if loop_index is not None:
                    user_info["loop_index"] = loop_index
                break
```

To:

```python
                user_info = {
                    "file": filepath,
                    "line": current.f_lineno,
                    "function": current.f_code.co_name,
                    "source_text": source_line,
                    "call_stack": call_stack,
                }
                # Extract LHS variable name from source line
                assign_match = re.match(r"^(\w+)\s*=", source_line)
                if assign_match:
                    user_info["variable_name"] = assign_match.group(1)
                loop_index = _try_extract_loop_index(current, source_line)
                if loop_index is not None:
                    user_info["loop_index"] = loop_index
                    if "variable_name" in user_info:
                        user_info["variable_in_loop"] = True
                break
```

- [ ] **Step 2: Add test for variable name extraction**

In `python/provenance_tracker.test.py`, add these two test methods to the `ProvenanceTrackerTests` class (after the `test_explicit_provenance_loop_index_overrides_helper_loop_locals` method):

```python
    def test_variable_name_extracted_from_assignment(self):
        provenance = load_provenance_module()
        provenance._reset_global_id()
        provenance._find_user_frame = lambda: {
            "file": "design.py",
            "line": 15,
            "function": "build",
            "source_text": "electrode = c.insts['Via1']",
            "call_stack": [],
        }

        tracker = provenance.ProvenanceTracker()
        tracker.track_instance("top", "cell", "top/cell_1", "r0 *1 0,0")

        [entry] = tracker.get_sidecar()["entries"]
        self.assertEqual(entry["variable_name"], "electrode")
        self.assertNotIn("variable_in_loop", entry)

    def test_variable_in_loop_flagged(self):
        provenance = load_provenance_module()
        provenance._reset_global_id()
        provenance._find_user_frame = lambda: {
            "file": "design.py",
            "line": 15,
            "function": "build",
            "source_text": "hole = gf.Component(h['name'])",
            "call_stack": [],
            "loop_index": [3],
            "variable_name": "hole",
            "variable_in_loop": True,
        }

        tracker = provenance.ProvenanceTracker()
        tracker.track_instance("top", "cell", "top/cell_1", "r0 *1 0,0")

        [entry] = tracker.get_sidecar()["entries"]
        self.assertEqual(entry["variable_name"], "hole")
        self.assertTrue(entry["variable_in_loop"])

    def test_no_variable_name_without_assignment(self):
        provenance = load_provenance_module()
        provenance._reset_global_id()
        provenance._find_user_frame = lambda: {
            "file": "design.py",
            "line": 15,
            "function": "build",
            "source_text": "comp << hole",
            "call_stack": [],
        }

        tracker = provenance.ProvenanceTracker()
        tracker.track_instance("top", "cell", "top/cell_1", "r0 *1 0,0")

        [entry] = tracker.get_sidecar()["entries"]
        self.assertNotIn("variable_name", entry)
```

- [ ] **Step 3: Run tests to verify**

Run: `cd "D:\gds_argo\Gdslab\superGDS" && python -m pytest python/provenance_tracker.test.py -v`
Expected: All tests pass, including the 3 new ones.

- [ ] **Step 4: Verify no import errors in provenance module**

Run: `cd "D:\gds_argo\Gdslab\superGDS\gdsfactory" && python -c "from gdsfactory.provenance import ProvenanceTracker; print('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add gdsfactory/gdsfactory/provenance.py python/provenance_tracker.test.py
git commit -m "feat(provenance): extract Python variable name from source line in user frame"
```

---

### Task 2: Thread variable name through parse_gds.py

**Files:**
- Modify: `python/parse_gds.py:87-92`

- [ ] **Step 1: Add passthrough for `variable_name` and `variable_in_loop`**

In `python/parse_gds.py`, inside `_build_provenance_from_sidecar()`, after the existing `loop_index` passthrough block (lines 90–92):

```python
    loop_index = entry.get("loop_index")
    if loop_index:
        prov["loop_index"] = loop_index
```

Add:

```python
    variable_name = entry.get("variable_name")
    if variable_name:
        prov["variable_name"] = variable_name
    variable_in_loop = entry.get("variable_in_loop")
    if variable_in_loop:
        prov["variable_in_loop"] = variable_in_loop
```

- [ ] **Step 2: Verify parse_gds still works**

Run: `cd "D:\gds_argo\Gdslab\superGDS" && python -c "from python.parse_gds import _build_provenance_from_sidecar; p = _build_provenance_from_sidecar({'file':'f.py','line':1,'function':'fn','call_stack':[],'variable_name':'hole','variable_in_loop':True}, 'cell'); print(p.get('variable_name'), p.get('variable_in_loop'))"`
Expected: `hole True`

- [ ] **Step 3: Commit**

```bash
git add python/parse_gds.py
git commit -m "feat(parse): pass through variable_name and variable_in_loop from sidecar"
```

---

### Task 3: Add TypeScript interface fields and tests

**Files:**
- Modify: `src/webview/provenance.ts:9-23`
- Modify: `src/webview/provenance.test.ts`

- [ ] **Step 1: Add fields to `ComponentProvenance` interface**

In `src/webview/provenance.ts`, add two new optional fields after `source_text` (line 21):

```typescript
export interface ComponentProvenance {
    file?: string;
    line?: number | string;
    function?: string;
    class_name?: string;
    loop_index?: number[];
    array_index?: number[];
    call_chain?: Array<{ file?: string; line?: number | string; function?: string }>;
    call_stack?: string[];
    cell?: string;
    instance_name?: string;
    area_um2?: number;
    source_text?: string;
    variable_name?: string;
    variable_in_loop?: boolean;
    ports?: Array<{ name: string; center?: number[]; orientation?: number }>;
}
```

- [ ] **Step 2: Add tests for `variable_name` in `formatSelectionForOutput`**

In `src/webview/provenance.test.ts`, add after the last test:

```typescript
test('selection output includes variable name', () => {
    const components: ComponentSelection[] = [
        {
            provId: 'c1',
            layer: '1/0',
            bbox: [],
            provenance: {
                cell: 'electrode',
                instance_name: 'Via1_Horizontal',
                file: 'design.py',
                line: 15,
                variable_name: 'electrode',
            },
        },
    ];

    const output = formatSelectionForOutput(components);
    assert.match(output, /electrode/);
});

test('selection output includes variable in loop warning', () => {
    const components: ComponentSelection[] = [
        {
            provId: 'c1',
            layer: '1/0',
            bbox: [],
            provenance: {
                cell: 'hole',
                instance_name: 'hole_3',
                file: 'design.py',
                line: 20,
                loop_index: [3],
                variable_name: 'hole',
                variable_in_loop: true,
            },
        },
    ];

    const output = formatSelectionForOutput(components);
    assert.match(output, /hole_3/);
    assert.match(output, /loop index \[3\]/);
});
```

- [ ] **Step 3: Type-check**

Run: `cd "D:\gds_argo\Gdslab\superGDS" && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 4: Run tests**

Run: `cd "D:\gds_argo\Gdslab\superGDS" && npx tsx --test src/webview/provenance.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/webview/provenance.ts src/webview/provenance.test.ts
git commit -m "feat(types): add variable_name and variable_in_loop to ComponentProvenance"
```

---

### Task 4: Add Var display in source console viewer

**Files:**
- Modify: `media/viewer.html:556-563`

- [ ] **Step 1: Add Var line and warnings after Ref block**

In `media/viewer.html`, after the "Instance ref name" block (lines 556–563), which ends with:

```javascript
            // Instance ref name
            var instanceName = prov.instance_name;
            if (instanceName) {
                var refDiv = document.createElement('div');
                refDiv.className = 'kv';
                refDiv.innerHTML = '<span class="key" style="color:#585b70;">&nbsp;&nbsp;Ref</span><span class="val" style="color:#6c7086;">' + esc(instanceName) + '</span>';
                panel.appendChild(refDiv);
            }
```

Insert after the closing `}` of that block (line 563):

```javascript
            // Variable name
            var varName = prov.variable_name;
            if (varName) {
                var varDiv = document.createElement('div');
                varDiv.className = 'kv';
                varDiv.innerHTML = '<span class="key" style="color:#585b70;">&nbsp;&nbsp;Var</span><span class="val" style="color:#6c7086;">' + esc(varName) + '</span>';
                panel.appendChild(varDiv);

                if (prov.variable_in_loop) {
                    var plural = varName + 's';
                    var warnDiv = document.createElement('div');
                    warnDiv.className = 'kv';
                    warnDiv.innerHTML = '<span class="key" style="color:#f9e2af;">&nbsp;&nbsp;⚠</span><span class="val" style="color:#f9e2af;">loop variable — may be overwritten each iteration</span>';
                    panel.appendChild(warnDiv);
                    var tipDiv = document.createElement('div');
                    tipDiv.className = 'kv';
                    tipDiv.innerHTML = '<span class="key" style="color:#89b4fa;">&nbsp;&nbsp;💡</span><span class="val" style="color:#89b4fa;">store in array (e.g. ' + esc(plural) + '[i] = ' + esc(varName) + ') to reference by variable name</span>';
                    panel.appendChild(tipDiv);
                }
                if (prov.array_index && prov.array_index.length > 0) {
                    var arrWarnDiv = document.createElement('div');
                    arrWarnDiv.className = 'kv';
                    arrWarnDiv.innerHTML = '<span class="key" style="color:#f9e2af;">&nbsp;&nbsp;⚠</span><span class="val" style="color:#f9e2af;">array element — variable name refers to the whole array, not this individual element</span>';
                    panel.appendChild(arrWarnDiv);
                }
            }
```

- [ ] **Step 2: Verify viewer loads without JS errors**

Open a GDS file in the viewer. Select a component. Verify the source panel still renders correctly. (If no provenance with `variable_name` exists yet, the `Var:` line simply won't appear — no regression.)

- [ ] **Step 3: Commit**

```bash
git add media/viewer.html
git commit -m "feat(viewer): show Python variable name with loop/array warnings in source console"
```

---

### Task 5: Add Var display in clipboard output

**Files:**
- Modify: `src/webview/provider.ts:289-292`

- [ ] **Step 1: Add Var line and warnings after Ref line in `formatComponentMentions()`**

In `src/webview/provider.ts`, after the existing Ref block (lines 289–292):

```typescript
        const instanceName = components[i].provenance?.instance_name;
        if (instanceName) {
            lines.push(`  Ref: ${instanceName}`);
        }
```

Insert after line 292:

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

- [ ] **Step 2: Type-check**

Run: `cd "D:\gds_argo\Gdslab\superGDS" && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/webview/provider.ts
git commit -m "feat(clipboard): include Python variable name with warnings in clipboard output"
```

---

### Task 6: Add Var display in Claude prompt

**Files:**
- Modify: `src/claudeBridge.ts:3-16,45-76`

- [ ] **Step 1: Add fields to `ComponentProvenance` interface in claudeBridge.ts**

In `src/claudeBridge.ts`, add the two new fields to the local interface (after `instance_name` on line 12):

```typescript
interface ComponentProvenance {
    file?: string;
    function?: string;
    line?: number | string;
    class_name?: string;
    loop_index?: number[];
    array_index?: number[];
    call_chain?: Array<{ file?: string; function?: string; line?: number | string }>;
    cell?: string;
    instance_name?: string;
    variable_name?: string;
    variable_in_loop?: boolean;
    layer?: string;
    bbox?: number[];
    area_um2?: number;
}
```

- [ ] **Step 2: Add Var output in `buildPrompt()`**

In `src/claudeBridge.ts`, inside `buildPrompt()`, after the `instance_name` is implicitly used in the label (line 46), add Var info after the call chain block. Change lines 64–76 from:

```typescript
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
```

To:

```typescript
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
        if (prov.variable_name) {
            lines.push(`- Variable: \`${prov.variable_name}\``);
            if (prov.variable_in_loop) {
                const plural = prov.variable_name + 's';
                lines.push(`  - ⚠ loop variable — may be overwritten each iteration`);
                lines.push(`  - 💡 store in array (e.g. \`${plural}[i] = ${prov.variable_name}\`) to reference by variable name`);
            }
            if (prov.array_index && prov.array_index.length > 0) {
                lines.push(`  - ⚠ array element — variable name refers to the whole array, not this individual element`);
            }
        }
        lines.push('');
```

- [ ] **Step 3: Type-check**

Run: `cd "D:\gds_argo\Gdslab\superGDS" && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/claudeBridge.ts
git commit -m "feat(claude): include Python variable name with warnings in Claude prompt"
```

---

### Task 7: End-to-end verification

**Files:**
- No new files

- [ ] **Step 1: Full type-check**

Run: `cd "D:\gds_argo\Gdslab\superGDS" && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 2: Run all provenance tests**

Run: `cd "D:\gds_argo\Gdslab\superGDS" && python -m pytest python/provenance_tracker.test.py -v && npx tsx --test src/webview/provenance.test.ts`
Expected: All tests pass

- [ ] **Step 3: Build a test GDS and verify sidecar contains variable_name**

Run your Python script with `GDS_PROVENANCE=1`. Check the `.provenance.json` output contains `variable_name` and `variable_in_loop` fields for entries where the source line has an assignment.

- [ ] **Step 4: Verify viewer shows Var line**

Open the GDS viewer, select a component with provenance, verify the source console shows:
- `Var: <variable_name>` after the `Ref:` line
- For loop variables: yellow warning + blue tip with pluralized suggestion
- For array elements: yellow warning about array scope
