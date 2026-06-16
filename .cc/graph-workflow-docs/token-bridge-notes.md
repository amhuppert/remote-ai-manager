# Token bridge — notes for downstream contexts

Committed by the token-bridge context (tasks 2.x–3.x). What the primitives,
pilot, and Stage B feature-wave contexts need to know about the `@theme` surface.

## Key docs (read these first)

- **`docs/reports/theme-token-matrix.md`** — the canonical token namespace
  matrix (eleven families — incl. rainbow gradients under `--background-image-*`),
  the z-index tier scale with literal→tier mapping,
  the frozen breakpoint set, and the tokenized-vs-bespoke animation list. **Read
  before authoring utilities/primitives against CC tokens or migrating any slice
  that uses z-index / breakpoints / animations.**
- **`src/features/_root/styles/theme.css`** — the surface itself.
- **`src/lib/shared/theme-surface.test.ts`** — the namespace/ordering/enumeration
  contract. Extend it when you add a token family.
- **`src/lib/shared/design-system-guarantees.test.ts`** — re-homed WCAG contrast
  + font-floor guarantees (assert against the token surface).

## What was wired (Stage A token bridge)

- **Alias lane** (aliased 1:1 over `tokens.css`, legacy names untouched):
  backgrounds → `--color-bg-*`, borders → `--color-border-*`, accents (incl.
  rgba glows) → `--color-*`, text colors → `--color-text-*` (NEVER `--text-*`,
  which Tailwind reads as font-size), spacing → `--spacing-*`, radii →
  `--radius-*` (**`@theme inline`** — name collision), fonts → `--font-*`
  (**`@theme inline`**), sizing floors → `--cc-size-floor-*` (deliberate
  non-font-size namespace; no utilities; legibility-floor guarantee only).
- **Extract lane**: z-index tiers → `--z-index-*` (the real v4 z-index
  namespace; the design's `--z-*` generates nothing) → `z-*` utilities;
  breakpoints → `--breakpoint-*` + explicit desktop-first `@custom-variant max-*`
  over inclusive `@media (max-width: Npx)` (NOT inverted, NOT Tailwind's
  exclusive auto `max-*`); animations → `--animate-*` for the three shared
  keyframes only (`pulse-dot`, `fade-in`, `bulk-float-in`).

## Gotchas / decisions that bind Stage B

- **Inert, not migrated.** No legacy literal/keyframe/token was rewritten or
  deleted. The surface only makes utilities available. Stage B repoints legacy
  `z-index:`/`@media`/duplicate-keyframe sites onto these tokens.
- **`@theme inline` for radii/fonts** because legacy `--radius-*`/`--font-*`
  names collide with the Tailwind namespace (a non-inline alias self-references).
- **Animations deduped on the token surface only.** `pulse-dot` /
  `bulk-float-in` each still have two legacy `@keyframes` (one in a feature/
  preserved file); collapsing them is deferred to Stage B because Stage A may not
  delete feature CSS. See the matrix's dedup note.
- **Sizing floors generate no utilities** by design — they are minimums, not a
  scale. Don't try to make `min-w-*`/`text-*` utilities from them.
