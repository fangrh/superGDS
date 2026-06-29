# Claude Communication Mode Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dropdown selector in the Source/Info console header that lets the user choose how selections are communicated to Claude Code: "Auto" (current behavior — auto-inject into terminal/sidebar), "Clipboard" (copy mentions to clipboard only), or "Off" (do nothing on select).

**Architecture:** A new `#claude-mode` dropdown is added to the console header bar, left of the collapse arrow. When the user selects a polygon, the webview sends `selectComponents` with the chosen mode. The extension host (`provider.ts`) reads the mode and either auto-injects (current `syncClaudeContext`), copies to clipboard only, or skips injection entirely. The mode persists in the webview's `localStorage`-equivalent (a module-level variable, since the webview is retained via `retainContextWhenHidden`).

**Tech Stack:** TypeScript (VS Code Extension API), HTML/CSS/JS (webview), postMessage bridge

---

## File Structure

| File | Responsibility |
|------|---------------|
| `media/viewer.html` | Add `#claude-mode` dropdown to console header. Store mode in JS variable. Send mode with `selectComponents` message. |
| `src/webview/provider.ts` | Read `message.mode` from `selectComponents`. Route to auto-inject, clipboard-only, or skip. |

---

### Task 1: Add Claude mode dropdown to the console header in viewer.html

**Files:**
- Modify: `media/viewer.html`

This task adds the dropdown UI to the console header bar, positioned left of the collapse arrow.

- [ ] **Step 1: Add CSS for the mode dropdown**

Add these styles inside the `<style>` block, after the `.tab-btn:hover` rule (around line 35):

```css
#claude-mode { background: #1e1e2e; color: #cdd6f4; border: 1px solid #313244; border-radius: 4px; padding: 2px 6px; font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; cursor: pointer; outline: none; }
#claude-mode:hover { border-color: #585b70; }
#claude-mode option { background: #1e1e2e; color: #cdd6f4; }
```

- [ ] **Step 2: Add the dropdown HTML to the console header**

Find the right-side `<span>` in the console header (the one containing the collapse arrow). Change it from:

```html
            <span style="display:flex;align-items:center;gap:6px;">
                <span onclick="toggleConsole()" title="Collapse" style="cursor:pointer;color:#6c7086;font-size:14px;">&#9660;</span>
            </span>
```

To:

```html
            <span style="display:flex;align-items:center;gap:6px;">
                <select id="claude-mode" title="Claude Code communication mode">
                    <option value="auto">Auto</option>
                    <option value="clipboard">Clipboard</option>
                    <option value="off">Off</option>
                </select>
                <span onclick="toggleConsole()" title="Collapse" style="cursor:pointer;color:#6c7086;font-size:14px;">&#9660;</span>
            </span>
```

- [ ] **Step 3: Update `postSelectedComponents` to include the mode**

Find the `postSelectedComponents` function (around line 329):

```javascript
function postSelectedComponents(features) {
    vscode.postMessage({
        type: 'selectComponents',
        components: componentsFromFeatures(features)
    });
}
```

Change it to:

```javascript
function postSelectedComponents(features) {
    var mode = document.getElementById('claude-mode').value;
    vscode.postMessage({
        type: 'selectComponents',
        components: componentsFromFeatures(features),
        claudeMode: mode
    });
}
```

- [ ] **Step 4: Commit**

```bash
git add media/viewer.html
git commit -m "feat: add Claude communication mode dropdown to console header"
```

---

### Task 2: Route communication behavior in provider.ts based on mode

**Files:**
- Modify: `src/webview/provider.ts`

This task reads the `claudeMode` from the webview message and routes accordingly: auto (current behavior), clipboard-only, or off.

- [ ] **Step 1: Add clipboard-only function**

Add this function right after the existing `injectViaSidebar` function (after line 171):

```typescript
async function injectClipboardOnly(
    locations: SourceLocation[]
): Promise<void> {
    const text = formatClaudeChatMentions(locations);
    if (!text) return;

    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Claude mentions copied to clipboard');
}
```

- [ ] **Step 2: Add the `ClaudeMode` type alias**

Add this type alias near the top of the file, after the existing imports (around line 12):

```typescript
type ClaudeMode = 'auto' | 'clipboard' | 'off';
```

- [ ] **Step 3: Update `syncClaudeContext` to accept a mode parameter**

Replace the existing `syncClaudeContext` function (lines 187–204):

```typescript
async function syncClaudeContext(
    components: ComponentSelection[],
    mode: ClaudeMode = 'auto'
): Promise<void> {
    if (components.length === 0) {
        return;
    }

    const allLocations = getSelectionSourceLocations(components);
    if (allLocations.length === 0) return;

    if (mode === 'off') return;

    if (mode === 'clipboard') {
        await injectClipboardOnly(allLocations);
        return;
    }

    // mode === 'auto'
    const terminal = detectCliTerminal();
    if (terminal) {
        await injectViaTerminal(terminal, allLocations);
        return;
    }

    await injectViaSidebar(allLocations);
}
```

- [ ] **Step 4: Pass the mode from the message handler**

In the `selectComponents` case (around line 20), change from:

```typescript
case 'selectComponents':
    _currentSelection = message.components as ComponentSelection[];
    highlightOpenSourceLocations(_currentSelection);
    await syncClaudeContext(_currentSelection);
    break;
```

To:

```typescript
case 'selectComponents':
    _currentSelection = message.components as ComponentSelection[];
    highlightOpenSourceLocations(_currentSelection);
    await syncClaudeContext(_currentSelection, message.claudeMode as ClaudeMode);
    break;
```

- [ ] **Step 5: Compile and verify**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/webview/provider.ts
git commit -m "feat: route Claude communication based on mode (auto/clipboard/off)"
```

---

### Task 3: End-to-end compile and verify

**Files:**
- All modified files

- [ ] **Step 1: Full compile**

Run: `npm run vscode:prepublish`
Expected: Clean compilation, no errors

- [ ] **Step 2: Manual smoke test**

1. Open a Python file in VS Code
2. Click the GDS Viewer button
3. Verify the Source/Info console header shows the "Auto | Clipboard | Off" dropdown, left of the collapse arrow
4. Select "Clipboard" mode, click a polygon — verify "Claude mentions copied to clipboard" notification appears
5. Select "Auto" mode, click a polygon — verify current auto-inject behavior works
6. Select "Off" mode, click a polygon — verify nothing happens (no clipboard, no injection)
7. Rebuild (click Run) — verify the dropdown resets to "Auto" (or retains selection)

---

## Self-Review

**1. Spec coverage:**
- "options in the Source and Info console, in the right, left of the collapse" → Task 1 Step 2 (dropdown in console header, left of collapse arrow)
- "select the behavior to communicate with claude code" → Task 1 Step 3 (send mode with message), Task 2 Steps 3-4 (route behavior)
- "either auto" → Task 2 Step 3 (auto mode = current behavior)
- "clipboard, which contain in click board and I past myself" → Task 2 Step 1 (clipboard-only function)

**2. Placeholder scan:**
- No TBD, TODO, or "implement later" found
- All code blocks contain actual implementation code
- All commands specified with expected output

**3. Type consistency:**
- `ClaudeMode` type defined in Task 2 Step 2, used in Steps 3 and 4
- `message.claudeMode` is a string from the `<select>` dropdown (`'auto' | 'clipboard' | 'off'`)
- `syncClaudeContext` signature matches between definition (Task 2 Step 3) and call site (Task 2 Step 4)
