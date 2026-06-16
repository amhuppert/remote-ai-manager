# Tailwind v4 toolchain integration — notes for downstream contexts

Committed by the toolchain context (tasks 1.x). What later contexts (token bridge,
primitives, pilot) need to know.

## Key docs (read these first)

- **`docs/tailwind-conventions.md`** — the authoring conventions + per-slice
  migration protocol (class rules, `layoutClassName` allowlist, desktop-first
  `max-*` breakpoints, the 9-step slice checklist with fixed viewports
  1440×900 / 390×844, the preserved-CSS do-not-convert catalog, per-PR gates).
  **Read before migrating any slice or building primitives.**
- **`docs/reports/css-inventory.md`** — CSS ownership taxonomy + preserved-CSS
  catalog (regenerate: `bun run css:inventory`; `--check` enforces freshness).
- **`src/lib/shared/tailwind-cascade-order.test.ts`** — the cascade-order backstop.

## What was wired

- **Deps** (devDependencies): `tailwindcss@^4.3.1`, `@tailwindcss/postcss@^4.3.1`,
  `@tailwindcss/vite@^4.3.1`. (`clsx` is NOT yet installed — the primitives
  context installs it for `cn()`.)
- **`postcss.config.mjs`** (new) — `{ plugins: { "@tailwindcss/postcss": {} } }`.
  Turbopack (Next 16 dev + build) auto-detects it.
- **`src/app/globals.css`** — at the top, before the legacy `@import`s:
  ```css
  @layer theme, base, components, utilities;
  @import "tailwindcss/theme.css" layer(theme);
  @import "tailwindcss/utilities.css" layer(utilities);
  @import "../features/_root/styles/theme.css";
  ```
  Preflight is intentionally OMITTED (no `tailwindcss/preflight.css layer(base)`),
  so CC's `reset.css` remains the single base reset and legacy UNLAYERED CSS wins
  the cascade over Tailwind's LAYERED utilities (the no-mixed-ownership backstop).
- **`src/features/_root/styles/theme.css`** (new) — the `@theme` token surface.
  Currently MINIMAL: a single `--color-cc-sanity` sanity token + a
  `@source inline("bg-cc-sanity")` spike safelist. **The token-bridge context
  REPLACES this file wholesale** with the full alias + extract lanes; drop the
  sanity token and the safelist then. Text colors go under `--color-text-*`, never
  `--text-*` (Tailwind reads `--text-*` as font-size).
- **`.storybook/main.ts`** `viteFinal` — adds `@tailwindcss/vite` (dynamic import)
  so Storybook gets the same theme + utilities as the Next app.

## Storybook logging stub (IMPORTANT — pre-existing blocker, not Tailwind)

`build-storybook` was **already broken on main** (it is not in the pre-merge gate,
so it went unnoticed): the `@/lib/logging` barrel re-exports server-only code
(`AsyncLocalStorage` via `node:async_hooks`, file-system writers, the config
loader), so any story rendering a component that calls `createLogger()` pulls that
server subtree into the browser bundle and Rollup fails.

Fix (Storybook-only, in `.storybook/main.ts` `viteFinal`): alias the `@/lib/logging`
barrel to a no-op browser stub `.storybook/logging-stub.mjs`. Exact-match regex
(`/^@\/lib\/logging$/`) so deep paths (`@/lib/logging/logger`) still resolve to the
real `@`→src alias. Production, `next build`, and `tsc` use the real module
unchanged. **If you add stories or run `build-storybook`, this stub is why it
passes — keep it.** If a story needs real logging behavior (it shouldn't), extend
the stub rather than removing the alias.

## Verification done (all green)

- `bun run build` (next) ✓ and `bun run build-storybook` ✓.
- Sample utility identical in both hosts: `.flex{display:flex}` and the CC `@theme`
  utility `.bg-cc-sanity{background-color:var(--color-cc-sanity)}` are byte-identical
  in the Next chunk and the Storybook bundle; `--color-cc-sanity:#00e5ff` matches.
- Preflight OFF in both builds (no `::file-selector-button` / `text-size-adjust`);
  CC atmospherics intact (`feTurbulence` noise overlay, `box-sizing` reset present).

## Utility-collision guard (visual inertness)

Tailwind auto-scans the codebase and emits a utility for every token it sees,
**plus static utilities it always emits** (e.g. `sr-only`). If an element carries
a bare className that matches such a utility AND has no legacy CSS rule, the
utility starts styling it — a visual change. The cascade backstop does NOT help
here (it only protects classNames that HAVE a legacy unlayered rule).

- One real collision existed: `<label className="sr-only">` in
  `CollabOpenConflictsCard.tsx` had no `.sr-only` rule, so it rendered visibly;
  Tailwind's static `.sr-only` would hide it. Fixed by renaming the className to a
  non-utility BEM name (`collab-open-conflicts-card-answer-label`), preserving the
  visible baseline. (Config fixes don't work: `source(none)` emits invalid
  `@media layer(utilities)` and breaks `next build`; `sr-only` is static so
  `@source not` can't remove it. The element must simply not use a utility name.)
- **`src/lib/shared/tailwind-utility-collisions.test.ts`** asserts ZERO such
  collisions across the whole codebase (scanned + static utilities). It would have
  caught `sr-only`. When migrating a slice, if a bare className collides with a
  utility name, rename it to a BEM name in the same change.

## Gotchas

- Tailwind v4 only emits utilities for tokens it finds while scanning source
  (plus a few always-on static utilities like `sr-only`), so a utility absent from
  a build (`.p-4`) just means nothing references it — not a wiring failure.
- The generated reports `docs/reports/css-inventory.{md,json}` are produced by
  `scripts/css-inventory.ts` (`bun run css:inventory`); `--check` enforces freshness.
  `theme.css` is owner #30 in that catalog.
