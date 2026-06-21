# design-sync notes — Command Center

Repo-specific gotchas for `/design-sync`. Read before any re-sync.

## Setup (why this repo is non-standard)

- **Command Center is a Next.js app, not a published library.** There is no `dist/`.
  The bundle is built from a minimal `--entry` (`.design-sync/ds-main.tsx`, empty)
  plus the real component surface in `cfg.extraEntries` (`.design-sync/ds-entry.tsx`),
  a barrel that re-exports the 22 in-scope components from `src/`.
  - The barrel MUST use **relative** paths (`../src/components/...`), not `@/`: the
    converter's export scanner only follows relative re-exports to learn the
    component names (storybook shape otherwise reads exports from a package `.d.ts`,
    which this app lacks → all titles drop as `[TITLE_UNMAPPED]`).
  - `cfg.extraEntries` path needs a leading `./` (`./.design-sync/ds-entry.tsx`) or
    it's treated as a bare node_modules specifier.
  - `--node-modules` is the repo root `node_modules`.
- **Scope is curated, not "all stories".** ~124 stories exist; only 22 are synced.
  `.design-sync/sb-config/main.ts` narrows the `stories` glob to exactly those 22 so
  the converter discovers only them. It inherits framework/addons/viteFinal from the
  real `.storybook/main.ts`. `.design-sync/sb-config/preview.tsx` re-uses the real
  preview's parameters but REPLACES the decorators (see TooltipProvider below).
- **`@/lib/logging` is server-only** (async_hooks/fs/crypto). `useOverlayScope`
  (ModelSelector, ReasoningLevelSelector, CardContextMenu, ConfirmDialog) imports it.
  `.design-sync/tsconfig.bundle.json` aliases `@/lib/logging` → `.storybook/logging-stub.mjs`
  (the same no-op the Storybook build uses), ahead of `@/*` → `src/*`. `cfg.tsconfig`
  points at this file.
- **FormField** is a compound module (FormGroup/FormLabel/FormInput/FormHint/FormError),
  no single `FormField` export. Story is `title:"UI/FormField"`, `component:FormInput`.
  The barrel aliases `FormInput as FormField` so the card keeps the name + documents
  FormInput props; sub-components stay available for the composed stories.

## Bundle size — mermaid stub (REQUIRED)

- `MarkdownContent` dynamically imports `./MermaidDiagram` → `mermaid` (+ d3/dagre/
  cytoscape/katex, ~68 MB source). In a Next build these are code-split/lazy; the IIFE
  bundle can't code-split, so esbuild inlines everything → 7.6 MB bundle (over the 5 MB
  upload cap). `.design-sync/tsconfig.bundle.json` aliases `mermaid` →
  `.design-sync/stubs/mermaid.ts` (a no-op `initialize`/`render` returning a placeholder
  SVG). Bundle drops to ~1.1 MB. **Behavior delta: mermaid code blocks render a labeled
  placeholder instead of a live diagram.** Syntax highlighting (react-syntax-highlighter)
  is kept real. The real app/component is untouched — the alias is build-only.

## Fonts — shipped woff2 (NOT runtime)

