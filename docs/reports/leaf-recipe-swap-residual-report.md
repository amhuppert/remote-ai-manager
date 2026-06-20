# Leaf-recipe swap — honest residual report (final verification)

What the leaf-recipe swap wave **deleted**, what it **left behind**, and **why** —
the complete, honest end-state. Companion to `leaf-recipe-swap-parity-review.md`
(byte-identical parity proof) and `.cc/graph-workflow-docs/integration-retained-recipes.md`
(the delete-gate ledger with file:line remediation items).

> **Headline.** The wave is **consumer-gated complete, not literal zero-recipe.** Every
> leaf recipe whose consumers could be swapped byte-for-byte within slice ownership was
> swapped and then **deleted**. Five families retain ≥1 consumer that could not be
> re-homed without a visual regression; per the charter's consumer-gated rule (and this
> context's AC) those are **kept whole** and handed to a named remediation wave rather
> than force-deleted. This is the expected outcome, not a failure — the AC explicitly
> anticipates escape-hatched consumers remaining.

## DELETED — gone with a final zero-consumer grep (✓)

Re-grepped across `src/` (`*.tsx`/`*.ts`, excluding `*.test.*` / `*.stories.*`, comment
lines stripped, cross-checked against `className=`/`cn(` contexts): **zero** prod
consumers for every family below.

| Family | Owner file | Was consumed by (now swapped) |
|---|---|---|
| `.btn-icon` | globals.css | (child-icon helper) `text-[1em]` inline |
| `.btn-toggle` / `:hover` / `.active` / `.active:hover` | globals.css | ProjectsIndexPage, ConversationList → inline utilities |
| `.empty-state` / `-icon` / `-title` / `-desc` | globals.css | 17 consumers → `ui/EmptyState` |
| `.cc-section-header` / `-chevron` / `-label` / `-count` / `-actions` | globals.css | SessionGitPanel → `ui/SectionHeader` |
| `.form-group` / `-label` / `-input` (×2 defs) / `-hint` / `-error` | globals.css | CreateSessionModal → `ui/FormField` + inline |
| `.cc-toast` | globals.css **and** project-detail.css | Toast.tsx → inline utilities |
| `.cc-primary` / `.plus` / `-kbd` (+ mobile) | project-detail.css | ProjectDetailView → inline utilities |
| `.cc-ibtn` (+ `:hover`/` svg`/`.active`/mobile) | project-detail.css | ProjectDetailView → inline utilities |
| `.cc-checkbox` (+ hover/checked/indeterminate) | project-detail.css | CCCheckbox.tsx → inline utilities |

Counts: globals.css **212 → 185** tracked selectors, project-detail.css **24 → 3**
(both above their preserved floors; `css:progress --check` green, baseline committed).
project-detail.css now holds only the `.main` page override, `.project-detail-shell`,
and the preserved `kebab-in` keyframe.

## RETAINED — leaf recipes still present, and exactly why

### A. Escape-hatched recipe families (≥1 consumer that can't be swapped byte-for-byte)

Per the family-level gating rule, a family with any live consumer is kept **whole**
(including its already-dead sub-members) for a single future remediation pass. Each is
parked under a slice's ratified ESCAPE HATCH. **Verified: these have exactly the
documented consumers below — no unexpected new consumers.**

| Family (globals.css) | Live consumer(s) | Why not swapped | Remediation |
|---|---|---|---|
| `.btn*` (`-primary/-danger/-success/-ghost/-sm` + mobile) | SessionGitPanel.tsx:157 (View-Diff `<Link>`), MobileInfoPanel.tsx:161, AgentCapabilityPanel.tsx:502 (Reset, `disabled:opacity-45`) | `<Link>` anchor (Button renders `<button>`); Button has no disabled-fade variant | Extend `Button` with a disabled variant + `as`/anchor option (or inline-utility the 3), then delete `.btn*` |
| `.btn-icon-only*` | ConversationPanel.tsx:177 (copy-markdown) | cross-owned `conversation.css` 28px scoped rule (also used by ConversationSidebar/List); `IconButton` is 30px → +2px regress | Migrate the conversation.css 28px consumers as a unit, then delete |
| `.cc-tabs` / `.cc-tab` / `.cc-tab-count` | MobileBottomBar.tsx:45,49 | `.mobile-bottom-bar .cc-tabs/.cc-tab` descendant overrides not re-homable in-slice | Re-home the mobile-bottom-bar overrides with the swap, then delete (`.cc-tab-count` already dead, kept with family) |
| `.status-dot*` (`.warning/.amber/.cyan`) | ConversationList.tsx:295, MobileInfoPanel.tsx:112, ProjectDetailView.tsx:269 | mobile topbar enlarges the dot to **8px**; `StatusDot` fixed 7px, height not in `layoutClassName` allowlist; `.topbar-status-*` is topbar-owned | Topbar/right-pane context re-homes `.status-indicator` + its mobile 8px descendant rules as a unit, then delete |
| `.modal-overlay` / `.modal` / `.modal-title` / `.modal-actions` | CreateSessionModal.tsx:346,347 | mobile bottom-sheet (overlay `align-items:flex-end` + sheet card + `slideUpSheet`); `ModalShell` exposes no overlay className and `layoutClassName` is layout-only | Add a `ModalShell` mobile-sheet variant, re-swap, then delete (`.modal-title`/`-actions` already dead, kept with family) |

