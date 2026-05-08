# Persist Drawn Shape Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each drawn viewer shape as a `{python_file_name}_{shape_type}_{number}.json` file next to the Python GDS script, show that JSON file in the Source panel, send it to Claude Code context, and reload it after recompilation.

**Architecture:** Keep GDS provenance and user-drawn annotations as separate source types. The webview remains responsible for drawing geometry, while the VS Code extension owns filesystem writes/reads. Drawn annotations become regular `ComponentSelection` items with provenance pointing at the saved JSON file, so the existing Source panel and Claude context path can reuse `getSelectionSourceLocations()`.

**Tech Stack:** TypeScript VS Code extension APIs (`fs`, `path`, `vscode`), OpenLayers webview geometry serialization, Node `node:test`, existing `media/viewer.html` message bridge.

---

## File Structure

- Create: `src/annotations.ts`
  - Owns annotation filename generation, JSON payload validation, save/load/delete operations, and conversion into webview payloads.
- Create: `src/annotations.test.ts`
  - Covers deterministic filenames, next-number allocation, load filtering, and malformed JSON handling.
- Modify: `src/extension.ts`
  - Passes the active Python script path and loaded annotation JSON payloads to the webview with `loadGds`.
- Modify: `src/webview/provider.ts`
  - Handles webview messages `saveAnnotation`, `deleteAnnotation`, and `requestSource` for annotation JSON files.
- Modify: `src/webview/provenance.ts`
  - Extends `ComponentSelection`/`ComponentProvenance` if needed so drawn annotations participate in source and Claude context formatting.
- Modify: `src/webview/provenance.test.ts`
  - Adds regression coverage that drawn annotation provenance is included in Claude/source location output.
- Modify: `media/viewer.html`
  - Serializes drawn shapes on `drawend`, posts save requests, receives saved JSON file paths, rebuilds Source panel entries for drawn shapes, reloads saved annotations from `loadGds`, and posts delete requests when persisted drawn shapes are deleted.
- Modify: `package.json`
  - Includes `out/annotations.test.js` in the test command.

---

### Task 1: Add Annotation Persistence Module

**Files:**
- Create: `src/annotations.ts`
- Create: `src/annotations.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing annotation tests**

Create `src/annotations.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildAnnotationProvenance,
    getNextAnnotationPath,
    loadAnnotationsForPythonFile,
    saveAnnotation,
    sanitizeShapeType,
    type DrawnShapePayload,
} from './annotations';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'supergds-annotations-'));
}

function shape(shapeType = 'rectangle'): DrawnShapePayload {
    return {
        shapeType,
        geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]]],
        },
        meta: {
            bbox: [0, 0, 10, 5],
            area_um2: 50,
            vertex_count: 4,
        },
    };
}

test('sanitizeShapeType keeps supported lowercase shape names', () => {
    assert.equal(sanitizeShapeType('rectangle'), 'rectangle');
    assert.equal(sanitizeShapeType('Circle'), 'circle');
    assert.equal(sanitizeShapeType('../bad name'), 'shape');
});

test('getNextAnnotationPath allocates next numbered json next to python file', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');
    fs.writeFileSync(path.join(dir, 'chip_rectangle_1.json'), '{}');
    fs.writeFileSync(path.join(dir, 'chip_rectangle_2.json'), '{}');

    assert.equal(
        getNextAnnotationPath(pythonFile, 'rectangle'),
        path.join(dir, 'chip_rectangle_3.json')
    );
});

test('saveAnnotation writes json and provenance for source panel', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');

    const saved = saveAnnotation(pythonFile, shape('rectangle'));

    assert.equal(saved.shapeType, 'rectangle');
    assert.equal(saved.provenance.file, path.join(dir, 'chip_rectangle_1.json'));
    assert.equal(saved.provenance.line, 1);
    assert.equal(saved.provenance.function, 'drawn annotation');
    assert.deepEqual(saved.meta.bbox, [0, 0, 10, 5]);
    assert.equal(fs.existsSync(saved.jsonPath), true);

    const raw = JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8'));
    assert.equal(raw.schema, 'supergds.drawn-shape.v1');
    assert.equal(raw.shapeType, 'rectangle');
});

