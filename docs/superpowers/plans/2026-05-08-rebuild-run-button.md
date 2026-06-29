# Rebuild Run Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Run" button to the GDS Viewer top-right toolbar that rebuilds the Python script and reloads the viewer, alongside existing "Open Claude Code" and "Open Codex" buttons.

**Architecture:** The webview sends a `rebuild` postMessage to the extension host. The extension host clears the cached GDS path, re-runs the Python script, re-parses the output, and sends the fresh GeoJSON back to the webview via a `loadGds` message. The webview shows a loading spinner while rebuilding. The extension host exposes a helper function `rebuildAndReload` that encapsulates the run→find→parse→send cycle, called from both the initial `showGdsViewer` command and the `rebuild` message handler.

**Tech Stack:** TypeScript (VS Code Extension API), HTML/CSS/JS (webview), postMessage bridge

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/extension.ts` | Refactor build+parse+send into `rebuildAndReload()`. Register `rebuild` message handler. |
| `src/webview/provider.ts` | Add `rebuild` case to message handler switch. Import `rebuildAndReload`. |
| `media/viewer.html` | Add Run button + Open Claude Code button + Open Codex button in top-right toolbar. Add loading overlay CSS. Send `rebuild` message on click. Handle `rebuildStarted` / `rebuildError` messages. |

---

### Task 1: Refactor extension.ts — extract `rebuildAndReload`

**Files:**
- Modify: `src/extension.ts`

This task extracts the build→find→parse→display logic from `showGdsViewer` into a reusable async function so both the command and the `rebuild` message handler can call it.

- [ ] **Step 1: Add `rebuildAndReload` export to extension.ts**

Add this function right before the `activate` function, along with a module-level `_context` variable:

```typescript
let _context: vscode.ExtensionContext | undefined;

/**
 * Re-run the Python script, re-parse the GDS output, and send fresh
 * data to the webview.  Used by both the showGdsViewer command and
 * the rebuild message handler.
 *
 * Returns `true` on success, `false` on failure (error shown to user).
 */
export async function rebuildAndReload(pythonFile: string): Promise<boolean> {
    if (!_context) return false;

    const panel = getOrCreatePanel(_context);
    registerMessageHandlers(panel);
    setCurrentPythonFile(pythonFile);

    // Clear cached GDS path so we always re-discover after rebuild
    clearGdsState();

    const beforeTime = new Date();

    // 1. Run the Python script
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Building GDS...',
                cancellable: false,
            },
            async () => {
                const result = await runPythonFile(pythonFile);
                if (result.exitCode !== 0) {
                    const msg = result.stderr || result.stdout || 'Build failed with unknown error';
                    throw new Error(msg);
                }
            }
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`Build failed: ${err.message}`);
        panel.webview.postMessage({ type: 'rebuildError', error: err.message });
        return false;
    }

    // 2. Find the generated GDS file
    const gdsPath = findGdsOutput(pythonFile, beforeTime);
    if (!gdsPath) {
        const msg = 'No .gds file found after build. Check supergds.gdsOutputDir config.';
        vscode.window.showErrorMessage(msg);
        panel.webview.postMessage({ type: 'rebuildError', error: msg });
        return false;
    }

    // 3. Parse and send to webview
    try {
        const geojson = await parseGdsFile(gdsPath);
        const mode = getForkStatus() === 'fork' ? 'full' : 'partial';
        const annotations = loadAnnotationsForPythonFile(pythonFile);

        panel.webview.postMessage({
            type: 'loadGds',
            geojson,
            gdsPath,
            pythonFile,
            annotations,
            mode,
        });
        return true;
    } catch (err: any) {
        vscode.window.showErrorMessage(`Parse failed: ${err.message}`);
        panel.webview.postMessage({ type: 'rebuildError', error: err.message });
        return false;
    }
}
```

Add these imports at the top of `extension.ts` (alongside existing imports):

```typescript
import { clearGdsState } from './gdsWatcher';
```

- [ ] **Step 2: Store `context` and refactor `showGdsViewer` to use `rebuildAndReload`**

Inside `activate`, right after `initPythonBridge(context.extensionPath);`, store the context:

```typescript
_context = context;
```

Replace the body of the `showGdsViewer` command handler with:

```typescript
vscode.commands.registerCommand('supergds.showGdsViewer', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showErrorMessage('Open a Python file to view GDS.');
        return;
    }

    const pythonFile = editor.document.uri.fsPath;
    setCurrentPythonFile(pythonFile);

    const panel = getOrCreatePanel(context);
    registerMessageHandlers(panel);

    const fs = require('fs');
    const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'viewer.html').fsPath;
    panel.webview.html = fs.readFileSync(htmlPath, 'utf-8');

    // Wait for webview to be ready, then rebuild
    const readyListener = panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'webviewReady') {
            rebuildAndReload(pythonFile);
            readyListener.dispose();
        }
    });
})
```

- [ ] **Step 3: Compile and verify no errors**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "refactor: extract rebuildAndReload from showGdsViewer command"
```