These five families are tracked **above** the globals.css preserved floor (66) as the
current high-water mark, so they cannot silently regrow but the remediation wave can
still reduce them. They are NOT raised into the floor (that would forbid the swap).

### B. Deliberately retained — NOT this wave's target

| What remains | Owner | Why retained (ratified / load-bearing) |
|---|---|---|
| `.text-*` color helpers | typography.css | **Load-bearing for the collision guard** — they back the `text-*` tokens so those aren't flagged as bare-token collisions. Intentionally retained; explicitly out of scope (R9 dedup with `TypographyHelpers.stories.tsx`). |
| `@keyframes bulk-float-in`, `pulse-dot` | globals.css | Preserved animation library (§5 do-not-convert). `bulk-float-in` still referenced by the migrated toast via `--animate-bulk-float-in`. |
| `@keyframes kebab-in` | project-detail.css | Preserved animation, referenced by migrated utilities. |
| `.app[data-page…] .main` override, `.project-detail-shell` | project-detail.css | Shell-layout residual (targets a shared shell class); blocked on the shell-layout foundation migration (conventions §5.2), not a leaf recipe. |
| legacy token **names** (`--cyan`, `--text-inverse`, …) | tokens.css / theme.css | **Ratified retained** (B-final) — preserved CSS still reads them; byte-identical values. |
| Preflight **off** | — | **Ratified** — `reset.css` is the canonical base reset (Option A). |

### C. Parity-adjacent caveat (rendered output identical; follow-up is tooling-only)

| Item | Detail | Remediation |
|---|---|---|
| Toast surface literal | `src/components/Toast.tsx` uses `bg-[rgba(20,25,35,0.96)]` — no design token exists for this value, so Toast.tsx is intentionally kept OUT of the eslint `MIGRATED_UTILITY_FIRST` allowlist (else `no-hardcoded-color` trips). The rendered declaration is byte-identical to legacy `.cc-toast`; the gap is lint coverage, not visual parity. | Mint a `--cc-*` token for `rgba(20,25,35,0.96)` in tokens.css, swap the literal to `bg-[var(--cc-…)]`, then add Toast.tsx to `eslint.config.mjs` + `.prettierrc`. |

## Remediation backlog (for a future leaf-recipe remediation wave)

All items are durably tracked; none requires action in this verification context (which
must not migrate a new surface or delete a recipe). The authoritative file:line work
items live in `.cc/graph-workflow-docs/integration-retained-recipes.md`. Consolidated:

1. **`Button` primitive**: add a disabled-state variant + an `as`/anchor option → swap
   SessionGitPanel View-Diff Link, MobileInfoPanel control, AgentCapabilityPanel Reset
   → delete `.btn*`.
2. **`.btn-icon-only*`**: migrate the conversation.css 28px consumers (ConversationPanel
   + ConversationSidebar + ConversationList) as a unit → delete.
3. **`.cc-tabs`/`.cc-tab*`**: re-home the `.mobile-bottom-bar` descendant overrides with
   the MobileBottomBar swap → delete.
4. **`.status-dot*`**: topbar/right-pane context re-homes `.status-indicator` + its
   mobile 8px descendant rules (+ MobileInfoPanel/ProjectDetailView dots) as a unit →
   delete.
5. **`ModalShell` mobile-sheet variant**: add overlay-align + sheet card + `slideUpSheet`
   → re-swap CreateSessionModal → delete `.modal*`.
6. **Toast token**: mint `--cc-*` for `rgba(20,25,35,0.96)`, swap literal, allowlist
   Toast.tsx (eslint + .prettierrc).
7. **typography.css `.text-*`**: R9 dedup (retained until then — load-bearing for the
   collision guard).

## Gate evidence (this verification)

- Final zero-consumer grep across `src/` — ✓ (deleted families: 0 consumers).
- `bun run css:inventory` regenerated (globals 233→206, project-detail 26→5 blocks;
  residual prose corrected). Retry: dropped the now-stale `canonical-primitive`
  also-contains tag from `project-detail.css` (every `.cc-*` recipe deleted; only the
  `kebab-in` keyframe remains, so the row keeps `animation`); and removed
  `project-detail.css` from the generator's explanatory sentence listing where `.cc-*`
  recipes "live appended" (now `globals.css` / `typography.css` only), then
  re-regenerated the `css-inventory.{md,json}` artifacts.
- `bun run css:progress --check` — ✓ green (426 tracked selectors, all owners at/above
  floor; baseline committed at integration).
- `bun run build` — ✓ (exit 0; production CSS emission confirmed).
- Full unit suite + `bun run build-storybook` — see complete_task summary.