test('loadAnnotationsForPythonFile returns matching valid annotations sorted by file name', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');
    saveAnnotation(pythonFile, shape('line'));
    saveAnnotation(pythonFile, shape('rectangle'));
    fs.writeFileSync(path.join(dir, 'chip_rectangle_bad.json'), '{broken');
    fs.writeFileSync(path.join(dir, 'other_rectangle_1.json'), JSON.stringify(shape('rectangle')));

    const loaded = loadAnnotationsForPythonFile(pythonFile);

    assert.deepEqual(
        loaded.map((item) => path.basename(item.jsonPath)),
        ['chip_line_1.json', 'chip_rectangle_1.json']
    );
});

test('buildAnnotationProvenance points at json file line 1', () => {
    const jsonPath = path.join(tmpDir(), 'chip_circle_1.json');

    assert.deepEqual(buildAnnotationProvenance(jsonPath, 'circle'), {
        file: jsonPath,
        line: 1,
        function: 'drawn annotation',
        cell: 'drawn circle',
        source_text: 'superGDS drawn shape annotation',
    });
});
```

- [ ] **Step 2: Update the test command to include the new test**

Change `package.json`:

```json
"test": "npm run vscode:prepublish && node --test out/webview/provenance.test.js out/pythonEnv.test.js out/annotations.test.js"
```

- [ ] **Step 3: Run tests to verify the new tests fail**

Run:

```bash
npm test
```

Expected: TypeScript compile fails because `src/annotations.ts` does not exist and the imported functions are undefined.

- [ ] **Step 4: Implement annotation persistence**

Create `src/annotations.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

export interface DrawnShapePayload {
    shapeType: string;
    geometry: {
        type: string;
        coordinates: unknown;
    };
    meta: {
        bbox: number[];
        area_um2?: number;
        vertex_count?: number;
    };
}

export interface AnnotationProvenance {
    file: string;
    line: number;
    function: string;
    cell: string;
    source_text: string;
}

export interface SavedAnnotation {
    schema: 'supergds.drawn-shape.v1';
    id: string;
    shapeType: string;
    jsonPath: string;
    sourcePythonFile: string;
    geometry: DrawnShapePayload['geometry'];
    meta: DrawnShapePayload['meta'];
    provenance: AnnotationProvenance;
    createdAt: string;
    updatedAt: string;
}

const SUPPORTED_SHAPES = new Set(['rectangle', 'circle', 'line', 'polygon']);

export function sanitizeShapeType(shapeType: string): string {
    const normalized = shapeType.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return SUPPORTED_SHAPES.has(normalized) ? normalized : 'shape';
}

export function getNextAnnotationPath(pythonFile: string, shapeType: string): string {
    const dir = path.dirname(pythonFile);
    const base = path.basename(pythonFile, path.extname(pythonFile));
    const safeShape = sanitizeShapeType(shapeType);
    let index = 1;
    while (fs.existsSync(path.join(dir, `${base}_${safeShape}_${index}.json`))) {
        index += 1;
    }
    return path.join(dir, `${base}_${safeShape}_${index}.json`);
}

export function buildAnnotationProvenance(jsonPath: string, shapeType: string): AnnotationProvenance {
    const safeShape = sanitizeShapeType(shapeType);
    return {
        file: jsonPath,
        line: 1,
        function: 'drawn annotation',
        cell: `drawn ${safeShape}`,
        source_text: 'superGDS drawn shape annotation',
    };
}

