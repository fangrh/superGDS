# Silent Claude Context Injection Design

## Goal

When a user clicks a GDS component, inject provenance source locations into Claude Code's context silently — without opening a new Claude Code window, without pasting into its primary editor. If no Claude Code is reachable, do nothing beyond editor decorations.

## Motivation

The current implementation runs `primaryEditor.open` on every component click, which opens/activates Claude Code and replaces the chat input. This is intrusive: the user may be exploring components without asking questions yet. Context should flow silently into the chat's mention area, not hijack focus.

## Priority Cascade

```
Component click
    │
    ├─► 1. Is Claude Code VSIX sidebar VISIBLE?
    │       Yes → insertAtMention for each provenance line (accumulated)
    │
    ├─► 2. No → Is "claude" CLI running in a VS Code terminal?
    │       Yes → terminal.sendText with @file:line references
    │
    └─► 3. Neither → do nothing (decorations only)
```

## Detection

### Sidebar visibility

Check `vscode.window.tabGroups.all` for an open editor tab whose label includes "Claude Code" (the sidebar webview title).

### CLI terminal

Iterate `vscode.window.terminals` for a terminal whose name contains `claude` (case-insensitive). The terminal's `creationOptions.name` reflects the process name.

## Injection

### Extension path (priority 1)

1. If the provenance file is not open in any visible editor, open it as a background document
2. Save reference to the current active editor
3. Switch to the provenance file's editor
4. For each provenance line in the primary file:
   - Set `editor.selection` to that specific line
   - Call `vscode.commands.executeCommand('claude-vscode.insertAtMention')`
5. Restore focus to the previously active editor

This creates `@file:359 @file:504 @file:522 @file:542` in the chat input. The sidebar is NOT opened — mentions accumulate in the existing chat input. Subsequent component clicks append more mentions.

### CLI path (priority 2)

1. Call `terminal.show()` to reveal the existing terminal (no new process created)
2. Call `terminal.sendText()` with one line containing all `@file:line` references separated by spaces

The terminal receives the text but does NOT send Enter — the user can review the mentions before pressing Enter themselves.

### No path (priority 3)

If neither the extension sidebar nor a CLI terminal is found, the function is a no-op. Decorations are still applied by the existing `highlightOpenSourceLocations`.

## Behavior Matrix

| User action | Sidebar visible? | CLI open? | Result |
|---|---|---|---|
| Click component | Yes | — | @mentions inserted into chat input |
| Click component | No | Yes | @file:line sent to terminal (no Enter) |
| Click component | No | No | Decorations only, nothing else |
| Click another component | Yes | — | Old @mentions replaced, new ones inserted |
| Click "Open source" in console | — | — | Opens file, selects line (unchanged from today) |

## Architecture

```
selectComponents handler
    │
    ├─► highlightOpenSourceLocations()        ← decorations (unchanged)
    │
    └─► syncClaudeContext(allLocations)       ← NEW
          │
          ├─► detectSidebarVisible()
          │     └─► each location: selection → insertAtMention
          │
          ├─► (else) detectCliTerminal()
          │     └─► terminal.sendText(mentions)
          │
          └─► (else) no-op
```

No file opening on component click. No `primaryEditor.open`. No `sidebar.open`.

## Edge Cases

| Case | Handling |
|------|----------|
| Claude sidebar tab exists but is not focused | Still counts as "visible" — insertAtMention still works |
| Multiple Claude terminals open | Use the first one whose name contains "claude" |
| `insertAtMention` command fails | Catch and fall through silently; decorations still applied |
| Provenance file not open in any editor | Open it as a background document, make it active briefly during injection, then restore previous active editor |
| User clicks multiple components | @mentions accumulate in chat input. User can clear manually. |

## Files Changed

| File | Change |
|------|--------|
| `src/webview/provider.ts` | Replace `notifyClaudeCodeSelection` + `syncSelectionOnOpenEditors` with `syncClaudeContext`, add `detectSidebarVisible`, `detectCliTerminal`, `injectViaSidebar`, `injectViaTerminal` |

## Verification

1. Open GDS viewer, click a component → decorations appear, no Claude window opens
2. Open Claude Code sidebar in VS Code → click a component → @mentions appear in chat input
3. Close sidebar, open `claude` in a terminal → click a component → @file:line appears in terminal
4. Close both → click a component → decorations only
5. Click "Open source" in console → file opens normally (regression check)
