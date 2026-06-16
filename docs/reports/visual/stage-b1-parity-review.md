# Stage B-1 Tailwind migration — parity review artifact

**Purpose:** single review surface for the five parallel Stage B-1 feature-wave
migrations (workflows-catalog, config-editor, composer, cockpit, spawn-card).
This is the human visual sign-off gate: the workflow pauses here until a reviewer
confirms zero visual change across all five surfaces. Migration goal = **ZERO
visual change** (Chromatic deferred → parity is human-judged).

All before/after captures use the conventions-doc fixed viewports
(`docs/tailwind-conventions.md` §4.3 / "Fixed viewport dimensions"):

- **Desktop:** 1440 × 900
- **Mobile:** 390 × 844

`before-*` = legacy CSS rendering (the migration stashed/reverted on this
worktree, then restored); `after-*` = the migrated build (Tailwind utilities +
shared `src/components/ui` primitives + any wave-local utilities). Each wave
captured both from the same dev server / Storybook in its own worktree.

---

## How to review

For each surface below, open the linked `before-*` / `after-*` pair at both
breakpoints and confirm there is no perceptible difference. Pairs flagged
**IDENTICAL** are byte-for-byte equal PNGs (strongest possible parity proof — no
review needed beyond a spot check). Pairs flagged **DIFFERS** are not byte-equal
and need a human eye; a byte difference is not necessarily a visual regression
(sub-pixel anti-aliasing, PNG-encoding noise, or dynamic on-screen content such
as timestamps/relative dates all produce byte deltas at pixel parity).

---

## 1. workflows-catalog — `docs/reports/visual/workflows-catalog/`

Surfaces: `/workflows` index grid + `/workflows/conversation` machine canvas/rail.
Wave parity note: [`workflows-catalog/README.md`](./workflows-catalog/README.md).

| Pair | Desktop | Mobile |
|---|---|---|
| index | `before-index-desktop.png` / `after-index-desktop.png` — **IDENTICAL** | `before-index-mobile.png` / `after-index-mobile.png` — DIFFERS |
| detail (canvas+rail) | `before-detail-desktop.png` / `after-detail-desktop.png` — DIFFERS | `before-detail-mobile.png` / `after-detail-mobile.png` — DIFFERS |