export function saveAnnotation(pythonFile: string, payload: DrawnShapePayload): SavedAnnotation {
    const jsonPath = getNextAnnotationPath(pythonFile, payload.shapeType);
    const now = new Date().toISOString();
    const shapeType = sanitizeShapeType(payload.shapeType);
    const saved: SavedAnnotation = {
        schema: 'supergds.drawn-shape.v1',
        id: path.basename(jsonPath, '.json'),
        shapeType,
        jsonPath,
        sourcePythonFile: pythonFile,
        geometry: payload.geometry,
        meta: payload.meta,
        provenance: buildAnnotationProvenance(jsonPath, shapeType),
        createdAt: now,
        updatedAt: now,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(saved, null, 2), 'utf8');
    return saved;
}

export function loadAnnotationsForPythonFile(pythonFile: string): SavedAnnotation[] {
    const dir = path.dirname(pythonFile);
    const base = path.basename(pythonFile, path.extname(pythonFile));
    if (!fs.existsSync(dir)) {
        return [];
    }

    return fs.readdirSync(dir)
        .filter((name) => name.startsWith(`${base}_`) && name.endsWith('.json'))
        .sort()
        .flatMap((name) => {
            const jsonPath = path.join(dir, name);
            try {
                const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as SavedAnnotation;
                if (parsed.schema !== 'supergds.drawn-shape.v1') {
                    return [];
                }
                return [{
                    ...parsed,
                    jsonPath,
                    provenance: buildAnnotationProvenance(jsonPath, parsed.shapeType),
                }];
            } catch {
                return [];
            }
        });
}

export function deleteAnnotation(jsonPath: string): boolean {
    if (!jsonPath || !fs.existsSync(jsonPath)) {
        return false;
    }
    fs.unlinkSync(jsonPath);
    return true;
}
```

- [ ] **Step 5: Run tests to verify Task 1 passes**

Run:

```bash
npm test
```

Expected: all existing tests plus `annotations.test.ts` pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json src/annotations.ts src/annotations.test.ts
git commit -m "Persist drawn annotation JSON sidecars

Drawn viewer annotations need a durable source artifact so Claude
context and source navigation survive recompilation. Store each shape
as a small JSON file beside the Python script and expose provenance
pointing at that JSON.

Constraint: No new dependencies
Confidence: high
Scope-risk: narrow
Tested: npm test
"
```

---

### Task 2: Load Saved Annotation JSON With Each GDS View

**Files:**
- Modify: `src/extension.ts`
- Test: `src/annotations.test.ts`

- [ ] **Step 1: Add a failing test for annotation load payload stability**

Append to `src/annotations.test.ts`:

```typescript
test('loaded annotations include geometry, meta, and source provenance for webview reload', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');
    saveAnnotation(pythonFile, shape('polygon'));

    const [loaded] = loadAnnotationsForPythonFile(pythonFile);

    assert.equal(loaded.shapeType, 'polygon');
    assert.equal(loaded.geometry.type, 'Polygon');
    assert.deepEqual(loaded.meta.bbox, [0, 0, 10, 5]);
    assert.equal(loaded.provenance.file, path.join(dir, 'chip_polygon_1.json'));
    assert.equal(loaded.provenance.line, 1);
});
```

- [ ] **Step 2: Run the new test**

Run:

```bash
npm test
```

Expected: PASS if Task 1 already provides the full load payload. If it fails, fix `loadAnnotationsForPythonFile()` before continuing.

- [ ] **Step 3: Import loader in extension**

Modify the imports at the top of `src/extension.ts`:

```typescript
import { loadAnnotationsForPythonFile } from './annotations';
```

- [ ] **Step 4: Load annotations before posting `loadGds`**

In `src/extension.ts`, inside the `try` block after `const geojson = await parseGdsFile(gdsPath);`, add:

```typescript
const annotations = loadAnnotationsForPythonFile(pythonFile);
```

- [ ] **Step 5: Include `pythonFile` and `annotations` in the webview message**

Change the `panel.webview.postMessage({ ... })` payload:

```typescript
panel.webview.postMessage({
    type: 'loadGds',
    geojson,
    gdsPath,
    pythonFile,
    annotations,
    mode,
});
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test
```

