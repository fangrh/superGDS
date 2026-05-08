# Loop Index Provenance Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store loop iteration indices in provenance entries so the source panel can show `(loop index [2])` or `(loop index [3, 5])` for loop-generated and array-placed components.

**Architecture:** Tag at capture time. The Python provenance tracker adds `loop_index` to entries during `track_instance` (for arrays) and `_find_user_frame` (for user-script loops). The sidecar JSON passes it through to the TypeScript frontend, where a new `formatLoopLabel` helper appends it to file:line displays.

**Tech Stack:** Python (gdsfactory provenance), TypeScript (VS Code extension), HTML/JS (webview info panel)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `gdsfactory/gdsfactory/provenance.py` | Modify | Add `loop_index` to `_find_user_frame` and `track_instance` |
| `gdsfactory/gdsfactory/component.py:803` | Modify | Thread `columns`/`rows` into `track_instance` call |
| `python/parse_gds.py:58-87` | Modify | Pass `loop_index` from sidecar entry into provenance dict |
| `src/webview/provenance.ts` | Modify | Replace `call_index` with `loop_index`, add `formatLoopLabel`, update `formatSelectionForOutput` |
| `src/webview/provenance.test.ts` | Modify | Tests for `formatLoopLabel` and updated `formatSelectionForOutput` |
| `media/viewer.html:879-882` | Modify | Replace `call_index` display with `loop_index` label in info panel |

---

### Task 1: Add `loop_index` to Python provenance tracker

**Files:**
- Modify: `gdsfactory/gdsfactory/provenance.py`

- [ ] **Step 1: Add `_try_extract_loop_index` helper**

Add after the `_find_user_frame` function (after line 127):

```python
def _try_extract_loop_index(frame, source_line: str) -> list[int] | None:
    """Best-effort extraction of loop iteration index from a user frame.

    Checks if the source line uses enumerate and looks for common
    index variable names in frame.f_locals. Returns None if detection
    fails (non-loop code, unusual variable names, etc.).
    """
    if "enumerate" not in source_line:
        return None

    index_vars = ("i", "idx", "ix", "iy", "ic", "ir", "col", "row", "n")
    for var in index_vars:
        val = frame.f_locals.get(var)
        if isinstance(val, int):
            return [val]
    return None
```

- [ ] **Step 2: Call `_try_extract_loop_index` from `_find_user_frame`**

In `_find_user_frame`, after line 112 (`"call_stack": call_stack,`), add:

```python
                    loop_index = _try_extract_loop_index(current, source_line)
                    if loop_index is not None:
                        user_info["loop_index"] = loop_index
```

This is inside the `if not _is_internal_frame(filepath):` block, after `user_info` is assigned but before the `break`.

- [ ] **Step 3: Add `columns`/`rows` params to `track_instance`**

Change the signature of `track_instance` (line 200) from:

```python
    def track_instance(
        self,
        parent_name: str,
        ref_name: str,
        instance_path: str,
        transform: str,
    ) -> int:
```

to:

```python
    def track_instance(
        self,
        parent_name: str,
        ref_name: str,
        instance_path: str,
        transform: str,
        columns: int = 1,
        rows: int = 1,
    ) -> int:
```

Then after the existing entry building (after line 228 where `entry.update` sets `call_stack`), add:

```python
        if columns > 1 or rows > 1:
            entry["loop_index"] = [columns, rows]
```

- [ ] **Step 4: Commit**

```bash
git add gdsfactory/gdsfactory/provenance.py
git commit -m "feat(provenance): add loop_index to provenance tracker capture"
```

---

### Task 2: Thread `columns`/`rows` from `add_ref` into `track_instance`

**Files:**
- Modify: `gdsfactory/gdsfactory/component.py:803`

- [ ] **Step 1: Pass `columns`/`rows` to `track_instance`**

Change line 803 from:

```python
            _tracker.track_instance(
                self.name, component.name, _inst_path, _transform
            )
```

to:

```python
            _tracker.track_instance(
                self.name, component.name, _inst_path, _transform,
                columns=columns, rows=rows,
            )
```

- [ ] **Step 2: Commit**

```bash
git add gdsfactory/gdsfactory/component.py
git commit -m "feat(component): pass array dimensions to provenance tracker"
```

---

### Task 3: Pass `loop_index` through Python GDS parser

**Files:**
- Modify: `python/parse_gds.py:58-87`

- [ ] **Step 1: Add `loop_index` passthrough in `_build_provenance_from_sidecar`**

In `_build_provenance_from_sidecar`, after the `source_text` block (after line 86), add:

```python
    loop_index = entry.get("loop_index")
    if loop_index:
        prov["loop_index"] = loop_index
```

- [ ] **Step 2: Commit**

```bash
git add python/parse_gds.py
git commit -m "feat(parse_gds): pass loop_index from sidecar to provenance"
```

---

### Task 4: Update TypeScript types and add `formatLoopLabel`

**Files:**
- Modify: `src/webview/provenance.ts`

- [ ] **Step 1: Replace `call_index` with `loop_index` in `ComponentProvenance`**

Change line 12 from:

