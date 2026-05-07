# Silent Claude Context Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace intrusive `primaryEditor.open` on component click with silent `insertAtMention` injection that cascades: VS Code extension sidebar → CLI terminal → no-op.

**Architecture:** A single new function `syncClaudeContext` replaces both `notifyClaudeCodeSelection` and `syncSelectionOnOpenEditors`. It detects Claude Code availability (sidebar visible, then CLI terminal), then injects `@file:line` mentions without opening new windows. Two pure helper functions (`formatMentions`, `filterLocationsByFile`) are extracted for testability. Detection and injection remain in `provider.ts` since they depend on VS Code APIs and are tightly coupled to the message handler.

**Tech Stack:** TypeScript, VS Code Extension API, Node test runner

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/webview/provider.ts` | Detection functions, injection functions, `syncClaudeContext` orchestrator, updated `selectComponents` handler |
| `src/webview/provenance.ts` | `formatMentions` and `filterLocationsByFile` — pure functions extracted for testability |
| `src/webview/provenance.test.ts` | Unit tests for the two new pure functions |

---

### Task 1: Add pure helper functions to provenance.ts

**Files:**
- Modify: `src/webview/provenance.ts` (append at end of file)

- [ ] **Step 1: Add `filterLocationsByFile` and `formatMentions`**

Add to `src/webview/provenance.ts` after the existing exports:

```typescript
export function filterLocationsByFile(
    locations: SourceLocation[],
    primaryFile: string,
    resolvePath: (f: string) => string
): SourceLocation[] {
    const normalized = resolvePath(primaryFile).replace(/\\/g, '/');
    return locations.filter(
        (loc) => resolvePath(loc.file).replace(/\\/g, '/') === normalized
    );
}

export function formatMentions(locations: SourceLocation[]): string {
    return locations.map((loc) => `@${loc.file}:${loc.line}`).join(' ');
}
```

- [ ] **Step 2: Write tests for both functions**

Modify `src/webview/provenance.test.ts` — append after the last test:

```typescript
import { filterLocationsByFile, formatMentions, type SourceLocation } from './provenance';

test('filterLocationsByFile keeps only locations in the primary file', () => {
    const resolvePath = (f: string) => f;
    const locations: SourceLocation[] = [
        { file: 'a.py', line: 10 },
        { file: 'a.py', line: 20 },
        { file: 'b.py', line: 30 },
        { file: 'a.py', line: 40 },
    ];

    assert.deepEqual(
        filterLocationsByFile(locations, 'a.py', resolvePath),
        [
            { file: 'a.py', line: 10 },
            { file: 'a.py', line: 20 },
            { file: 'a.py', line: 40 },
        ]
    );
});

test('filterLocationsByFile returns empty when no matches', () => {
    const resolvePath = (f: string) => f;
    const locations: SourceLocation[] = [
        { file: 'b.py', line: 30 },
    ];

    assert.deepEqual(
        filterLocationsByFile(locations, 'a.py', resolvePath),
        []
    );
});

test('formatMentions joins file:line with @ prefix', () => {
    const locations: SourceLocation[] = [
        { file: 'dir/a.py', line: 359 },
        { file: 'dir/a.py', line: 504 },
        { file: 'dir/a.py', line: 522 },
    ];

    assert.equal(
        formatMentions(locations),
        '@dir/a.py:359 @dir/a.py:504 @dir/a.py:522'
    );
});

test('formatMentions returns empty string for empty array', () => {
    assert.equal(formatMentions([]), '');
});
```

- [ ] **Step 3: Compile and run tests**

Run: `npx tsc -p ./; if ($?) { node --test out/webview/provenance.test.js }`
Expected: 7 tests pass (3 existing + 4 new)

- [ ] **Step 4: Commit**

```bash
git add src/webview/provenance.ts src/webview/provenance.test.ts
git commit -m "feat: add filterLocationsByFile and formatMentions helpers"
```

---

### Task 2: Remove old Claude notification code

**Files:**
- Modify: `src/webview/provider.ts`

- [ ] **Step 1: Remove `notifyClaudeCodeSelection` and `syncSelectionOnOpenEditors`**

Delete the functions `notifyClaudeCodeSelection` (lines 91-103) and `syncSelectionOnOpenEditors` (lines 105-112).

- [ ] **Step 2: Update `selectComponents` handler**

Change the `selectComponents` case to use `syncClaudeContext`:

```typescript
case 'selectComponents':
    _currentSelection = message.components as ComponentSelection[];
    highlightOpenSourceLocations(_currentSelection);
    await syncClaudeContext(_currentSelection);
    break;