Expected: PASS. This task is mostly compile-time protected because `extension.ts` is included in `tsc -p ./`.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/extension.ts src/annotations.test.ts
git commit -m "Reload drawn annotations with GDS viewer

The viewer receives saved annotation sidecars alongside parsed GDS
geometry so drawn shapes can reappear after a rebuild without touching
the generated GDS file.

Constraint: Annotation storage is keyed by the active Python script
Confidence: high
Scope-risk: narrow
Tested: npm test
"
```

---

### Task 3: Save Drawn Shapes From The Webview

**Files:**
- Modify: `src/webview/provider.ts`
- Modify: `media/viewer.html`

- [ ] **Step 1: Add extension-side save and delete message handlers**

Modify imports in `src/webview/provider.ts`:

```typescript
import { deleteAnnotation, saveAnnotation, type DrawnShapePayload } from '../annotations';
```

Add module state near `_currentSelection`:

```typescript
let _currentPythonFile = '';
```

In the `loadGds` flow the webview receives `pythonFile`, but provider gets it from a new message. Add these cases inside `switch (message.type)`:

```typescript
case 'viewerContext':
    _currentPythonFile = String(message.pythonFile || '');
    break;

case 'saveAnnotation': {
    if (!_currentPythonFile) {
        vscode.window.showErrorMessage('Cannot save annotation: no Python source file is active.');
        break;
    }
    const saved = saveAnnotation(_currentPythonFile, message.shape as DrawnShapePayload);
    panel.webview.postMessage({
        type: 'annotationSaved',
        clientId: message.clientId,
        annotation: saved,
    });
    break;
}