**Residual / intentionally retained:**
- `workflows-catalog.css` keeps **3 selectors** (floor 0): the detail-page main
  grid rules `.app[data-page="workflows"][data-page-variant="detail"] .main` and
  `.workflow-detail-main`. The shell `.main` is un-migratable here — an unlayered
  selector wins the cascade over `@layer utilities`, so it stays as a residual
  (per the catalog wave's findings).
- SVG `<marker>` IDs `mc-arrow` / `mc-arrow-selected` retained in `MachineCanvas.tsx`
  (referenced by `url(#mc-arrow…)` from edges — these are element IDs, not classes).
- Wave-local utilities: page-header / title / subtitle text recipes and the
  `stagger-in` entry keyframe (kept wave-local, not promoted to a primitive).
- Mobile tab parity uses a wave-local `PanelTab` (the shared `Tabs` primitive
  can't carry the mobile sizing overrides) — shared `cc-tab*` recipes in
  globals.css left untouched.

## 2. config-editor — `docs/reports/visual/config/`

Surfaces: settings page sections (general, backends, capabilities, limits, workflow).

| Pair | Desktop | Mobile |
|---|---|---|
| general | `before-general-desktop.png` / `after-general-desktop.png` — DIFFERS | `before-general-mobile.png` / `after-general-mobile.png` — DIFFERS |
| backends | `before-backends-desktop.png` / `after-backends-desktop.png` — DIFFERS | — |
| capabilities | `before-capabilities-desktop.png` / `after-capabilities-desktop.png` — DIFFERS | — |
| limits | `before-limits-desktop.png` / `after-limits-desktop.png` — DIFFERS | — |
| workflow | `before-workflow-desktop.png` / `after-workflow-desktop.png` — DIFFERS | `before-workflow-mobile.png` / `after-workflow-mobile.png` — DIFFERS |

> ⚠️ **Reviewer attention:** every config pair differs at the byte level (size
> deltas are small, ≈0.5–2%). The settings page renders live config values, so
> some delta is expected from dynamic content, but config is the one surface with
> no byte-identical pair — please confirm visual parity here most carefully.

**Residual / intentionally retained:** none — `config-editor.css` fully migrated
to **0 selectors** (floor 0); the stylesheet is empty.

## 3. composer — `docs/reports/visual/composer/`

Surfaces: unified composer (first-run), mode chip (all modes), suggestions
(command + filter dropdowns).

| Pair | Desktop | Mobile |
|---|---|---|
| unified composer (first run) | `before-unifiedcomposer-firstrun-desktop.png` / `after-…` — **IDENTICAL** | `before-unifiedcomposer-firstrun-mobile.png` / `after-…` — **IDENTICAL** |
| mode chip (all) | `before-modechip-all-desktop.png` / `after-…` — **IDENTICAL** | `before-modechip-all-mobile.png` / `after-…` — **IDENTICAL** |
| suggestions (command) | `before-suggestions-command-desktop.png` / `after-…` — **IDENTICAL** | `before-suggestions-command-mobile.png` / `after-…` — **IDENTICAL** |
| suggestions (filter) | `before-suggestions-filter-desktop.png` / `after-…` — **IDENTICAL** | `before-suggestions-filter-mobile.png` / `after-…` — **IDENTICAL** |

**All eight pairs byte-identical — strongest parity proof.**

**Residual / intentionally retained:** none — `composer.css` fully migrated to
**0 selectors** (floor 0). One inline `rgba(0,0,0,0.35)` dropdown shadow literal
remains in `ComposerSuggestions.tsx` for exact parity (the canonical dropdown
shadow has no design token yet). Token extraction (`--cc-shadow-dropdown`) +
allowlist registration are deferred to Stage B-2 (see the integration follow-ups
shared doc).

## 4. cockpit — `docs/reports/visual/cockpit/`

Surfaces: project cockpit (conversations view), sessions panel, sessions filter
popover, diff slide-over.

| Pair | Desktop | Mobile |
|---|---|---|
| cockpit (conversations) | `cockpit-before-desktop-conversations.png` / `cockpit-after-desktop-conversations.png` — **IDENTICAL** | `cockpit-before-mobile-conversations.png` / `cockpit-after-mobile-conversations.png` — **IDENTICAL** |
| sessions panel | `sessions-before-desktop.png` / `sessions-after-desktop.png` — **IDENTICAL** | `sessions-before-mobile.png` / `sessions-after-mobile.png` — **IDENTICAL** |
| filter popover | `filter-before-desktop.png` / `filter-after-desktop.png` — **IDENTICAL** | `filter-before-mobile.png` / `filter-after-mobile.png` — **IDENTICAL** |
| diff slide-over | `diff-before-desktop.png` / `diff-after-desktop.png` — **IDENTICAL** | `diff-before-mobile.png` / `diff-after-mobile.png` — **IDENTICAL** |

**All paired captures byte-identical.** (`cockpit-after-desktop.png` is an extra
non-conversations desktop capture with no before pair — informational only.)

**Residual / intentionally retained:**
- `cockpit.css` keeps **8 selectors** (floor 6): the read-only diff slide-over
  portal positioning (`.plc-diff-overlay`, `.plc-diff-slideover`), its entry
  keyframes (`plc-rise-fade`, `plc-diff-scrim-in`, `plc-diff-slide-in`), the
  `prefers-reduced-motion` block, and the mobile full-width override. The
  `plc-rise-fade` keyframe is referenced from JSX via `animate-[plc-rise-fade_…]`
  and the file is imported by `ProjectCockpit.tsx` — confirmed live.
- `plc-sessions-panel` / `plc-conversation-workspace` / `plc-conversation-list`
  are element `id=` / `aria-controls=` values (ARIA wiring), not styling classes.
- Inline `rgba(0,0,0,0.35)` filter-menu shadow in `SessionsFilterPopover.tsx`
  retained for parity (no `--cc-shadow-menu` token yet).
- **Two `layoutClassName` contract exceptions** (charter-sanctioned: rank-1
  visual parity chosen over the rank-2 layout-only `layoutClassName` rule, with
  the appearance reattached via `layoutClassName` pending a shared-primitive
  capability — both are recorded in-code as CONFLICT and tracked by the added
  remediation task `remediate-cockpit-layoutclassname-conflicts`):
  - **View-switch / mobile-switch tabs** (`ProjectCockpit.tsx:108`,
    `TAB_FILL_LAYOUT`) pass `max-768:justify-center` + `max-768:min-h-[36px]`
    through `layoutClassName` because the shared `Tabs` primitive lacks a
    fill/touch mode (the geometry tokens `grow shrink basis-0` are allowlist-clean).
  - **Filter Button** (`SessionsFilterPopover.tsx:40`, `FILTER_BTN_LAYOUT`) passes
    `max-768:min-h-[44px]` + `max-768:px-[16px]` (padding) through `layoutClassName`
    to reattach the global `.btn-sm` mobile 44px touch target, which the shared
    `Button` primitive does not bake in (unlike `IconButton`). Without it the
    button renders 27px tall at 390px and shifts the popover.
  These tokens are outside the `docs/tailwind-conventions.md` §2 layout-only
  allowlist; resolving them (Tabs fill-mode + Button mobile touch sizing) needs
  shared-primitive edits deferred to Stage B-2, which also blocks cockpit's
  eslint guardrail allowlist registration.

## 5. spawn-card — `docs/reports/visual/spawn-card/`

Surfaces: spawn-card proposal (multi-session, edit form, invalid states).
Wave parity note: [`spawn-card/README.md`](./spawn-card/README.md).

| Pair | Desktop | Mobile |
|---|---|---|
| multi | `before-multi-desktop.png` / `after-multi-desktop.png` — **IDENTICAL** | `before-multi-mobile.png` / `after-multi-mobile.png` — DIFFERS |
| edit | `before-edit-desktop.png` / `after-edit-desktop.png` — **IDENTICAL** | `before-edit-mobile.png` / `after-edit-mobile.png` — DIFFERS |
| invalid | `before-invalid-desktop.png` / `after-invalid-desktop.png` — **IDENTICAL** | `before-invalid-mobile.png` / `after-invalid-mobile.png` — **IDENTICAL** |

The wave README records identical cropped card dimensions for all six pairs; the
two mobile DIFFERS are sub-perceptible encoding noise on the action-row buttons.

**Residual / intentionally retained:** none — `spawn-card.css` fully migrated to
**0 selectors** (floor 0). `cc-meta-label` kept as a wave-local utility. The
mobile 44px touch target is supplied by the action-row's own flex box
(`max-768:min-h-[44px] max-768:items-stretch`) because a primitive's box height
is not reattachable through `layoutClassName`.

---

## Cross-cutting verification (all five surfaces)

- **No shared leaf-recipe rule deleted.** `globals.css` (1150 selectors) and
  `project-detail.css` (184) are unchanged from the committed baseline — the
  ratchet reports both as `ok` (no decrease). Shared recipes (`cc-tab*`,
  `cc-badge*`, `btn-*`, `empty-*`, `form-*`, etc.) are still consumed by
  non-migrated surfaces and were left in place.
- **No mixed ownership.** No migrated element carries a legacy BEM class +
  utility on the same element (incl. the descendant-selector case). Every
  surviving legacy-prefix reference in migrated TSX is an import path, an
  element/ARIA id, an SVG `<marker>` id, a CSS custom-property name, the preserved
  `plc-rise-fade` keyframe reference, or an explanatory comment — verified by grep.
- **Shared components rendered unchanged** (ModelSelector, ReasoningLevelSelector,
  BackendToggle, Topbar, ConfirmDialog, MessageRow / Virtuoso family,
  CardContextMenu) — their migration is a later serial wave.
- **Gates green:** `bun run build` ✓, `bun run build-storybook` ✓, `bun run lint`
  ✓, `bun run typecheck` ✓, `css:progress --check` ✓ (against the regenerated
  baseline), full unit suite ✓.

## Deferred to Stage B-2 (out of scope for this workflow)

Per the charter non-goals (no token add/remove in `tokens.css`/`theme.css`, no
alias-bridge removal), these are NOT done here and are carried forward:

1. Register the five migrated surfaces in the guardrail allowlists
   (`MIGRATED_UTILITY_FIRST` in `eslint.config.mjs`, `.prettierrc` class-sort
   overrides, the `UTILITY_FIRST_PATHS` collision test) so the Tailwind guardrail
   rules actually enforce on them. Composer and cockpit cannot be cleanly
   allowlisted until (2)/(3) land — `no-hardcoded-color` would trip on their
   intentional inline parity shadows.
2. Extract `--cc-shadow-dropdown` (composer suggestions) and `--cc-shadow-menu`
   (cockpit filter popover) tokens and swap the inline `rgba(0,0,0,0.35)` literals.
3. Resolve cockpit's two `layoutClassName` appearance exceptions (tracked by the
   added remediation task `remediate-cockpit-layoutclassname-conflicts`): add a
   fill / touch mode to the shared `Tabs` primitive (view-switch / mobile-switch
   tabs) and bake the global `.btn-sm` mobile touch sizing into the shared
   `Button` primitive (filter Button), then drop the appearance tokens from
   `TAB_FILL_LAYOUT` / `FILTER_BTN_LAYOUT`. Both edit `src/components/ui`
   primitives, which is why they are deferred and why cockpit cannot yet pass
   `no-appearance-in-layout-classname` for allowlist registration.
