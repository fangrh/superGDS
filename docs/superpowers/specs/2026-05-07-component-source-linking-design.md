# Component Source Linking Design

## Goal

Make GDS component selection behave like an editor-aware source navigation surface instead of a copy-and-ask workflow. Selecting a GDS component should expose provenance and the source call chain immediately, while opening source files only when the user explicitly clicks a source link.

## Interaction

When the user clicks one or more GDS components, the webview sends the selected components to the extension. The extension writes a concise entry to the `superGDS` Output channel for every selection, including component identity, geometry basics, primary source, and the normalized call chain.

The webview bottom console defaults to `Source`, with tab order `Source | Info`. The Source tab shows clickable source links for the primary provenance location and every call-chain frame. Clicking a link opens the corresponding file and line in VS Code.

If a referenced source file is already open in a visible text editor, selecting the component highlights the referenced line in that editor. If the file is not already open, selection does not open it and does not create an editor highlight. The Output channel and Source tab still show the source information in both cases.

## Architecture

The existing webview remains the interaction surface. It continues to own GDS selection state and sends `selectComponents` messages to the extension with provenance payloads.

The extension provider becomes responsible for editor-side effects:

- Maintain a `superGDS` Output channel.
- Normalize primary provenance plus `call_chain` or `call_stack` data.
- Apply line decorations only to visible editors whose document path already matches a selected source path.
- Clear old decorations before applying new ones.
- Open a source file only in response to `requestSource`.

The Source panel stops fetching source text through `/source?...`, because the VS Code webview has no HTTP source endpoint. It instead renders a provenance chain list with clickable file/line rows.

## Data Flow

1. User selects a GDS component in the webview.
2. Webview updates its Source and Info panels.
3. Webview posts `selectComponents` with selected provenance, layer, and bbox.
4. Extension writes selection details and call chain to `superGDS` Output.
5. Extension highlights matching lines only in already visible editors.
6. User clicks a Source row.
7. Webview posts `requestSource`.
8. Extension opens the file at the requested line and applies the normal cursor reveal.

## Testing

Unit-style tests should cover the pure provenance formatting and chain normalization logic used by the extension. Because this repo does not currently have a VS Code extension test harness, compile-time verification with `npm run vscode:prepublish` is the minimum integration check.

Manual verification should cover:

- Selecting a component writes Output even if no source file is open.
- Selecting a component highlights only visible already-open source files.
- Clicking Source rows opens the relevant file and line.
- Source is the default console tab and appears before Info.
