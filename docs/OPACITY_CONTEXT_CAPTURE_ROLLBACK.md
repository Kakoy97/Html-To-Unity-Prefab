# Opacity + Low-Alpha Context Capture (Rollback Notes)

Date: `2026-02-17`

This change adds two generic rules:

1. `opacity-decoupled`
- For safe atomic visual nodes (for example `img`) with `opacity < 1`, capture pixels with `opacity=1`.
- Keep final alpha in layout metadata, then apply alpha in Unity `Image.color.a`.
- Goal: avoid "double attenuation" (washed-out color).

2. `low-alpha-context-capture`
- For low-alpha translucent background containers (strict trigger conditions), switch to in-place capture and keep ancestor paint.
- Goal: keep local context tone instead of capturing a flat translucent patch on transparent background.

3. `background-stack-composite`
- For near-root fullscreen background image stacks (`img` + fullscreen overlay siblings), capture stack as one composed background asset.
- Goal: reduce browser-vs-Unity layered blend mismatch on background tone.

4. `nav-load-timeout-fallback`
- HTML opening now uses `domcontentloaded` as the required gate.
- A short best-effort wait for `document.readyState === 'complete'` is still attempted.
- If it times out, conversion continues with an explicit warning token instead of aborting.

5. `underlay-faint-border-suppressed`
- In `preserve-scene-underlay` mode only, if border is both thin and very low-alpha, border color is temporarily neutralized during capture.
- Goal: avoid unintended halo/outline artifacts while keeping generic behavior.

## Files touched

- `tool/src/core/Context.js`
- `tool/src/core/Analyzer.js`
- `tool/src/core/Planner.js`
- `tool/src/core/Baker.js`
- `tool/src/core/Assembler.js`
- `Assets/Editor/HtmlToPrefab/LayoutModels.cs`
- `Assets/Editor/HtmlToPrefab/PrefabBuilder.cs`

## Fast rollback switches (no code revert needed)

Disable opacity decouple:

```powershell
node tool/src/index.js --html test/g.html --disable-opacity-decouple
```

Disable low-alpha context capture:

```powershell
node tool/src/index.js --html test/b.html --disable-low-alpha-context-capture
```

Disable both:

```powershell
node tool/src/index.js --html test/b.html --disable-opacity-decouple --disable-low-alpha-context-capture
```

Disable background stack composite:

```powershell
node tool/src/index.js --html test/g.html --disable-background-stack-composite
```

Disable underlay faint-border suppression:

```powershell
node tool/src/index.js --html test/b.html --disable-underlay-faint-border-suppression
```

Disable navigation fallback (restore strict `waitUntil:'load'` behavior):

```powershell
node tool/src/index.js --html test/d.html --disable-nav-load-timeout-fallback
```

Tune navigation/settle/font wait (without code revert):

```powershell
node tool/src/index.js --html test/d.html --nav-timeout-ms 45000 --nav-load-settle-timeout-ms 6000 --fonts-ready-timeout-ms 4000
```

## Trace tokens for audit

Check `output/debug/bake_plan.json` and `output/debug/rules_trace.json`:

- `opacity-decoupled`
- `low-alpha-context-capture`
- `background-stack-composite`
- `preserve-scene-underlay`
- `underlay-faint-border-suppressed`
- `nav-load-timeout-fallback` (runtime warning log token)

These tokens are the regression guardrails for this patch.

## Hard rollback (code-level)

If severe restoration regression appears across multiple pages:

1. Revert the file list above.
2. Re-run at least two representative pages.
3. Run:

```powershell
node tool/src/validate_rules_trace.js <output_dir>/debug
```
