# Leaf-recipe swap — parity review (final verification)

Final verification artifact for the Tailwind leaf-recipe swap wave. It demonstrates
**byte-identical visual parity** for every high-risk surface the wave touched, and
records the end-state deletion / zero-consumer grep. Pair with
`leaf-recipe-swap-residual-report.md` (what remains and why) and
`.cc/graph-workflow-docs/integration-retained-recipes.md` (the delete-gate ledger).

Verified on branch `csm/migrate-to-tailwind-css-3204f2-swap-project-detail` at the
integration commit `d344ed2e` ("Tailwind leaf-recipe cleanup: delete dead recipes,
sync guardrails, ratchet baseline").

## Verification method

A leaf-recipe → primitive/utility swap is byte-identical iff the migrated utilities
**compile to the same CSS declarations** as the legacy recipe. This is the method the
swap slices used (and which `docs/tailwind-conventions.md` + the swap-slice notes
endorse as *stronger than pixel-diffing for a class→recipe swap*): pixels can only
sample a few states, but declaration-equality proves identity across **all** states.

Because the integration commit already **deleted** the legacy recipes, a live
"before" render no longer exists in the tree without a revert; the slices captured
their before/after evidence at swap time (committed under `docs/reports/visual/<slice>/`
and recorded in the slice notes). This final pass independently re-confirms parity by:

1. **Legacy ground truth** — extracted from the pre-deletion commit `d344ed2e^`
   (`git show d344ed2e^:src/app/globals.css` / `…:project-detail.css`).
2. **Migrated declarations** — read from the current source (the inline-utility class
   strings and the `ui/` primitive recipes).
3. **Emission proof** — confirmed every geometry-critical declaration is actually
   present in the production build CSS (`.next/static/chunks/*.css` from
   `bun run build`). Tailwind silently drops invalid candidates, so confirming
   emission rules out a typo'd variant that never compiled.
4. **Token resolution** — confirmed each token utility resolves to the legacy value
   (`theme.css` `--color-*` literals == `tokens.css` legacy names, per the B-final
   alias collapse).

Per-slice byte-identical **pixel** screenshots (1440×900 + 390×844) are committed
under `docs/reports/visual/dev-server/{before,after}` and the project-detail /
cockpit / conversation-surfaces dirs; the DevServerDrawer pair is sha256-identical
(swap-shared-components-residuals.md).

---

## 1. DevServerDrawer compact (36px) buttons

Row Stop/Start buttons swapped `.btn .btn-sm` → `<Button size="sm">`; the panel needs
a **36px** mobile box (not the global 44px), re-homed onto the row's `<button>` child
via a wrapper-descendant variant (`src/components/DevServerDrawer.tsx:43`):
`max-768:[&_button]:min-h-[36px] max-768:[&_button]:px-[16px] max-768:[&_button]:py-[10px]`.

| Property | Legacy (`.btn-sm` + `@media≤768 .btn-sm`) | Migrated | Match |
|---|---|---|---|
| desktop padding | `6px 12px` | `Button size="sm"` recipe | ✓ |
| desktop font-size | `0.72rem` | `text-[0.72rem]` | ✓ |
| mobile min-height | `44px` (global) → **36px** (row override) | `max-768:[&_button]:min-h-[36px]` | ✓ |
| mobile padding | `10px 16px` | `max-768:[&_button]:px-[16px] py-[10px]` | ✓ |

Emission: `min-height:36px` present in production CSS ✓. Non-row buttons (conflict
dialog, footer) use the global `touch` 44px box. **Pixel evidence:** sha256-identical
before/after at both viewports (swap-shared-components-residuals.md §ROW trap).

---

## 2. project-detail mobile CTA + icon buttons (44px touch)

`.cc-primary` (New-Session CTA) and `.cc-ibtn` (workflow icon-link) were re-homed as
inline utilities (NOT `<Button variant="primary">` / `<IconButton variant="pill">`):
`.cc-primary` is the compact page-redesign recipe (≠ global `.btn-primary`), and the
icon control is a navigation `<Link>` (anchor) where swapping to a `<button>` would
drop native link nav. Both transcribe the recipe verbatim incl. the `@media≤768` 44px
fold. (`src/features/project-detail/ProjectDetailView.tsx` `CC_PRIMARY_CLASS` /
`CC_IBTN_LINK_CLASS`.)

`.cc-primary` (base) — every declaration:

| Legacy | Migrated | Legacy | Migrated |
|---|---|---|---|
| `display:inline-flex` | `inline-flex` | `border-radius:var(--radius-md)` | `rounded-md` |
| `align-items:center` | `items-center` | `font-family:var(--font-mono)` | `font-mono` |
| `gap:6px` | `gap-[6px]` | `font-size:0.74rem` | `text-[0.74rem]` |
| `height:30px` | `h-[30px]` | `font-weight:600` | `font-semibold` |
| `padding:0 14px` | `px-[14px] py-0` | `white-space:nowrap` | `whitespace-nowrap` |
| `background:var(--cyan)` | `bg-cyan` | `flex-shrink:0` | `shrink-0` |
| `color:var(--text-inverse)` | `text-text-inverse` | `transition:all .15s ease` | `transition-all duration-150 ease-[ease]` |
| `border:1px solid var(--cyan)` | `border border-solid border-cyan` | | |

`.cc-primary:hover` → `hover:bg-cyan-dim hover:border-cyan-dim hover:shadow-[0_0_18px_var(--color-cyan-glow-strong)]` ✓
(`--color-cyan-glow-strong` = `rgba(0,229,255,0.3)` = legacy `--cyan-glow-strong`).
`@media≤768 .cc-primary` (`align-self:center; flex:1; min-height:44px; height:44px;
padding:0 var(--space-md)`) → `max-768:self-center max-768:flex-1 max-768:min-h-[44px]
max-768:h-[44px] max-768:px-md` ✓.

`.cc-ibtn` base maps the same way (`h-[30px]`, `px-[10px] py-0`, `bg-transparent`,
`border-border-subtle`, `text-[0.72rem]`, `font-medium`, the `[&_svg]` descendant
color rules, hover, and the `@media≤768` `min-h-[44px] h-[44px] flex-1
justify-center`). Emission: `min-height:44px` present (×5) ✓.

---

## 3. Migrated checkbox — unchecked / checked / indeterminate

`.cc-checkbox` → inline utilities in `src/features/project-detail/components/CCCheckbox.tsx`
(`CHECKBOX_CLASS`), state gated on `data-checked` / `data-indeterminate`.

| Legacy `.cc-checkbox` | Migrated |
|---|---|
| `display:inline-flex` `align-items/justify-content:center` | `inline-flex items-center justify-center` |
| `width/height:16px` | `size-[16px]` |
| `border:1px solid var(--border-default)` | `border border-solid border-border-default` |
| `border-radius:3px` | `rounded-[3px]` |
| `background:var(--bg-base)` | `bg-bg-base` |
| `cursor:pointer` `flex-shrink:0` `position:relative` | `cursor-pointer shrink-0 relative` |
| `transition:all .12s ease` | `transition-all duration-[120ms] ease-[ease]` |
| `:hover {border-color:var(--cyan-dim)}` | `hover:border-cyan-dim` |
| `.checked {background/border:var(--cyan)}` | `data-[checked=true]:bg-cyan data-[checked=true]:border-cyan` |

`.checked::after` (the checkmark — an L of left+bottom borders rotated -45°):

| Legacy | Migrated |
|---|---|
| `content:""` `position:absolute` | `after:content-[''] after:absolute` |
| `width:8px; height:4px` | `after:w-[8px] after:h-[4px]` |
| `border-left:1.6px solid var(--text-inverse)` | `after:[border-left:1.6px_solid_var(--color-text-inverse)]` |
| `border-bottom:1.6px solid var(--text-inverse)` | `after:[border-bottom:1.6px_solid_var(--color-text-inverse)]` |
| `transform:rotate(-45deg) translate(0,-1px)` | `after:[transform:rotate(-45deg)_translate(0,-1px)]` |

`.indeterminate::after` (flat dash): `width:8px; height:1.6px; background:var(--text-inverse)`
→ `after:w-[8px] after:h-[1.6px] after:bg-text-inverse`. Emission: the
`border-left:1.6px solid var(--color-text-inverse)` checkmark rule is present in
production CSS ✓. `--color-text-inverse` = `#06090f` = legacy `--text-inverse`.

---

## 4. The toast

`.cc-toast` → inline utilities in `src/components/Toast.tsx` (recipe deleted from
**both** globals.css and project-detail.css).

| Legacy `.cc-toast` | Migrated |
|---|---|
| `position:fixed` | `fixed` |
| `left:50%` | `left-1/2` |
| `bottom:24px` | `bottom-[24px]` |
| `transform:translateX(-50%)` | `[transform:translateX(-50%)]` (arbitrary — not `-translate-x-1/2`, so the `bulk-float-in` keyframe's `transform` overrides cleanly without double-offset) |
| `background:rgba(20,25,35,0.96)` | `bg-[rgba(20,25,35,0.96)]` (literal — see residual report; no token yet) |
| `color:var(--text-primary)` | `text-text-primary` |
| `border:1px solid var(--cyan-dim)` | `border border-solid border-cyan-dim` |
| `border-radius:9999px` | `rounded-full` |
| `padding:10px 18px` | `px-[18px] py-[10px]` |
| `font-family:var(--font-mono)` `font-size:0.74rem` | `font-mono text-[0.74rem]` |
| `box-shadow:0 8px 24px rgba(0,0,0,0.5), 0 0 18px var(--cyan-glow)` | `shadow-[0_8px_24px_var(--cc-black-a50),0_0_18px_var(--color-cyan-glow)]` |
| `z-index:200` | `z-dropdown` (→ `--z-index-dropdown: 200`) |
| `animation:var(--animate-bulk-float-in)` | `animate-bulk-float-in` (keyframe preserved in CSS) |

`--cc-black-a50`=`rgba(0,0,0,0.5)`, `--color-cyan-glow`=`rgba(0,229,255,0.15)`=legacy
`--cyan-glow`, `--z-index-dropdown`=200. Emission: `rgba(20,25,35,.96)` present in
production CSS ✓. **Caveat (residual #1):** the surface literal has no design token,
so Toast.tsx is intentionally kept OUT of the lint allowlist — a documented
remediation item, not a parity defect (the rendered declaration is identical).

---

## 5. Migrated tab strips

The `.cc-tabs`/`.cc-tab`/`.cc-tab-count` recipe is **retained** in globals.css
(MobileBottomBar still consumes it), so the `ui/Tabs` primitive is verified directly
against the **live** recipe.

| Legacy `.cc-tabs` / `.cc-tab` | `ui/Tabs` `tabsBase` / `tabBase` |
|---|---|
| tabs `display:flex; gap:2px; padding:3px` | `flex gap-[2px] p-[3px]` |
| tabs `background:var(--bg-surface)` | `bg-bg-surface` |
| tabs `border:1px solid var(--border-default); border-radius:var(--radius-md)` | `border border-solid border-border-default rounded-md` |
| tab `display:flex; align-items:center; gap:4px` | `flex items-center gap-[4px]` |
| tab `padding:5px 10px; min-height:28px` | `px-[10px] py-[5px] min-h-[28px]` |
| tab `border:none; border-radius:var(--radius-sm); background:transparent` | `border-0 rounded-sm bg-transparent` |
| tab `font-mono 0.72rem 500 uppercase tracking .05em` | `font-mono text-[0.72rem] font-medium uppercase tracking-[0.05em]` |
| tab active `bg:var(--cyan); color:var(--text-inverse)` | `data-[active=true]:bg-cyan data-[active=true]:text-text-inverse` |
| tab hover `bg:var(--bg-hover); color:var(--text-primary)` | `data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary` |

**Consumers using the shared primitive** (verified): SessionGitPanel, DiffPanel,
RightPane, SpecBrowser, ProjectCockpit (×2). **MachineDetail** uses a deliberate
**wave-local** `PanelTab` (utilities), NOT the shared `Tab`: its mobile spine needs
per-tab `justify-center` + 44px `min-height` + `0.78rem` font (legacy
`.workflow-mobile-tabs .cc-tab` overrides) that the appearance-locked `Tab` cannot
carry — documented in-file (`MachineDetail.tsx:161-167`) and parity-verified in the
B-1 workflows-catalog wave.

**Sanctioned deviation:** `TabCount` drops the legacy `.cc-tab-count {opacity:0.85}`
fade; the inactive count inherits the tab color instead (the **ratified B-3 a11y
contrast fix** — the one approved visual change, baked into the primitive). SpecBrowser's
Features-tab count is therefore full-opacity color-inheriting, by design.

---

## 6. Representative EmptyState

`.empty-state*` → `ui/EmptyState` (`EmptyState`/`EmptyStateTitle`/`EmptyStateDesc`),
recipe deleted from globals.css. 17 prod consumers now use the primitive (conflicts
page, ProjectDetailView, ConversationList, ConversationWorkspace, ConversationsPage,
LoadingSessionView, CommitHistory, DiffPanel, SessionDiffViewer, config, …).

| Legacy | Migrated (primitive recipe) |
|---|---|
| `.empty-state` flex column, center, padded | `EmptyState` base |
| `.empty-state-icon` `2.5rem; margin-bottom:var(--space-lg); opacity:0.3` | primitive icon slot |
| `.empty-state-title` `font-display 700 1.1rem var(--text-secondary)` | `EmptyStateTitle` |
| `.empty-state-desc` `font-mono 0.78rem var(--text-tertiary) max-width:320px` | `EmptyStateDesc` |

Note `CommitHistory`/`DiffPanel` overrode the legacy `3xl xl` padding to a flat value;
the migration reattaches that via `layoutClassName` (documented in-file). The
primitive's byte-identical contract is fixed by `EmptyState.stories.tsx` +
`primitives.test.tsx`.

---

## Emission summary (production build `.next/static/chunks/*.css`)

| Geometry-critical declaration | Surface | Present |
|---|---|---|
| `min-height:36px` | DevServerDrawer row | ✓ |
| `min-height:44px` (×5) | cc-primary / cc-ibtn / Button touch / btn-sm | ✓ |
| `border-left:1.6px solid var(--color-text-inverse)` | checkbox checkmark | ✓ |
| `rgba(20,25,35,.96)` | toast surface | ✓ |
| `0 0 18px var(--color-cyan-glow-strong)` | cc-primary hover | ✓ |

All nine `ui/` primitives ship with a parity story:
`Button/IconButton/Badge/Tabs/StatusDot/EmptyState/FormField/SectionHeader/ModalShell`.

## Conclusion

Every high-risk surface is byte-identical at the declaration level, with the migrated
utilities confirmed emitted in the production build and resolving to the legacy token
values. The **one** intentional visual change is the ratified B-3 `TabCount` a11y
contrast fix. The **one** parity-adjacent caveat is the toast surface literal lacking a
token (rendered output identical; lint-allowlist deferred) — both carried into the
residual report.