case 'deleteAnnotation': {
    const jsonPath = String(message.jsonPath || '');
    if (jsonPath) {
        deleteAnnotation(jsonPath);
    }
    break;
}
```

- [ ] **Step 2: Store current Python file in the webview**

In `media/viewer.html`, add state near `currentGdsPath`:

```javascript
var currentPythonFile = '';
```

Change `loadGdsData` signature:

```javascript
function loadGdsData(geojson, gdsPath, pythonFile, annotations, mode) {
```

At the top of `loadGdsData`, after `currentGdsPath = gdsPath;`, add:

```javascript
currentPythonFile = pythonFile || '';
vscode.postMessage({ type: 'viewerContext', pythonFile: currentPythonFile });
```

Update the message handler:

```javascript
loadGdsData(
    message.geojson,
    message.gdsPath,
    message.pythonFile || '',
    message.annotations || [],
    message.mode
);
```

- [ ] **Step 3: Add geometry serialization helpers**

Add these helpers in `media/viewer.html` near `polyMeta()`:

```javascript
function serializeDrawnGeometry(feature) {
    var geom = feature.getGeometry();
    if (!geom) return null;
    return gdsGeoJsonFmt.writeGeometryObject(geom);
}

function drawnFeaturePayload(feature) {
    var geometry = serializeDrawnGeometry(feature);
    if (!geometry) return null;
    var shapeType = feature.get('shapeType') || 'shape';
    var ring = geometry.coordinates && geometry.coordinates[0] ? geometry.coordinates[0] : [];
    var meta = ring.length > 0 ? polyMeta(ring) : {
        bbox: geomExtentToBbox(feature.getGeometry().getExtent()),
        area_um2: 0,
        vertex_count: 0
    };
    return {
        shapeType: shapeType,
        geometry: geometry,
        meta: meta
    };
}

function geomExtentToBbox(extent) {
    return [extent[0], extent[1], extent[2], extent[3]];
}
```

- [ ] **Step 4: Post save request on drawend**

In the existing `drawend` handler:

```javascript
Object.keys(drawInteractions).forEach(function(key) {
    drawInteractions[key].on('drawend', function(e) {
        var feature = e.feature;
        feature.set('isDrawn', true);
        feature.set('shapeType', key);
        feature.set('selected', false);
        var clientId = 'drawn_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        feature.set('clientId', clientId);
        var payload = drawnFeaturePayload(feature);
        if (payload) {
            vscode.postMessage({ type: 'saveAnnotation', clientId: clientId, shape: payload });
        }
        setTimeout(function() { setMode('select'); }, 50);
    });
});
```

- [ ] **Step 5: Handle annotationSaved response**

Add a helper:

```javascript
function applySavedAnnotation(feature, annotation) {
    feature.set('annotationPath', annotation.jsonPath);
    feature.set('provenance', annotation.provenance || {});
    feature.set('meta', annotation.meta || {});
    feature.set('shapeType', annotation.shapeType || feature.get('shapeType') || 'shape');
}
```

Add a message case:

```javascript
case 'annotationSaved':
    drawSource.getFeatures().forEach(function(f) {
        if (f.get('clientId') === message.clientId) {
            applySavedAnnotation(f, message.annotation);
        }
    });
    onSelectionChanged();
    break;
```

- [ ] **Step 6: Delete JSON when a persisted drawn shape is deleted**

In `deleteDrawn()`, before `drawSource.removeFeature(f);`, add:

```javascript
var annotationPath = f.get('annotationPath');
if (annotationPath) {
    vscode.postMessage({ type: 'deleteAnnotation', jsonPath: annotationPath });
}
```

- [ ] **Step 7: Run compile/tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/webview/provider.ts media/viewer.html
git commit -m "Save drawn shapes as annotation JSON

Drawing in the webview now delegates persistence to the extension host,
which writes one JSON file per shape and returns provenance pointing at
that file for source navigation and Claude context.

Constraint: Webviews cannot write directly to the workspace filesystem
Confidence: medium
Scope-risk: moderate
Tested: npm test
"
```

---

### Task 4: Reload Saved Annotations Into The Viewer

**Files:**
- Modify: `media/viewer.html`

- [ ] **Step 1: Add annotation feature reconstruction helper**

Add near `loadGdsData()`:

```javascript
function featureFromSavedAnnotation(annotation) {
    var geom = gdsGeoJsonFmt.readGeometry(annotation.geometry);
    var feature = new ol.Feature({ geometry: geom });
    feature.set('isDrawn', true);
    feature.set('shapeType', annotation.shapeType || 'shape');
    feature.set('annotationPath', annotation.jsonPath);
    feature.set('selected', false);
    feature.set('provenance', annotation.provenance || {});
    feature.set('meta', annotation.meta || {});
    return feature;
}
```

- [ ] **Step 2: Clear old drawn annotations when loading a new GDS**

In `loadGdsData()`, after `source.clear();`, add:

```javascript
drawSource.clear();
selectedFeatures.clear();
```

- [ ] **Step 3: Add saved annotations after GDS features load**

Near the end of `loadGdsData()`, before `if (allFeatures.length > 0) fitView();`, add:

```javascript
(annotations || []).forEach(function(annotation) {
    drawSource.addFeature(featureFromSavedAnnotation(annotation));
});
```

- [ ] **Step 4: Include drawn annotations in fit view**

Replace `fitView()` with:

```javascript
function fitView() {
    var extent = source.getExtent();
    var drawnExtent = drawSource.getExtent();
    if (drawnExtent && isFinite(drawnExtent[0])) {
        extent = extent && isFinite(extent[0])
            ? ol.extent.extend(extent, drawnExtent)
            : drawnExtent;
    }
    if (extent && isFinite(extent[0])) {
        map.getView().fit(extent, { padding: [40, 40, 40, 40], duration: 300 });
    }
}
```

- [ ] **Step 5: Run compile/tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add media/viewer.html
git commit -m "Reload persisted drawn annotations in viewer

Saved annotation JSON files are reconstructed as drawn OpenLayers
features whenever the GDS viewer reloads, so annotations survive
Python recompilation.

Constraint: Annotation geometry is stored independently from GDS geometry
Confidence: medium
Scope-risk: moderate
Tested: npm test
"
```

---

### Task 5: Make Drawn Annotation Source And Claude Context Work

**Files:**
- Modify: `media/viewer.html`
- Modify: `src/webview/provenance.test.ts`
- Modify: `src/webview/provenance.ts` if test reveals a missing type/property

- [ ] **Step 1: Add a failing provenance test for drawn annotation selection**

Append to `src/webview/provenance.test.ts`:

```typescript
test('drawn annotation provenance is formatted for Claude source context', () => {
    const components: ComponentSelection[] = [
        {
            provId: 'drawn_1',
            layer: 'annotation',
            bbox: [0, 0, 10, 5],
            provenance: {
                cell: 'drawn rectangle',
                file: '/repo/chip_rectangle_1.json',
                line: 1,
                function: 'drawn annotation',
                source_text: 'superGDS drawn shape annotation',
            },
        },
    ];

    const output = formatSelectionForOutput(components);

    assert.match(output, /drawn rectangle/);
    assert.match(output, /\/repo\/chip_rectangle_1\.json:1 \(drawn annotation\)/);
});
```

- [ ] **Step 2: Run the test and fix type errors if needed**

Run:

```bash
npm test
```

Expected: If `source_text` is not typed in `ComponentProvenance`, TypeScript fails.

If needed, add to `src/webview/provenance.ts`:

```typescript
source_text?: string;
```

inside `ComponentProvenance`.

- [ ] **Step 3: Post drawn features to the extension selection path**

Change `onSelectionChanged()` in `media/viewer.html`.

Replace:

```javascript
postSelectedComponents(gdsFeatures);
```

with:

```javascript
postSelectedComponents(features);
```

This makes drawn annotations available to `syncClaudeContext()` and `askClaude`, because `componentsFromFeatures()` already reads `f.get('provenance')`.

- [ ] **Step 4: Ensure drawn annotation source panels use JSON provenance**

In `showDrawnInspect(feature)`, set the Source panel from `feature.get('provenance')` when present:

```javascript
function showDrawnInspect(feature) {
    var provenance = feature.get('provenance') || {};
    var panel = document.getElementById('info-panel');
    panel.innerHTML = '';
    var meta = feature.get('meta') || {};
    addKV(panel, 'shape', feature.get('shapeType') || 'shape');
    addKV(panel, 'bbox', '[' + (meta.bbox || []).map(function(v) { return v.toFixed(4); }).join(', ') + ']');
    if (feature.get('annotationPath')) {
        addKV(panel, 'json', feature.get('annotationPath'), true);
    }

    if (provenance.file) {
        var fp = provenance.file.replace(/\\/g, '/');
        var fileMap = {};
        fileMap[fp] = [{ line: parseInt(provenance.line) || 1 }];
        updateMultiSourcePanel(fileMap);
    } else {
        document.getElementById('source-panel').innerHTML = '<p class="placeholder">Saving drawn annotation...</p>';
    }
}
```

If the existing `showDrawnInspect()` has more geometry display, preserve it and only replace the Source panel section.

- [ ] **Step 5: Ensure drawn multi-select source panels include JSON files**

In `showDrawnMultiInspect(features)`, build a `fileMap` from drawn feature provenance:

```javascript
var fileMap = {};
features.forEach(function(f) {
    var prov = f.get('provenance') || {};
    if (prov.file) {
        var fp = prov.file.replace(/\\/g, '/');
        if (!fileMap[fp]) fileMap[fp] = [];
        fileMap[fp].push({ line: parseInt(prov.line) || 1 });
    }
});
updateMultiSourcePanel(fileMap);
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add media/viewer.html src/webview/provenance.ts src/webview/provenance.test.ts
git commit -m "Route drawn annotation sources to Claude context

Persisted drawn annotations now behave like source-backed selections:
their JSON file appears in the Source panel and the same provenance is
sent through the Claude context path.

Constraint: GDS and drawn selections share ComponentSelection formatting
Confidence: high
Scope-risk: moderate
Tested: npm test
"
```

---

### Task 6: Manual End-To-End Verification

**Files:**
- No code changes expected

- [ ] **Step 1: Build the extension**

Run:

```bash
npm run vscode:prepublish
```

Expected: `tsc -p ./` exits 0.

- [ ] **Step 2: Open a Python GDS script and show the viewer**

Use a known script such as:

```text
gds_test/suspended_superconductor_standalone.py
```

Run the VS Code command:

```text
superGDS: Show GDS Viewer
```

Expected: viewer loads the GDS.

- [ ] **Step 3: Draw a rectangle**

Use the rectangle tool in the viewer and draw one shape.

Expected:

```text
gds_test/suspended_superconductor_standalone_rectangle_1.json
```

exists next to `gds_test/suspended_superconductor_standalone.py`.

- [ ] **Step 4: Inspect the JSON**

Open the JSON file.

Expected contents include:

```json
{
  "schema": "supergds.drawn-shape.v1",
  "shapeType": "rectangle",
  "geometry": {
    "type": "Polygon"
  },
  "provenance": {
    "line": 1,
    "function": "drawn annotation"
  }
}
```

- [ ] **Step 5: Click the drawn rectangle in the viewer**

Expected:

```text
Source panel shows suspended_superconductor_standalone_rectangle_1.json:1
```

Clicking the Source entry opens the JSON file.

- [ ] **Step 6: Verify Claude context copy**

With Claude Code terminal open, click the drawn rectangle.

Expected terminal/input text includes:

```text
@gds_test/suspended_superconductor_standalone_rectangle_1.json:1
```

If using the Claude sidebar path, expected clipboard text includes:

```text
@gds_test/suspended_superconductor_standalone_rectangle_1.json#L1
```

- [ ] **Step 7: Recompile and reload**

Run `superGDS: Show GDS Viewer` again for the same Python file.

Expected: the drawn rectangle is recreated from the JSON annotation and still shows the JSON file in Source.

- [ ] **Step 8: Delete the drawn rectangle**

Select the drawn rectangle and press Delete.

Expected: the shape disappears and its JSON file is removed. Re-running the viewer should not recreate the deleted shape.

- [ ] **Step 9: Final test run**

Run:

```bash
npm test
/opt/anaconda3/bin/python python/provenance_tracker.test.py
```

Expected: both commands pass.

- [ ] **Step 10: Commit verification-only adjustments if any**

Only if manual verification required code edits:

```bash
git add media/viewer.html src/**/*.ts package.json
git commit -m "Stabilize drawn annotation persistence flow

Manual verification exposed small integration gaps in the webview and
extension-host message path. This keeps the JSON sidecar workflow stable
across draw, inspect, Claude context, reload, and delete.

Confidence: medium
Scope-risk: narrow
Tested: npm test
Tested: python/provenance_tracker.test.py
"
```

---

## Self-Review

**Spec coverage:**
- Create one JSON file per drawn shape: Task 1 and Task 3.
- File name `{file_name}_{shape type}_{number}.json`: Task 1.
- Store JSON next to the GDS Python script: Task 1 uses `path.dirname(pythonFile)`.
- Show file location in Source: Task 5.
- Click Source to open file: Task 5 reuses `requestSource`.
- Copy to Claude Code: Task 5 posts drawn selections through the existing Claude context path.
- Show again after recompile: Task 2 and Task 4 reload annotation files with each GDS view.
- Delete persisted annotation when deleting drawn shape: Task 3 prevents unwanted reappearance.

**Placeholder scan:** No `TBD`, `TODO`, “implement later”, or undefined helper names are used. Every helper referenced in a code step is defined in that task or already exists in the codebase.

**Type consistency:** `DrawnShapePayload`, `SavedAnnotation`, `AnnotationProvenance`, `ComponentSelection`, and `ComponentProvenance` names are consistent across tasks. Webview message names are consistently `viewerContext`, `saveAnnotation`, `annotationSaved`, and `deleteAnnotation`.
