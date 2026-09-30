# AtlasEngine

## General architecture overview

```mermaid
graph TD
    Renderer["Renderer (base/renderer.cpp)<br><small>breaks the text buffer down into GDI-oriented graphics<br>primitives (#quot;change brush to color X#quot;, #quot;draw string Y#quot;, ...)</small>"]
    RenderEngineBase[/"RenderEngineBase<br>(base/RenderEngineBase.cpp)<br><small>abstracts 24 LOC 👻</small>"\]
    GdiEngine["GdiEngine (gdi/...)"]

    subgraph AtlasEngine["AtlasEngine (atlas/...)"]
        AtlasEngine.cpp["AtlasEngine.cpp<br><small>Implements IRenderEngine text rendering API<br>breaks GDI graphics primitives down into DWRITE_GLYPH_RUNs</small>"]
        AtlasEngine.api.cpp["AtlasEngine.api.cpp<br><small>Implements the parts run inside the console<br>lock (many IRenderEngine setters)<small>"]
        AtlasEngine.r.cpp["AtlasEngine.r.cpp<br><small>Implements the parts run<br>outside of the console lock<small>"]
        Backend.cpp["Backend.cpp<br><small>Implements common functionality/helpers</small>"]
        BackendD2D.cpp["BackendD2D.cpp<br><small>Pure Direct2D text renderer (for low latency<br>remote desktop and older/no GPUs)</small>"]
        BackendD3D.cpp["BackendD3D.cpp<br><small>Custom, performant text renderer<br>with our own glyph cache</small>"]
    end

    Renderer -.-> RenderEngineBase
    %% Mermaid.js has no support for backwards arrow at the moment
    RenderEngineBase <-.->|extends| GdiEngine
    Renderer ----> AtlasEngine
    AtlasEngine.cpp <--> AtlasEngine.api.cpp
    AtlasEngine.cpp <--> AtlasEngine.r.cpp
    AtlasEngine.r.cpp --> BackendD2D.cpp
    AtlasEngine.r.cpp --> BackendD3D.cpp
    BackendD2D.cpp -.- Backend.cpp
    BackendD3D.cpp -.- Backend.cpp
```

As you can see, breaking the text buffer down into GDI-style primitives just to rebuild them into DirectWrite ones, is pretty wasteful. It's also incredibly bug prone. It would be beneficial if the TextBuffer and rendering settings were given directly to AtlasEngine so it can do its own bidding.

## Right-to-left text (Arabic, Hebrew, ...)

The terminal buffer stores text in logical order, one cell after another, but the backends draw a row's glyphs strictly from left to right.
`AtlasEngine::_flushBufferLine` bridges this gap for rows that contain right-to-left characters (all other rows take the regular path):

1. `_mapBidiBufferLine` runs `IDWriteTextAnalyzer::AnalyzeBidi` on the row and splits it into runs of equal bidi level.
   Box drawing characters are replaced with a strong left-to-right character for this analysis, so that the borders of a TUI end the bidi context and table columns don't swap places.
   The runs are then put into visual order (rule L2 of the Unicode Bidirectional Algorithm).
2. `_mapBufferLineRange` maps every run. Right-to-left runs are shaped with `isRightToLeft = true` (which is what makes Arabic letters join up), and their glyphs, colors and `FontMapping`s are reversed afterwards.
   The glyph offsets are negated, because `advanceOffset` is relative to the direction of the text.
3. `_mapComplex` fits right-to-left text into the grid one word at a time instead of one cluster at a time, to keep connected letters together.

Every run keeps the exact columns it occupies, so the rest of the row is unaffected. The selection and the background colors still operate on logical cells and are not mirrored. A vertical bar cursor is moved to where the next letter of a right-to-left run appears (`PaintCursor`, using `ShapedRow::rtlColumnRanges`).

