# Source Selection Sync Design

## Goal

When a user clicks a source link in the GDS viewer console ("Open source"), open the file and set `editor.selection` to the provenance line **with ±3 context lines**. Claude Code natively detects the selection change and shows "X lines selected". No buffer, no file opening on component click, no ongoing hijacking.

## Motivation

The existing `openSourceFile()` already sets `editor.selection` when a user clicks a source link. But the range is only one line. Widening it to include context lines makes Claude Code's selection detection more useful while keeping the exact same interaction flow.

## Behavior

| User action | What happens |
|-------------|-------------|
| Click component in GDS viewer | Highlight lines in already-open editors (decorations only). **No file opening, no selection change.** |
| Click "Open source" link in console | Open the file, scroll to line, set `editor.selection` to line ± 3 context. Claude Code detects selection change. |
| Manually select text in VS Code afterward | Works normally. Selection is one-time, not persistently hijacked. |

## Architecture

No new functions. No buffer. No prompt changes. Just widen the range in `openSourceFile()`.

```
Click "Open source" (viewer.html)
    │
    ├─ requestSource { file, line }
    │
    └─ provider.ts: openSourceFile(file, line)
           │
           ├─ Open document
           ├─ Compute range: [max(0, line-4), min(lineCount-1, line+2)]
           │   (0-indexed, ±3 lines context)
           ├─ editor.revealRange(originalLine)   ← still centered on the exact line
           ├─ editor.selection = widenedRange     ← Claude Code detects this
           └─ editor.setDecorations(highlight, [originalLine])
```

## Change

### `src/webview/provider.ts` — `openSourceFile()`

The only change: compute a widened range for `editor.selection` while keeping `revealRange` centered on the original line.

```typescript
async function openSourceFile(filePath: string, line?: number): Promise<void> {
    // ... (existing path resolution unchanged) ...
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    if (line && line > 0) {
        const targetRange = lineToRange(doc, line);
        if (!targetRange) return;

        // Widen selection to include context lines
        const selStart = Math.max(0, targetRange.start.line - SELECTION_CONTEXT);
        const selEnd = Math.min(doc.lineCount - 1, targetRange.end.line + SELECTION_CONTEXT);
        const selRange = new vscode.Range(selStart, 0, selEnd, 0);

        editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(selRange.start, selRange.end);
        editor.setDecorations(_sourceHighlight, [targetRange]);
    }
}
```

Add constant at module level:
```typescript
const SELECTION_CONTEXT = 3;
```

## Files Changed

| File | Change |
|------|--------|
| `src/webview/provider.ts` | Add `SELECTION_CONTEXT` constant, widen `editor.selection` range in `openSourceFile()` (~5 lines changed) |

**That's it.** No other files touched.

## Edge Cases

| Case | Handling |
|------|----------|
| Line near file start (line 1) | `Math.max(0, line-4)` clamps to start |
| Line near file end | `Math.min(lineCount-1, line+2)` clamps to end |
| File not found | Existing catch block handles it |
| No line provided | Existing guard `if (line && line > 0)` skips |

## Verification

1. Open a GDS file with provenance data in the viewer
2. Click a component → highlights appear in open editors, no file opened
3. Click "Open source" link in console → file opens, line ± 3 is selected
4. Check Claude Code: shows "X lines selected from file.py" 
5. Manually select different text afterward → works normally, no interference