```

- [ ] **Step 3: Update `openSourceFile` to remove Claude notification**

Change `openSourceFile` back to accept a single `line?: number` parameter (restore the `requestSource` handler compatibility):

```typescript
async function openSourceFile(filePath: string, line?: number): Promise<void> {
    const resolved = resolveWorkspacePath(filePath);
    const fullPath = vscode.Uri.file(resolved);
    try {
        const doc = await vscode.workspace.openTextDocument(fullPath);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        if (line != null && line > 0) {
            const range = lineToRange(doc, line);
            if (range) {
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.setDecorations(_sourceHighlight, [range]);
            }
        }
    } catch {
        vscode.window.showErrorMessage(`File not found: ${filePath}`);
    }
}
```

- [ ] **Step 4: Update `requestSource` handler**

Restore single-line call:

```typescript
case 'requestSource': {
    const { file, line } = message;
    if (file) {
        await openSourceFile(file, line);
    }
    break;
}
```

- [ ] **Step 5: Compile to verify no TypeScript errors**

Run: `npx tsc -p ./`
Expected: No output (clean compile)

- [ ] **Step 6: Commit**

```bash
git add src/webview/provider.ts
git commit -m "refactor: remove intrusive Claude notification from component click"
```

---

### Task 3: Add detection and injection functions

**Files:**
- Modify: `src/webview/provider.ts` (insert before `openSourceFile`)

- [ ] **Step 1: Add detection functions**

Insert after `highlightOpenSourceLocations`:

```typescript
function detectSidebarVisible(): boolean {
    for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
            if (tab.label.includes('Claude Code')) {
                return true;
            }
        }
    }
    return false;
}

function detectCliTerminal(): vscode.Terminal | undefined {
    for (const terminal of vscode.window.terminals) {
        if (terminal.name.toLowerCase().includes('claude')) {
            return terminal;
        }
    }
    return undefined;
}
```

- [ ] **Step 2: Add injection functions**

Insert after detection functions:

```typescript
async function injectViaSidebar(
    locations: SourceLocation[]
): Promise<void> {
    if (locations.length === 0) return;

    const resolvedPath = resolveWorkspacePath(locations[0].file);
    const fullPath = vscode.Uri.file(resolvedPath);

    // Open file as background document if not already open
    let doc: vscode.TextDocument;
    try {
        doc = await vscode.workspace.openTextDocument(fullPath);
    } catch {
        return; // file not found — nothing to mention
    }

    const previousEditor = vscode.window.activeTextEditor;
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);

    for (const loc of locations) {
        const range = lineToRange(doc, loc.line);
        if (!range) continue;
        editor.selection = new vscode.Selection(range.start, range.end);
        try {
            await vscode.commands.executeCommand('claude-vscode.insertAtMention');
        } catch {
            // insertAtMention command not available — stop trying
            break;
        }
    }

    // Restore previous editor
    if (previousEditor && previousEditor.document !== doc) {
        await vscode.window.showTextDocument(
            previousEditor.document,
            previousEditor.viewColumn
        );
    }
}

async function injectViaTerminal(
    terminal: vscode.Terminal,
    locations: SourceLocation[]
): Promise<void> {
    const text = formatMentions(locations);
    if (!text) return;
    terminal.show();
    terminal.sendText(text);
}
```

- [ ] **Step 3: Add the `syncClaudeContext` orchestrator**

Insert after `injectViaTerminal`:

```typescript
async function syncClaudeContext(
    components: ComponentSelection[]
): Promise<void> {
    if (components.length === 0) return;

    const allLocations = components.flatMap(getSourceChain);
    if (allLocations.length === 0) return;

    const primaryFile = allLocations[0].file;
    const fileLocations = filterLocationsByFile(
        allLocations,
        primaryFile,
        resolveWorkspacePath
    );

    // Priority 1: VS Code extension sidebar visible
    if (detectSidebarVisible()) {
        await injectViaSidebar(fileLocations);
        return;
    }

    // Priority 2: Claude CLI running in a terminal
    const terminal = detectCliTerminal();
    if (terminal) {
        await injectViaTerminal(terminal, fileLocations);
        return;
    }

    // Priority 3: Nothing reachable — no-op
}
```

- [ ] **Step 4: Add imports**

Add `filterLocationsByFile` and `formatMentions` to the import from `./provenance`:

```typescript
import {
    getSourceChain,
    filterLocationsByFile,
    formatMentions,
    type ComponentSelection,
    type SourceLocation,
} from './provenance';
```

- [ ] **Step 5: Compile to verify**

Run: `npx tsc -p ./`
Expected: No output (clean compile)

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/webview/provider.ts
git commit -m "feat: add silent Claude context injection with priority cascade"
```

---

### Task 4: Final verification

- [ ] **Step 1: Review full diff**

```bash
git diff main -- src/webview/
```

- [ ] **Step 2: Verify behavior matrix manually**

| Test | Expected |
|------|----------|
| Click component with Claude sidebar visible | @mentions appear in chat, no new window |
| Click component with only CLI terminal open | @file:line sent to terminal, no Enter |
| Click component with neither open | Decorations only |
| Click "Open source" in console | File opens, line selected, decorations |
| Click multiple components in succession | @mentions accumulate |

- [ ] **Step 3: Commit any final tweaks**

---

## Implementation Notes

- **`insertAtMention` can only be called once per selection change** — the loop in `injectViaSidebar` sets the selection then calls the command sequentially. Each iteration creates a distinct mention because the selection changes.
- **`preserveFocus` not used** — `insertAtMention` reads the active editor, so the provenance file must briefly be active. Previous editor is restored afterward.
- **The `requestSource` flow is unchanged** — it still opens files and highlights lines. No Claude notification on this path.
- **`formatMentions` and `filterLocationsByFile` are extracted to `provenance.ts`** — they're pure functions, testable without VS Code, and `provenance.ts` already owns all source-location logic.