```typescript
    call_index?: number;
```

to:

```typescript
    loop_index?: number[];
```

- [ ] **Step 2: Add `formatLoopLabel` function**

Add after the `formatMentions` function (after line 178):

```typescript
export function formatLoopLabel(provenance: ComponentProvenance): string {
    if (!provenance.loop_index || provenance.loop_index.length === 0) return '';
    return ` (loop index [${provenance.loop_index.join(', ')}])`;
}
```

- [ ] **Step 3: Update `formatSelectionForOutput` to include loop label**

In `formatSelectionForOutput`, change the source chain display (lines 84-86) from:

```typescript
            for (const location of chain) {
                const fn = location.functionName ? ` (${location.functionName})` : '';
                lines.push(`   - ${location.file}:${location.line}${fn}`);
            }
```

to:

```typescript
            for (const location of chain) {
                const fn = location.functionName ? ` (${location.functionName})` : '';
                const loop = (location === chain[0] && provenance.loop_index)
                    ? formatLoopLabel(provenance)
                    : '';
                lines.push(`   - ${location.file}:${location.line}${fn}${loop}`);
            }
```

The loop label is appended only to the primary (first) source location in the chain.

- [ ] **Step 4: Commit**

```bash
git add src/webview/provenance.ts
git commit -m "feat(provenance): add loop_index type and formatLoopLabel helper"
```

---

### Task 5: Add TypeScript tests for `formatLoopLabel` and updated output

**Files:**
- Modify: `src/webview/provenance.test.ts`

- [ ] **Step 1: Update import to include `formatLoopLabel`**

Change line 3 from:

```typescript
import { filterLocationsByFile, formatMentions, formatSelectionForOutput, getSelectionSourceLocations, getSourceChain, type ComponentSelection, type SourceLocation } from './provenance';
```

to:

```typescript
import { filterLocationsByFile, formatLoopLabel, formatMentions, formatSelectionForOutput, getSelectionSourceLocations, getSourceChain, type ComponentSelection, type SourceLocation } from './provenance';
```

- [ ] **Step 2: Add test for `formatLoopLabel` with single index**

Add after the last test:

```typescript
test('formatLoopLabel returns label for single loop index', () => {
    assert.equal(formatLoopLabel({ loop_index: [3] }), ' (loop index [3])');
});
```

- [ ] **Step 3: Add test for `formatLoopLabel` with multi-dim index**

```typescript
test('formatLoopLabel returns label for multi-dim loop index', () => {
    assert.equal(formatLoopLabel({ loop_index: [3, 5] }), ' (loop index [3, 5])');
});
```

- [ ] **Step 4: Add test for `formatLoopLabel` with no loop index**

```typescript
test('formatLoopLabel returns empty string when no loop_index', () => {
    assert.equal(formatLoopLabel({}), '');
    assert.equal(formatLoopLabel({ loop_index: [] }), '');
});
```

- [ ] **Step 5: Add test for `formatSelectionForOutput` with loop index**

```typescript
test('selection output appends loop index to primary source', () => {
    const components: ComponentSelection[] = [
        {
            provId: 'c1',
            layer: '1/0',
            bbox: [],
            provenance: {
                cell: 'ring',
                file: 'cells/ring.py',
                line: 42,
                function: 'ring',
                loop_index: [3],
                call_chain: [
                    { file: 'cells/ring.py', line: 42, function: 'ring' },
                    { file: 'top.py', line: 10, function: 'top' },
                ],
            },
        },
    ];

    const output = formatSelectionForOutput(components);
    assert.match(output, /cells\/ring\.py:42 \(ring\) \(loop index \[3\]\)/);
    assert.match(output, /top\.py:10 \(top\)/);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test src/webview/provenance.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/webview/provenance.test.ts
git commit -m "test(provenance): add formatLoopLabel and loop index output tests"
```

---

### Task 6: Update webview info panel to display `loop_index`

**Files:**
- Modify: `media/viewer.html:879-882`

- [ ] **Step 1: Replace `call_index` display with `loop_index` label**

Change lines 879-882 from:

```javascript
        if (provenance.file) addKV(d, 'file', provenance.file + ':' + provenance.line);
        if (provenance.function && provenance.function !== '<module>') addKV(d, 'function', provenance.function + '()');
        if (provenance.class_name) addKV(d, 'class', provenance.class_name);
        if (provenance.call_index) addKV(d, 'call_index', String(provenance.call_index));
```

to:

```javascript
        if (provenance.file) {
            var fileLabel = provenance.file + ':' + provenance.line;
            if (provenance.loop_index && provenance.loop_index.length > 0) {
                fileLabel += ' (loop index [' + provenance.loop_index.join(', ') + '])';
            }
            addKV(d, 'file', fileLabel);
        }
        if (provenance.function && provenance.function !== '<module>') addKV(d, 'function', provenance.function + '()');
        if (provenance.class_name) addKV(d, 'class', provenance.class_name);
```

- [ ] **Step 2: Commit**

```bash
git add media/viewer.html
git commit -m "feat(viewer): display loop_index label in info panel"
```