---

### Task 2: Add `rebuild` message handler to provider.ts

**Files:**
- Modify: `src/webview/provider.ts`

- [ ] **Step 1: Add `rebuild` case to the message handler switch**

Add a new `case` in `registerMessageHandlers` right after the `deleteAnnotation` case:

```typescript
case 'rebuild': {
    if (!_currentPythonFile) {
        panel.webview.postMessage({ type: 'rebuildError', error: 'No Python file is active.' });
        break;
    }
    // Dynamic import to avoid circular dependency (extension.ts → provider.ts → extension.ts)
    const { rebuildAndReload } = await import('../extension');
    await rebuildAndReload(_currentPythonFile);
    break;
}
```

- [ ] **Step 2: Compile and verify**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/webview/provider.ts
git commit -m "feat: add rebuild message handler in webview provider"
```

---

### Task 3: Add Run / Claude Code / Codex buttons and loading overlay to viewer.html

**Files:**
- Modify: `media/viewer.html`

This is the main UI task. We add three buttons to a top-right toolbar on the map canvas and a loading overlay for rebuild progress.

- [ ] **Step 1: Add CSS for the action toolbar and loading overlay**

Add these styles inside the `<style>` block (after the `.zoom-btn svg` rule at line 61):

```css
#action-bar { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; z-index: 100; }
.action-btn { height: 32px; padding: 0 10px; background: #1e1e2e; border: 1px solid #313244; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px; color: #6c7086; font-size: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; white-space: nowrap; }
.action-btn:hover { background: #313244; color: #cdd6f4; }
.action-btn svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.action-btn.running { opacity: 0.6; pointer-events: none; }
.action-btn.running .run-icon { display: none; }
.action-btn.running .spinner-icon { display: inline-block; }
.action-btn .spinner-icon { display: none; width: 14px; height: 14px; border: 2px solid #6c7086; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#rebuild-overlay { display: none; position: absolute; inset: 0; background: rgba(26,26,46,0.7); z-index: 200; align-items: center; justify-content: center; color: #89b4fa; font-size: 14px; }
#rebuild-overlay.visible { display: flex; }
#rebuild-overlay .spinner { width: 28px; height: 28px; border: 3px solid #313244; border-top-color: #89b4fa; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 10px; }
```

- [ ] **Step 2: Add action bar HTML and loading overlay to the map div**

Inside the `<div id="map" style="flex:1; position: relative;">` (line 73), right after the `#zoom-controls` div (after line 84's `</div>`), add:

```html
            <div id="action-bar">
                <button class="action-btn" id="run-btn" title="Rebuild script" onclick="rebuildScript()">
                    <svg class="run-icon" viewBox="0 0 24 24"><polygon points="6,3 20,12 6,21" fill="currentColor" stroke="none"/></svg>
                    <span class="spinner-icon"></span>
                    Run
                </button>
                <button class="action-btn" title="Open in Claude Code" onclick="openClaudeCode()">
                    <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 0"/><path d="M8 12h8M12 8v8" stroke-width="1.5"/></svg>
                    Claude
                </button>
                <button class="action-btn" title="Open in Codex" onclick="openCodex()">
                    <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/></svg>
                    Codex
                </button>
            </div>
            <div id="rebuild-overlay">
                <div class="spinner"></div>
                Rebuilding...
            </div>
```

- [ ] **Step 3: Add JavaScript functions for the action buttons**

Add these functions in the `<script>` section, right before the `// Handle messages from extension` comment block (around line 1379):

```javascript
// ============================================================
// Action bar: Run / Claude Code / Codex
// ============================================================
function rebuildScript() {
    var btn = document.getElementById('run-btn');
    btn.classList.add('running');
    document.getElementById('rebuild-overlay').classList.add('visible');
    vscode.postMessage({ type: 'rebuild' });
}

function openClaudeCode() {
    vscode.postMessage({ type: 'openClaudeCode' });
}

function openCodex() {
    vscode.postMessage({ type: 'openCodex' });
}

function onRebuildComplete() {
    var btn = document.getElementById('run-btn');
    btn.classList.remove('running');
    document.getElementById('rebuild-overlay').classList.remove('visible');
}
```

- [ ] **Step 4: Handle `rebuildError` message in the message listener**

In the `window.addEventListener('message', ...)` switch block, add these cases right before the closing `}` of the switch:

```javascript
        case 'rebuildError':
            onRebuildComplete();
            break;
```

Also, in the existing `case 'loadGds':` block, add `onRebuildComplete();` at the beginning of the handler (right after `case 'loadGds':`):

```javascript
        case 'loadGds':
            onRebuildComplete();
            loadGdsData(
```

- [ ] **Step 5: Verify in browser manually**

Since this is a VS Code webview, testing requires the extension to run. Compile first:

Run: `npm run vscode:prepublish`
Expected: Compiles without errors

- [ ] **Step 6: Commit**

```bash
git add media/viewer.html
git commit -m "feat: add Run/Claude/Codex action bar buttons to GDS viewer"
```

---

### Task 4: Add `openClaudeCode` and `openCodex` message handlers

**Files:**
- Modify: `src/webview/provider.ts`

- [ ] **Step 1: Add message handlers for opening Claude Code and Codex**

Add two new `case` blocks in `registerMessageHandlers` right before the closing `}` of the switch:

```typescript
case 'openClaudeCode': {
    try {
        await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', null, '');
    } catch {
        vscode.window.showInformationMessage('Claude Code extension not found. Install it from the marketplace.');
    }
    break;
}

case 'openCodex': {
    try {
        await vscode.commands.executeCommand('codex.open');
    } catch {
        vscode.window.showInformationMessage('Codex extension not found. Install it from the marketplace.');
    }
    break;
}
```

- [ ] **Step 2: Compile and verify**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/webview/provider.ts
git commit -m "feat: add openClaudeCode and openCodex message handlers"
```

---

### Task 5: End-to-end compile and test

**Files:**
- All modified files

- [ ] **Step 1: Full compile**

Run: `npm run vscode:prepublish`
Expected: Clean compilation, no errors

- [ ] **Step 2: Run existing tests**

Run: `npm test`
Expected: All existing tests pass (provenance, annotations, pythonEnv)

- [ ] **Step 3: Manual smoke test**

1. Open a Python file in VS Code
2. Click the GDS Viewer button in the editor toolbar
3. Verify the viewer opens with the Run/Claude/Codex buttons visible in the top-right corner
4. Click "Run" — verify the loading overlay appears, the script rebuilds, and the viewer reloads
5. Click "Claude" — verify it opens the Claude Code sidebar (or shows a message if not installed)
6. Click "Codex" — verify it opens Codex (or shows a message if not installed)
7. Click "Run" again with a script that has errors — verify the error overlay dismisses and an error notification appears

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address smoke test issues from rebuild button"
```

---

## Self-Review

**1. Spec coverage:**
- "Run button in right up corner" → Task 3 (action bar with Run button, top-right)
- "alongside the open claude code and open codex" → Task 3 (Claude and Codex buttons in same bar)
- "Once click, rebuild the script" → Task 1 (rebuildAndReload), Task 2 (rebuild message handler), Task 3 (rebuildScript JS + overlay)

**2. Placeholder scan:**
- No TBD, TODO, or "implement later" found
- All code blocks contain actual implementation code
- All commands specified with expected output

**3. Type consistency:**
- `rebuildAndReload(pythonFile: string): Promise<boolean>` — defined in Task 1, used in Task 2 via dynamic import
- `_currentPythonFile` is a `string` — set in Task 1 `setCurrentPythonFile`, read in Task 2 handler
- postMessage types match between webview (Task 3 JS) and provider.ts (Tasks 2, 4 TypeScript): `rebuild`, `rebuildError`, `loadGds`, `openClaudeCode`, `openCodex`
