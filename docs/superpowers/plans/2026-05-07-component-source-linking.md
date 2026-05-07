# Component Source Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the copy-and-ask provenance flow with editor-aware source linking, Output logging, and click-to-open call-chain navigation.

**Architecture:** Keep GDS selection and panel rendering in `media/viewer.html`. Move editor-aware behavior into `src/webview/provider.ts`, with pure helper functions exported for tests and VS Code side effects limited to Output, decorations, and explicit source-open requests.

**Tech Stack:** TypeScript VS Code extension APIs, vanilla JavaScript webview, Node test runner for pure TypeScript helper tests, existing TypeScript compiler.

---

## File Structure

- Modify `src/webview/provider.ts`: add Output channel logging, call-chain normalization, opened-editor-only decorations, and request-source navigation.
- Modify `media/viewer.html`: make Source the default tab, render clickable source-chain rows, remove the broken `/source` fetch path, and send source-link click messages.
- Create `src/webview/provenance.ts`: pure provenance normalization and formatting helpers shared by provider tests.
- Create `src/webview/provenance.test.ts`: Node test-runner tests for source-chain normalization and Output formatting.
- Modify `package.json`: add a `test` script that compiles then runs `out/webview/provenance.test.js`.

## Task 1: Extract Provenance Helpers With Tests

**Files:**
- Create: `src/webview/provenance.ts`
- Create: `src/webview/provenance.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

Create tests for:
- Primary `file`/`line` appears first.
- `call_chain` entries are included without duplicates.
- Legacy `call_stack` strings parse into file, line, and function.
- Output text contains component basics plus source chain.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`

Expected: failure because the new test file or helper module is missing.

- [ ] **Step 3: Implement pure helpers**

Add:
- `ComponentSelection`
- `SourceLocation`
- `getSourceChain(component)`
- `formatSelectionForOutput(components)`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`

Expected: Node test runner passes the provenance helper tests.

## Task 2: Add Extension Output and Opened-Editor Highlighting

**Files:**
- Modify: `src/webview/provider.ts`

- [ ] **Step 1: Wire helpers into `selectComponents`**

On every `selectComponents` message:
- Cache current selection.
- Append formatted details to `superGDS` Output.
- Show the Output channel without stealing focus.
- Highlight source lines only in visible editors whose document path matches selected source paths.

- [ ] **Step 2: Keep click-to-open behavior explicit**

Keep `requestSource` as the only path that opens files. After opening, reveal and select the target line.

- [ ] **Step 3: Compile**

Run: `npm run vscode:prepublish`

Expected: TypeScript compile succeeds.

## Task 3: Update Webview Source UX

**Files:**
- Modify: `media/viewer.html`

- [ ] **Step 1: Make Source the default tab**

Change tab order to `Source | Info`, initialize `activeTab` to `source`, show `source-panel`, and hide `info-panel` by default.

- [ ] **Step 2: Replace source fetch with clickable provenance links**

Render each primary source and call-chain frame as a clickable row. Clicking posts `requestSource` with `{ file, line }`.

- [ ] **Step 3: Keep Info as metadata-only**

Leave layer, bbox, area, instance, cell, and repository details in Info.

- [ ] **Step 4: Compile**

Run: `npm run vscode:prepublish`

Expected: TypeScript compile succeeds and HTML remains static webview-compatible.

## Task 4: Final Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run unit tests**

Run: `npm test`

Expected: all provenance helper tests pass.

- [ ] **Step 2: Run extension compile**

Run: `npm run vscode:prepublish`

Expected: TypeScript compile succeeds.

- [ ] **Step 3: Inspect diff**

Run: `git diff --check`

Expected: no whitespace errors.