Some applications, for instance Claude Code, assume a terminal without bidirectional text support and already write right-to-left text in its visual order. Reordering that text again undoes their work, so the mode is a per-window setting, the `BidiMode` registry value (a DWORD next to `UseDx`, in the window's `HKCU\Console\<title>` key):

| `BidiMode` | Meaning |
|---|---|
| `0` | Text is drawn in the order it's stored. |
| `1` (default) | The terminal reorders the text, as described above. |
| `2` | The text is already in visual order. `_mapVisualBufferLine` only joins up the letters: Every word of Arabic letters is reversed back (cell by cell, so that combining marks stay with their letter), shaped as right-to-left text, and the glyphs are put back into the cells they came from. |

With the default mode, the window switches to mode `2` by itself while an application that is known to reorder the text is attached to its console (currently `claude.exe`, see `BidiModeProvider` in `window.cpp`), and back when it exits. The engine asks for the mode at the start of every frame (`SetBidiModeProvider`) and redraws all rows when it changes. Rows that were written by such an application keep the visual order in the buffer, so they look wrong after it exits.

## BackendD3D

The primary entrypoint for rendering is `IBackend::Render` and `BackendD3D` implements it via the following functions, by calling them one by one in the order listed here.

### `_handleSettingsUpdate`

```mermaid
graph TD
    Render --> _handleSettingsUpdate
    _handleSettingsUpdate -->|font changes| _updateFontDependents --> _d2dRenderTargetUpdateFontSettings
    _handleSettingsUpdate -->|misc changes| _recreateCustomShader
    _handleSettingsUpdate --->|misc changes| _recreateCustomRenderTargetView
    _handleSettingsUpdate ---->|size changes| _recreateBackgroundColorBitmap
    _handleSettingsUpdate -----> _recreateConstBuffer
    _handleSettingsUpdate ------> _setupDeviceContextState
```

### `_drawBackground`

```mermaid
graph TD
    Render --> _drawBackground
    _drawBackground --> _uploadBackgroundBitmap
```

### `_drawCursorPart1` / `_drawCursorPart2`

```mermaid
graph TD
    Render --> _drawCursorPart1["_drawCursorPart1<br>runs before _drawText<br>draws cursors that are behind the text"]
    Render --> _drawCursorPart2["_drawCursorPart2<br>runs after _drawText<br>draws inverted cursors"]
    _drawCursorPart1 -.->|_cursorRects| _drawCursorPart2
```

### `_drawText`

```mermaid
graph TD
    Render --> _drawText

    _drawText --> foreachRow(("for each row"))
    foreachRow --> foreachRow
    foreachRow --> foreachFont(("for each font face"))
    foreachFont --> foreachFont
    foreachFont --> foreachGlyph(("for each glyph"))
    foreachGlyph --> foreachGlyph

    foreachGlyph --> _glyphAtlasMap[("font/glyph-pair lookup in<br>glyph cache hashmap")]
    _glyphAtlasMap --> drawGlyph
    drawGlyph --> _appendQuad["_appendQuad<br><small>stages the glyph for later drawing</small>"]
    _glyphAtlasMap --> _appendQuad

    subgraph drawGlyph["if glyph is missing"]
        _drawGlyph["_drawGlyph<br><small>(defers to _drawSoftFontGlyph for soft fonts)</small>"]

        _drawGlyph -.->|if glpyh cache is full| _drawGlyphPrepareRetry
        _drawGlyphPrepareRetry --> _flushQuads["_flushQuads<br><small>draws the current state<br>into the render target</small>"]
        _flushQuads --> _recreateInstanceBuffers["_recreateInstanceBuffers<br><small>allocates a GPU buffer<br>for our glyph instances</small>"]
        _drawGlyphPrepareRetry --> _resetGlyphAtlas["_resetGlyphAtlas<br><small>clears the glyph texture</small>"]
        _resetGlyphAtlas --> _resizeGlyphAtlas["_resizeGlyphAtlas<br><small>resizes the glyph texture if it's still small</small>"]

        _drawGlyph -.->|if it's a DECDHL glyph| _splitDoubleHeightGlyph["_splitDoubleHeightGlyph<br><small>DECDHL glyphs are split up into their<br>top/bottom halves to emulate clip rects</small>"]
    end

    foreachGlyph -.-> _drawTextOverlapSplit["_drawTextOverlapSplit<br><small>splits overly wide glyphs up into smaller chunks to support<br>foreground color changes within the ligature</small>"]

    foreachRow -.->|if gridlines exist| _drawGridlineRow["_drawGridlineRow<br><small>draws underlines, etc.</small>"]
```

### `_drawSelection`

```mermaid
graph TD
    Render --> _drawSelection
```

### `_handleSettingsUpdate`

```mermaid
graph TD
    Render --> _executeCustomShader
```