- Brand fonts are `next/font/google`: Anybody (400/600/800), Manrope (300–800),
  Geist Mono (300–700), injected as `--font-anybody/manrope/geist-mono` at runtime by
  RootLayout. Stories don't render RootLayout → vars undefined → `var(--font-anybody),
  "Anybody", …` is guaranteed-invalid (the var() poisons the whole declaration). So BOTH
  reference and DS previews fell back to system fonts (the classic [FONT_MISSING] trap).
- Resolution (chose shipped woff2 over remote @import — claude.ai/design's sandbox could
  block external font fetches and silently fall back, which compare can't catch):
  - **latin woff2 downloaded from Google Fonts (OFL)** → `.design-sync/fonts/*.woff2`
    (14 files, one per weight) + `brand-faces.css` (@font-face). `cfg.extraFonts` ships them.
  - **`--font-*` var defs** live in `.design-sync/fonts/brand-vars.css`, imported by the
    scoped preview so they compile into the reference CSS and get scraped into
    `_ds_bundle.css` (`tokensGlob` does NOT work for a repo file — it needs a `tokensPkg`).
  - **Reference parity:** the reference loads the same fonts via a Google Fonts `@import`
    injected into `.design-sync/sb-reference/iframe.html` (re-inject after any reference
    rebuild — it's regenerated). My env has network; the DS itself ships local woff2.
  - To regenerate the woff2: re-run the download (see git history / the brand-faces.css
    header). brand-faces.css urls are `./<Family>-<weight>.woff2`.

## CRITICAL: complete CSS — the storybook scrape is incomplete

- **The scoped storybook build's Tailwind v4 under-generates utilities.** Its extracted
  CSS (`sb-reference/assets/iframe-*.css`, ~40KB) is MISSING most component utilities —
  no `@theme` colors (`--color-cyan`), no `bg-cyan`/`opacity-0`/`z-[150]`/`bg-bg-raised`,
  etc. (`@source` in a preview-imported CSS did NOT fix it — leave it out). This made the
  default `[CSS_FROM_STORYBOOK]` scrape ship a broken stylesheet: ModelSelector's closed
  dropdown showed (no `opacity-0`), and the primary `bg-cyan` button fell back to a white
  default box.
- **DS fix — compile the complete CSS ourselves and feed it as `cfg.cssEntry`:**
  `npx @tailwindcss/cli -i .design-sync/styles-input.css -o .design-sync/full-styles.css`
  (this is `cfg.buildCmd`; `styles-input.css` = `@import globals.css` + `@import brand-vars.css`).
  The CLI auto-scans the whole repo → complete utilities + `@theme` colors + the preserved
  CSS + brand-vars (body-dark + font vars). `full-styles.css` (~340KB) is gitignored and
  regenerated by `buildCmd`. **Re-sync MUST run `buildCmd` before `package-build`.**
- **Reference fix — the storybook reference is an unreliable oracle until patched.** Both
  the DS and the reference must use the SAME complete CSS or grading is invalid. After
  every reference (`sb-reference`) build, inject the complete CSS into `iframe.html`:
  `cp .design-sync/full-styles.css .design-sync/sb-reference/ds-full-styles.css` then add
  `<link rel="stylesheet" href="./ds-full-styles.css">` before `</head>` (alongside the
  font `@import`). Without this the reference renders e.g. white primary buttons and every
  utility-heavy component grades as a false mismatch. **This injection is wiped by a
  reference rebuild — re-apply it on every re-sync that rebuilds the reference.**

## Decorators — TooltipProvider dropped

- The real `.storybook/preview.tsx` decorator renders `<TooltipProvider/>`, which
  unconditionally `createPortal`s a `position:fixed` node to `document.body`. In the DS
  grid card that escapes every cell → `[GRID_OVERFLOW] escape` on ALL 22 (and made
  ConfirmDialog read as rootEmpty). The scoped preview drops it (no component needs it for
  static render; none use react-query either, but QueryClientProvider is kept as harmless
  safety). Reference + DS use the same scoped preview, so they stay matched.

## cfg.overrides (cardMode) — genuine overlays/wide

- single (overlay/portal): BackendToggle, ConfirmDialog, ModelSelector, ReasoningLevelSelector.
- column (wider than a grid cell): ContextFillIndicator, IconButton, SectionHeader, Tabs.

## Target project

- Re-adopted the pre-existing **hand-built** "Command Center Design System"
  (ed3a3cc5-4519-...-> actually ed3a3cc5-6a74-4d4a-819f-db4d5b29b1c4) on Alex's explicit
  instruction (2026-06-20). It was NOT a sync artifact (hand-authored `ui_kits/`,
  `preview/`, `handoff/`, `screenshots/`). First atomic upload **replaces** it
  (reconciliation deletes wipe the old files). Non-empty target → atomic upload path;
  no anchor → full verify.

## Owned previews (overlay transform-wrapper pattern)

- `.design-sync/previews/{MergeToast,ModalShell,ConfirmDialog}.tsx` are owned. Each is a
  `position:fixed` overlay (toast/modal); the single-mode card's containment box has ~0
  height so the fixed element resolves against the viewport and clips. The owned preview
  wraps each story in `{position:relative;transform:translateZ(0);width:100%;minHeight:N}`
  (transform makes the wrapper the containing block for position:fixed). minHeight by size:
  toast ~140, modal ~360. Re-derive from `compose()` if a story set changes.
- NOT every overlay needs it: CardContextMenu's portal menu lands contained without a wrapper.
  ModelSelector/ReasoningLevelSelector/BranchSelector dropdowns render correctly (closed pill
  or contained list) on the complete CSS — no wrapper needed.
- **ConfirmDialog "Closed" story** (`components-confirmdialog--closed`, open:false) renders
  nothing on both sides → compare flags `sb-error`. It's skipped via
  `cfg.overrides.ConfirmDialog.skip` so it doesn't churn ConfirmDialog's grade on full recapture.

## STORY_CAP (known)

- compare defaults to `--max-stories 6`. ContextFillIndicator (9 stories) and
  ReasoningLevelSelector (13) exceed it. The captured 6 graded match; the tails were captured
  + graded with `--max-stories 9/13`. A capped match is verified-by-upload in full, so future
  syncs need no special handling unless a tail story gains a distinct variant.

## Known warnings (triaged — not new on re-sync)

- `[TOKENS_MISSING] --text-muted, --bg-secondary, --border-accent` — referenced in the
  scraped CSS but NOT used by any of the 22 components. Harmless.
- `[CSS_ASSETS] %23n` — one relative `url(#n)` (an SVG filter fragment ref) in the scraped
  CSS; resolves at render, not an asset 404. Harmless.

## Re-sync risks (watch-list for the next sync)

- **Two manual reference patches** are wiped by any `sb-reference` rebuild and MUST be re-applied
  (the driver does NOT do them): (1) `cp .design-sync/full-styles.css .design-sync/sb-reference/ds-full-styles.css`
  + inject `<link rel="stylesheet" href="./ds-full-styles.css">` into `iframe.html`; (2) inject the
  Google Fonts `@import` `<style>` into `iframe.html`. Without (1) the reference renders utility-heavy
  components wrong (false mismatches); without (2) the reference renders system fonts. See the
  "CRITICAL: complete CSS" section.
- **`buildCmd` must run before `package-build` on every re-sync** to regenerate `full-styles.css`
  (cfg.cssEntry). The driver does not auto-run it. Stale `full-styles.css` → wrong/old CSS shipped.
- **Brand fonts** are downloaded woff2 (committed in `.design-sync/fonts/`). If RootLayout's next/font
  weights/families change, re-download (the download script is in git history / the brand-faces.css header).
- **Mermaid stub** (`.design-sync/stubs/mermaid.ts`): mermaid code blocks render a placeholder by design
  (size cap). If `MermaidDiagram`'s mermaid API surface changes (it uses `.initialize`/`.render`), update the stub.
- **Owned previews** (MergeToast/ModalShell/ConfirmDialog) mirror their story `compose()` output + a
  transform-wrapper. If those stories' exports change, re-derive from the regenerated cache twin.
- **ConfirmDialog skip** is pinned to story id `components-confirmdialog--closed`; if the story is renamed, update it.
- **Storybook Tailwind under-scan** is a toolchain assumption — a future Tailwind/Storybook upgrade may fix
  content scanning, making the full-styles.css workaround unnecessary (harmless to keep).
- **guidelines/** currently includes CC dev docs (logging, project-configuration, composable-workflow-primitives,
  ai-validation-output) via the default `guidelinesGlob` — only `tailwind-conventions.md` is design-relevant.
  Consider setting `cfg.guidelinesGlob` to a design-only path on a future sync.
