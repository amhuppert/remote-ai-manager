# Tailwind authoring conventions & per-slice migration protocol

How to author and migrate Command Center UI with Tailwind v4. This document is
the operational contract behind the design's UI-primitive and migration rules
(requirements 3.4, 4.3); it is meant to be **self-sufficient** — an implementer
should be able to migrate a slice from it without further design input.

Source of truth for the architecture is `.kiro/specs/tailwind-design-system-migration/design.md`;
for the visual language, `.claude/skills/cc-design-system/SKILL.md`. The toolchain
wiring is recorded in `.cc/graph-workflow-docs/toolchain-integration-notes.md`.

> **End-state status (post-migration).** Stages A–B are complete: every migratable
> surface that a B-6 slice owned is utility-first, the primitives ship in
> `src/components/ui/`, and the `css:progress` ratchet is green (no owner above its
> committed baseline). The migration is **ratchet-complete, not literal
> "preserved-only"** — the CSS that remains is three buckets: the preserved catalog
> (§5), the retained canonical recipes (§5.1), and the cross-owned / shell /
> descendant-anchor residual that is blocked on surfaces deferred out of B-6 (§5.2).
> Reaching a literal preserved-only floor needs the follow-up work recorded in §5.2
> and `.cc/graph-workflow-docs/b-final-final-verification.md`; it is **not** done in
> this stage. Two facts changed at B-final and are reflected throughout this
> doc:
> - **The `@theme` alias bridge is collapsed.** `theme.css` now carries the
>   **literal** value for every token directly (no `var(--legacy)` indirection).
>   The legacy `var(--…)` **names** are deliberately **retained** in `tokens.css`
>   because preserved CSS still reads them; both hold byte-identical values.
> - **Preflight is not imported (ratified).** CC's curated `reset.css` is the
>   **canonical base reset** (Option A — ratified by Alex). Its consequences (e.g.
>   single-side borders, §1.5) are standing rules, not temporary debt. Background:
>   `.cc/graph-workflow-docs/b-final-preflight-decision.md`.
> The per-slice protocol (§4) and rules (§1–§3, §7–§8) remain the standing contract
> for any new or future UI.

## The model in one paragraph

CC styles itself with a CSS-custom-property token system. Tailwind v4 is the
**authoring mechanism** over those tokens, not a redesign. New and migrated UI is
written as **utilities** (layout + appearance) plus a small set of **React
primitives** (`Button`, `Badge`, `StatusDot`, `Tabs`, `SectionHeader`,
`ModalShell`, `IconButton`, `EmptyState`, `FormField` — `src/components/ui/`)
that own canonical recipes. State is
expressed with `data-*` attributes mapped to **static class maps**. Tokens are
exposed through `@theme` in `src/features/_root/styles/theme.css`, which carries
the literal value for each token directly (the alias bridge is collapsed); the
legacy `var(--…)` names are retained in `tokens.css` and keep resolving for
preserved CSS. Preflight is **not imported** — CC's curated `reset.css` is the
reconciled canonical base reset.

> **Token utility names in this doc (`bg-cc-*`, `text-cc-text-*`, `gap-cc-*`,
> `rounded-cc-*`, `max-md`, …) are ILLUSTRATIVE of the pattern.** The authoritative
> `@theme` token names and the frozen `max-*` breakpoint variant set are defined in
> `theme.css` by the token-bridge context (design tasks 2.x). Read `theme.css` for
> the real names before authoring a slice.

### Cascade order (read this before authoring spacing utilities)

Three tiers, lowest to highest precedence:

1. **`@layer base`** — CC's `reset.css` **only** (imported with `layer(base)` in
   `_root/styles/index.css`). Its universal `*{margin:0;padding:0}` lives here so
   it does **not** mask Tailwind spacing utilities. Cascade layers outrank
   specificity, so an *unlayered* universal reset would beat `p-*`/`m-*`/`gap-*`
   on every element despite their higher specificity — the bug this layering fixes.
2. **`@layer utilities`** — Tailwind's generated utilities. They beat the layered
   reset, so `p-xl`, `gap-*`, `m-*` take effect at parity on migrated elements.
3. **unlayered** — all legacy feature/component CSS. It beats layered utilities,
   so a surviving `.project-card{padding}` still wins over `p-*` on the same
   element — the no-mixed-ownership backstop for **un-migrated** surfaces.

Only `reset.css` is layered; do **not** move feature CSS into a layer (that would
break tier 3). Backstops: `src/lib/shared/tailwind-reset-cascade.test.ts` (reset
sits in `base`, below utilities) and `tailwind-cascade-order.test.ts` (unlayered
legacy beats utilities).

**Preflight is not imported** (it never was). The migration evaluated layering
Tailwind's Preflight below `reset.css` and found it is **not inert** — it strips
markdown list markers (CC sets `list-style` nowhere) and reflows inline icons/
media (`img,svg,…{display:block}`), which would break R6 preserved output and
zero-visual-change parity. The ratified end-state (Option A) is that
**CC's `reset.css` IS the canonical base reset**; its universal
`*{box-sizing:border-box;margin:0;padding:0}` in `@layer base` already supplies
the one base behavior Tailwind utilities depend on. Consequences that follow from
not loading Preflight are standing rules, not temporary debt — see §1.5
(single-side borders). Decision package + the foreclosure analysis (why a
zero-drift Preflight adoption cannot pass the `css:progress` ratchet within the
B-final ownership) live in `.cc/graph-workflow-docs/b-final-preflight-decision.md`.
Option A is **ratified** — `reset.css` is permanently CC's base reset; Preflight is
not adopted.

---

## 1. Class rules

### 1.1 No dynamically-constructed class strings

Every utility class must appear as a **complete static string** in the source so
the Tailwind compiler and the lint/sort tooling can see it. Never build a class
name by concatenation or interpolation.

```tsx
// ❌ never — the compiler cannot see `bg-${tone}-500`; it may not be generated,
//    and the no-hardcoded/no-dynamic lint rule (post-pilot) rejects it.
<span className={`badge bg-${tone}-500 text-${size}`} />

// ✅ static variant map — every candidate class is literally present
const toneClass = {
  success: "bg-cc-green text-cc-text-inverse",
  danger: "bg-cc-red text-cc-text-inverse",
} as const;
<span className={toneClass[tone]} />
```

Compose conditionals with `cn()` (`src/lib/ui/cn.ts`, a `clsx` wrapper) — each
argument is still a static string:

```tsx
className={cn("badge", isActive && "bg-cc-cyan", isMuted && "opacity-60")}
```

### 1.2 Variants are static class maps; state is `data-*`

Encode appearance variants as a literal map keyed by a union type, and component
**state** as `data-*` attributes selected by `data-*` variants — never as
runtime class math.

```tsx
const variantClass: Record<ButtonVariant, string> = {
  primary: "bg-cc-cyan text-cc-text-inverse",
  danger: "bg-cc-red text-cc-text-inverse",
  ghost: "bg-transparent text-cc-text-secondary",
};
// state via data-* + the data variant (e.g. data-[loading=true]:opacity-60)
<button data-loading={loading} className={cn(variantClass[variant], "data-[loading=true]:opacity-60")} />
```

`[data-*]` is CC's existing state convention; it maps 1:1 onto Tailwind `data-*`
variants, so migrated components keep the same state contract.

### 1.3 No mixed ownership on one element

**An element is styled by exactly one system.** No element may carry both a
legacy `.cc-*` / BEM appearance class **and** Tailwind appearance utilities. A
component is migrated **fully** (all its rules → utilities/primitive) in a single
slice, and its legacy selectors are deleted in the same change. The primitives
enforce this at the type level by omitting `className`/`style` (see §2).

**The descendant-selector case (do not miss this).** Mixed ownership is not only
"two classes on one element." A migrated primitive must **not remain the live
target of a surviving legacy descendant selector**:

```css
/* legacy: a container positions the button from the outside */
.cc-page-actions .cc-ibtn { margin-left: auto; }
.approval-gate-actions .btn { width: 100%; }
```

If you migrate `<Button>` but leave `.cc-page-actions .cc-ibtn { … }` alive, the
button is still half-owned by legacy CSS — an invisible mixed-ownership channel
the "does it carry a `.cc-*` class?" check misses. Resolve it with the
**same-slice parent rule** (§4): the container that positions the primitive
migrates in the **same** slice, reattaching placement via `layoutClassName` (§2)
or its own flex/grid utilities, and the legacy descendant rule is deleted. A
slice that leaves a migrated primitive targeted by a `.parent .child` legacy rule
is **incomplete**.

### 1.4 No bare className that collides with a utility name

Tailwind emits a utility for every token it scans, plus always-on static
utilities (e.g. `sr-only`). If an element carries a bare className that matches a
utility name **and has no legacy CSS rule**, that utility silently styles it — a
visual change the cascade backstop can't prevent (there's no legacy rule to win).
Never ship an element whose bare className equals a Tailwind utility name unless a
legacy rule owns it; rename such a className to a non-utility BEM name.
`src/lib/shared/tailwind-utility-collisions.test.ts` asserts zero such collisions
and fails CI if a new one appears.

### 1.5 Single-side borders need the other sides zeroed (no global border reset)

CC's `reset.css` does **not** zero borders globally (and Preflight — whose
`*{border-width:0;border-style:solid}` reset would — is not imported), so an
element's unset border sides keep the CSS initial `border-width: medium` (~3px).
Applying `border-solid` (which sets the style on **all four** sides) together with
only a single-side width utility (`border-t`/`border-b`/…) makes the other three
sides render a ~3px box — a parity bug (a `border-top: 1px` rule becomes a full
box). When a slice needs a single-side border, **zero the other sides
explicitly**:

```tsx
// ❌ renders a ~3px box on the right/bottom/left (no Preflight to zero them)
<div className="border-t border-solid border-cc-border-subtle" />

// ✅ only the top renders
<div className="border-x-0 border-b-0 border-t border-solid border-cc-border-subtle" />
```

A full-box border (`border` = all four sides 1px) is unaffected. This is verified
visually per slice. Because CC's reset is the reconciled base reset (no global
border reset, Preflight not imported), this is a **standing rule**, not migration
debt that a later Preflight step removes.

---

## 2. The `layoutClassName` layout-only allowlist

Primitives own their appearance and **omit `className`/`style`** so a call site
cannot inject a legacy class or an appearance utility onto a migrated element.
The single sanctioned escape hatch is **`layoutClassName`** — for **external
geometry only**, applied by the parent, appended **after** the primitive's own
classes and never overriding its appearance.

| `layoutClassName` MAY contain (external geometry) | It MUST NOT contain (appearance — the primitive owns these) |
|---|---|
| margin: `m-*`, `mt-*`, `mx-*`, … | color / text: `text-*`, `font-*` |
| grid/flex placement: `col-*`, `row-*`, `justify-self-*`, `self-*`, `place-self-*`, area-based `[grid-area:*]`/`[grid-column:*]`/`[grid-row:*]` | background: `bg-*` |
| order: `order-*` | border: `border-*`, `ring-*` |
| alignment of self: `self-*`, `justify-self-*` | radius: `rounded-*` |
| width / basis: `w-*`, `min-w-*`, `max-w-*`, `basis-*`, `grow`, `shrink` | shadow / effects: `shadow-*`, `opacity-*` |
| responsive display toggle: `hidden` (drop a child from the parent's responsive grid/flow at a breakpoint) | padding (`p-*`) — it shapes the primitive's own box |

Why it exists: CC positions controls **from their container** today
(`.cc-page-actions .cc-ibtn`, `.approval-gate-actions .btn`, mobile touch-enlarge
rules). A parent must be able to place a migrated child without wrapping it in a
new `<div>` (that would be DOM restructuring, violating parity). `layoutClassName`
appends, it never overrides — so `tailwind-merge` stays unnecessary.

```tsx
// parent places the button; the button owns its own appearance
<div className="flex items-center gap-cc-sm">
  <Button variant="primary" layoutClassName="ml-auto" onClick={save}>Save</Button>
</div>
```

The post-pilot lint rule rejects any appearance utility passed to
`layoutClassName`, keeping appearance ownership exclusive (requirement 8.3).

---

## 3. Desktop-first `max-*` breakpoints — never invert to mobile-first

CC is **desktop-first**: it styles the full layout and overrides **down** with
`@media (max-width: …)`. The migration keeps that model with custom
**`max-*` variants** — it does **not** invert to Tailwind's default mobile-first
`min-width`. Inverting would require re-deriving and re-verifying every
responsive rule slice by slice (the highest-drift path); `max-*` variants
transcribe each existing rule 1:1.

```css
/* legacy */
@media (max-width: 768px) {
  .session-actions { flex-direction: column; }
}
```
```tsx
/* migrated — same threshold, desktop-first, no logic change */
<div className="flex flex-row max-768:flex-col" />
```

The canonical breakpoint tokens and `max-*` variant set are **frozen in
`theme.css` by the token-bridge context** (design task 2.3); use those names, do
not invent thresholds. CC's spine (from `.claude/skills/cc-design-system/SKILL.md`
and the CSS inventory):

| Threshold | Meaning | Variant (frozen in theme.css) |
|---|---|---|
| ≤768px | mobile single-panel mode | `max-768` (the dominant spine) |
| ≤960px | sidebar shrinks to 280px | `max-960` |
| ≤1080px | topbar crumbs shrink | `max-1080` |
| ≤1180px | right pane hides; single column | `max-1180` |
| 769px `min-width` | the few genuinely mobile-first rules | `min-769` companion |

One-off thresholds (`640/800/900/1100/…`) are tokenized as named
`--breakpoint-*` if recurring, or kept component-local if genuinely single-use.
**Rule: never write a mobile-first `min-*` variant to express a `max-width`
rule.** If a rule is genuinely mobile-first in the legacy CSS (a `min-width`
media query), keep it mobile-first; otherwise use `max-*`.

---

## 4. Per-slice migration protocol

Every slice follows this checklist. A slice is the smallest independently
shippable unit (a component + the container rules that position it). Do not open
a slice wider than one owner unless the same-slice parent rule pulls a positioning
container in.

1. **Classify** — identify any generated/vendor DOM in the slice (React Flow,
   Tiptap `.ProseMirror`, markdown/Mermaid output) and the **preserved-CSS
   residual** it must keep (§5). That CSS is NOT converted.
2. **Scope the parent** — find every legacy **descendant selector** that
   positions this slice's elements from a container (`.parent .child { margin /
   grid / order / touch-size }`). Those container rules come into **this** slice
   (the same-slice parent rule, §1.3) so no migrated element is left targeted by
   a surviving legacy rule.
3. **Capture the baseline** — screenshot the slice before any change at the two
   fixed viewports (below), at the same scroll position and state. Store under
   `docs/reports/visual/<slice>/before-{desktop,mobile}.png`.
4. **Convert the full component** — replace its legacy rules with utilities, or
   with a primitive (`src/components/ui/`) when it is a canonical recipe (button,
   badge, status dot, tabs, section header, modal shell). Appearance utilities use
   `@theme` tokens (`bg-cc-*`, `text-cc-text-*`, `rounded-cc-*`, …) — never
   hard-coded colors.
5. **Map state** — convert `[data-*]`/conditional appearance to `data-*` variants
   + static class maps (§1.2). No dynamic class strings.
6. **Reattach parent layout** — apply the container's placement via the parent's
   own flex/grid utilities, or via the child's `layoutClassName` (layout-only,
   §2). Delete the legacy descendant selectors you pulled in at step 2.
7. **Delete dead CSS + brittle tests** — remove the obsolete selectors, their now
   unused `@import`s, and any **CSS-class/structure or `className` assertions** for
   this surface (requirement 5.1). Do **not** re-add CSS-structure assertions; rely
   on Storybook + visual verification. Re-home genuine a11y/legibility guarantees
   onto the theme surface, never delete a guarantee to pass.
8. **Run the gates** — `bun run lint`, `bun run typecheck`, the targeted Vitest +
   affected Storybook tests. Larger waves also `bun run build` + `bun run
   build-storybook`.
9. **Verify parity** — capture `after-{desktop,mobile}.png` at the same two
   viewports and compare to the baseline.

### Fixed viewport dimensions

Capture and compare at exactly these two sizes (device-scale-factor 1):

- **Desktop: 1440 × 900** — above every CC desktop breakpoint (1180/1080/960), so
  the full multi-pane layout renders.
- **Mobile: 390 × 844** — below the 768px spine, so mobile single-panel mode
  renders.

If the slice has behavior at an intermediate threshold (e.g. the 960px sidebar
shrink), additionally spot-check at that threshold ±1px — but the two fixed sizes
above are the required baseline pair.

### Pass / fail (Chromatic is deferred)

Visual parity is **human-judged**. There is no pixel-threshold gate.

- **Pass** = a reviewer confirms the after screenshots match the before at both
  viewports.
- **Any visible drift** = the slice is **incomplete**; return to step 4. Do not
  merge partial parity, and never claim parity you cannot evidence with the
  before/after pair.

Evidence lives in `docs/reports/visual/<slice>/` (before/after × desktop/mobile).

---

## 5. Preserved-CSS do-not-convert catalog

DOM CC does **not author in JSX**, body atmospherics, scrollbars, keyframes, and
portal positioning stay as **scoped CSS forever** (decision 4 / requirement 6).
Never convert these to utilities. The authoritative, regenerable list is
`docs/reports/css-inventory.md` (`bun run css:inventory`); the categories:

| Preserved category | Owners (see inventory for exact selectors) |
|---|---|
| **React Flow vendor DOM** (`.react-flow*`/`.xyflow*`) | `src/components/workflow-graph/workflow-graph.css` (stays bespoke; migrate only its JSX-authored chrome, last) |
| **Tiptap `.ProseMirror` editor DOM** | `conversation.css` **and** `session/sidebar/styles/PeekPopover.css` (both) |
| **Markdown / syntax-highlighter / Mermaid output** | `globals.css` (`.markdown-*`), `conversation.css` (`.mermaid*`) |
| **Body atmospherics** (`body::before` noise, `body::after` scanlines) | `_root/styles/reset.css` |
| **Scrollbars** (`::-webkit-scrollbar*`) | `globals.css`, `conversation.css`, `workflow-graph.css` |
| **`@keyframes`** (graph/atmospheric/vendor; shared ones tokenized to `--animate-*` by the token bridge) | `globals.css`, `workflow-graph.css`, `conversation.css`, `session.css`, `cockpit.css`, `project-detail.css`, `PeekPopover.css` |
| **Portal / overlay positioning** | tooltip/modal/toast (`globals.css`), AskQuestion overlay (`conversation.css`), `.cr-*` dialog (`dialogs.css`), diff slide-over (`cockpit.css`), peek backdrop (`PeekPopover.css`) |
| **`prefers-reduced-motion` blocks** | `conversation.css`, `cockpit.css` |
| **Base reset** (`*`, `html`, `body`) | `reset.css` — CC's **canonical base reset** (Preflight not imported; Option A ratified). Stays in `@layer base`. |

When a slice's component sits next to preserved CSS (e.g. a conversation message
rendering markdown), migrate the **authored chrome** and leave the
generated-content selectors untouched. "Completion" is **Tailwind-backed tokens +
route/component migration**, not zero CSS files.

### 5.1 Retained canonical recipes (the five families still above floor)

> **Status: Option A executed.** The primitive-swap remediation wave swapped the
> leaf-recipe consumers onto the `ui/` primitives (or inline utilities) and
> **deleted** the now-dead recipes: `.empty-state*`, `.cc-section-*`, `.form-*`,
> `.cc-primary`, `.cc-ibtn`, `.cc-checkbox`, `.cc-toast`, `.btn-toggle` (and earlier
> `.cc-badge*` + the `.cc-*` typography helpers). **Five** families remain — each
> because ≥1 consumer needs a primitive feature that does not exist yet — plus the
> load-bearing `.text-*` helpers. They are parked, not permanent. The authoritative
> backlog (file:line) is `docs/reports/leaf-recipe-swap-residual-report.md`.

These families stay only until the **primitive-extension remediation wave** extends
the matching primitive and swaps the last consumers. New UI MUST use the primitive,
never these recipes.

| Retained family | Owner file | Matching primitive | Why it can't be swapped yet (the missing feature) |
|---|---|---|---|
| `.btn*` (`-primary/-danger/-success/-ghost/-sm` + mobile) | `globals.css` | `ui/Button` | SessionGitPanel View-Diff is a `<Link>` (Button renders `<button>`); AgentCapabilityPanel Reset needs a disabled-fade variant; MobileInfoPanel. → `Button` `as`/anchor + disabled variant. |
| `.btn-icon-only*` | `globals.css` | `ui/IconButton` | ConversationPanel copy-markdown uses a cross-owned 28px rule; `IconButton` is 30px (+2px). → 28px size. |
| `.cc-tab*` (`cc-tabs`, `cc-tab`, `cc-tab-count`) | `globals.css` | `ui/Tabs` | MobileBottomBar `.mobile-bottom-bar .cc-tab` descendant overrides not re-homable in-slice. |
| `.status-dot*` (`.warning/.amber/.cyan`) | `globals.css` | `ui/StatusDot` | mobile topbar enlarges the dot to 8px; `StatusDot` is fixed 7px. → 8px size + re-home the topbar-owned rules. |
| `.modal*` (`-overlay`/`.modal`/`-title`/`-actions`) | `globals.css` | `ui/ModalShell` | CreateSessionModal mobile bottom-sheet; `ModalShell` is desktop-only. → mobile-sheet variant. |
| `.text-*` color helpers | `typography.css` | Tailwind `text-<color>` utilities | **Load-bearing** — they back the `text-*` tokens so those aren't flagged as bare-token collisions. Retire during R9 with `TypographyHelpers.stories.tsx`. |

**Two consequences for end-state cleanup:**

- These families are tracked **above** each owner's preserved floor (globals.css
  floor stays **66**; project-detail/typography stay **0**). The `css:progress`
  baseline ratchet records them as the current high-water mark, so they cannot
  silently regrow but the primitive-extension remediation wave can still reduce
  them. Do **not** raise the floor to encode these as "preserved forever" — that
  would forbid the swap.
- They stay **unlayered** in their owner file (where they currently win over
  utilities). Several consumers stack Tailwind utilities directly on a recipe
  element (e.g. `cc-tab flex … px-md py-sm hover:bg-bg-hover`), authored under that
  cascade. Moving the recipes into `@layer components` would flip precedence and
  risk visual drift; since Preflight is not adopted (Option A ratified) there is no
  cascade-reconciliation pass — the primitive-extension wave re-checks parity per
  consumer as it swaps, never a blind sweep.

The per-family prod-consumer lists and the Option-A-vs-B disposition are recorded
in `.cc/graph-workflow-docs/b-final-leaf-recipe-disposition.md`.

### 5.2 Cross-owned / shell / descendant-anchor residual (above floor, blocked on deferred surfaces)

A **third** class of CSS remains above some owners' floors that is neither §5
preserved-DOM nor a §5.1 retained recipe. It is migratable in principle, but a B-6
slice could not finish it without crossing into a surface that was **deferred out of
B-6's scope** (or out of any single slice's ownership). It is honest to call these
out explicitly: the migration is **ratchet-complete, not literal preserved-only**,
and this is the residual that a literal preserved-only floor would still have to
clear. None of it is loose ends inside a migrated component — each item is blocked on
a specific, named follow-up.

| Owner (count) | Residual | Why it can't reach floor in B-6 | Unblocks when |
|---|---|---|---|
| `shell.css` (8, floor 0) | `.app` / `.main` shell-layout grid + `data-page`/`data-with-sidebar`/`data-sidebar-collapsed` column templates + mobile drawer override | Unlayered `.main` **beats** `@layer utilities`; the shell element is shared by every page (and by `workflows-catalog.css .workflow-detail-main` on the same `<main>`). A utility form lands in `@layer utilities` and loses → cascade-blocked. | The shell shell-layout migrates as its own foundation slice (re-home into the layered base or restructure the `.main` cascade) — out of B-6. |
| `topbar.css` (10, floor 10 = at floor) | `.topbar*` brand/divider/breadcrumb/`-status-*`/`-sep` | `Topbar.tsx` is migrated; these survive as descendant-anchors for **externally-injected** `globalStatus`/`sessionControls` content + a deferred-legacy consumer (`MobileSessionView.stories.tsx`). At floor, but not preserved-catalog. | The deferred `MobileSessionView` mobile-topbar surface migrates; injected-content anchors move onto their injectors. |
| `session.css` (23, floor 0) | `.sidebar-diff-panel` / `.prompt-panel` data-layout + mobile-panel visibility toggles, bare structural hooks (`.session-content-area`, `.conversation-docked-stage`, `.debug-*`), `.finished-banner`/`.iteration-readonly-banner`, 3 preserved keyframes | The toggles style elements **owned by the conversation / right-pane context** (DiffPanel, ConversationPanel) from the session content area's state — they move when that context migrates those elements, not before. Keyframes are §5 preserved. | The conversation/right-pane DiffPanel + ConversationPanel chrome migrates (deferred past B-6); keyframes stay (preserved). |
| `conversation-panes.css` (2, floor 0) | `.pane__body > .conversation` gap + `> *+*` margin override | Overrides the **unlayered** shared `.conversation` (owned by `conversation.css`); a `@layer utilities` form loses the cascade → the density override would be defeated. | The shared `.conversation` base migrates (or the panes override is re-homed unlayered) — out of B-6. |
| `workflows-catalog.css` (3, floor 0) | `.workflow-detail-main` (+ detail grid) | Lives on the **same `<main>`** as the legacy shell `.main`; migrating creates mixed ownership with the unlayered shell class. | Blocked on the same `shell.css` migration above. |
| `keyboard-shortcuts-modal.css` (3, floor 2) · `cockpit.css` (8, floor 6) · `PeekPopover.css` (8, floor 6) · `dialogs.css` (3→2) | Floors that **undercount** true preserved residual (scroll container + mobile bottom-sheet selectors; comma-list `prefers-reduced-motion` + mobile width; `.peek-backdrop` + ProseMirror + peek keyframes) | The floor is a conservative bound; reaching "exactly floor" would delete **preserved** CSS (barred by R6). | B-final **9.2 floor-tightening** raises these floors to the proven residual (see `b6-small-residuals-disposition.md`). |

`project-detail.css` (23, floor 0) and `typography.css` (13, floor 0) above-floor
residual is the §5.1 retained recipes (`.cc-primary`/`.cc-ibtn`/`.cc-checkbox`;
`.text-*` helpers), not this bucket.

The disposition of each item is recorded in
`.cc/graph-workflow-docs/b6-small-residuals-disposition.md`,
`b6-conversation-prompt-panel-residual-disposition.md`, and the B-final
final-verification record. These are surfaced for Alex at the human-approval gate as
**explicit remediation**, not silently absorbed into "preserved."

---

## 6. Per-PR gate checklist

- [ ] No dynamically-constructed class strings; variants are static maps; state is `data-*` (§1).
- [ ] No mixed ownership — no element carries both legacy appearance class and utilities; no migrated primitive is left targeted by a legacy descendant selector (§1.3).
- [ ] `layoutClassName` (if used) is layout-only (§2).
- [ ] Responsive rules use desktop-first `max-*` variants, transcribed 1:1 (§3).
- [ ] Legacy selectors, unused imports, and brittle CSS/`className` assertions for the migrated surface are deleted; guarantees re-homed, not dropped (§4.7).
- [ ] `bun run lint`, `bun run typecheck`, targeted Vitest + affected Storybook tests pass; larger waves also `bun run build` + `bun run build-storybook`.
- [ ] Before/after parity confirmed at 1440×900 and 390×844; evidence committed under `docs/reports/visual/<slice>/`.

## 7. Guardrails (post-pilot lint & class-sort)

Active from the pilot onward (design task 5.2; requirements 7.5 / 8.3 / 8.4).

**Class sorting — `prettier-plugin-tailwindcss`.** Configured in `.prettierrc`, but
**scoped via `overrides` to migrated, utility-first paths only**. Applying it
repo-wide mangles CC's pervasive legacy `` `${cond ? " suffix" : ""}` `` idiom (the
plugin trims the significant join space, corrupting the className). Add a path to
the `.prettierrc` override `files` as each wave migrates.

**ESLint Tailwind plugin — `eslint-plugin-better-tailwindcss`.** `no-duplicate-classes`
runs on migrated paths (`entryPoint: src/app/globals.css`).

**Guardrail rules — `eslint-rules/tailwind-guardrails.mjs`** (RuleTester suite:
`eslint-rules/tailwind-guardrails.test.mjs`):

| Rule | Flags | Scope |
|---|---|---|
| `tailwind-guardrails/no-dynamic-class` | template-literal (interpolation **glued** into a token, e.g. `bg-${x}-500`) or non-static `+`-concat class strings in `className`/`layoutClassName`/`cn()`, **including indirectly** via a variable resolved to such an init. Space-separated composition of complete strings (`` `${A} ${B}` ``) is allowed | migrated paths |
| `tailwind-guardrails/no-hardcoded-color` | **any raw color literal** — hex (`#abc…`) **and** `rgb()`/`rgba()`/`hsl()` — in a class string. Custom-alpha glows/shadow colors/translucent borders with no solid-color token are extracted to a `--cc-*` token in `tokens.css` and referenced via `var(--…)` inside the composite utility (`shadow-[…var(--…)…]`); `var()`/gradient/keyword values carry no literal and pass | migrated paths |
| `tailwind-guardrails/no-appearance-in-layout-classname` | any non-layout utility in `layoutClassName` (allowlist: margin, grid/flex placement incl. `[grid-area:*]`, order, self-align, width/basis, responsive display `hidden`) | migrated paths |
| `tailwind-guardrails/no-unapproved-global-css` | new CSS rules in a stylesheet outside the approved **foundation/vendor** areas (`_root/styles/`, `workflow-graph`). Feature `styles/` dirs are migration **debt**: the existing files are grandfathered, but a NEW stylesheet there fails | all `*.css` |

**Extending per wave — keep these FOUR allowlists in sync** (each gates a different
tool against the same "this surface is migrated" fact):

1. `MIGRATED_UTILITY_FIRST` in `eslint.config.mjs` — enables the 3 JS guardrails.
2. `overrides[].files` in `.prettierrc` — enables Tailwind class-sorting.
3. `UTILITY_FIRST_PATHS` in `src/lib/shared/tailwind-utility-collisions.test.ts` — exempts the surface from the bare-token collision heuristic.
4. `APPROVED_GLOBAL_CSS_AREAS` in `eslint.config.mjs` — only when adding genuine foundation/vendor CSS (not for normal slice migration, which removes CSS). Do **not** grow `GRANDFATHERED_LEGACY_CSS` to make room for new global CSS — migrate to utilities instead; that list only shrinks as legacy stylesheets are deleted.

Effect colors with no solid-color token (custom-alpha glows/shadows/translucent borders) live as `--cc-*` custom properties in `tokens.css`; reference them via `var(--cc-…)` inside the composite utility.

## 8. Stage B feature-wave recipes (icon/toggle button, descendant variants, effects)

Added by the shared-primitive-extension context for the parallel feature waves.

### 8.1 Canonical icon/toggle-button recipe — the `IconButton` primitive

`src/components/ui/IconButton.tsx` owns the icon/toggle-button recipe. Do **not**
re-inline `.btn-icon-only` / `.cc-ibtn` / the pin-toggle pattern in a wave — use
the primitive. Three parity variants:

| `variant` | Legacy recipe | Shape | Toggle |
|---|---|---|---|
| `square` | `.btn-icon-only` | 30px square icon-only (`relative`, 0.85rem glyph); `size="touch"` → 44px/26px-svg; `tone="danger"` recolours hover | — |
| `pill` | `.cc-ibtn` | icon+label, height 30 | `pressed` → cyan active (legacy `.cc-ibtn.active`) |
| `ghost` | pin-toggle pilot | 24px borderless star, mobile touch-enlarge | `pressed` → amber pinned glow |

**`square` enlarges on mobile — the primitive owns it.** `globals.css` has two
global `@media (max-width: 768px)` rules that make **every** `.btn-icon-only` a
44px touch target with a 1rem glyph (`min-width/min-height: 44px` + `width/height:
44px` + `font-size: 1rem`), independent of `size`. `IconButton` bakes this in as
`max-768:{w,h,min-w,min-h}-[44px] max-768:text-[1rem]`, so at the fixed 390×844
mobile viewport a default `square` button renders 44×44/1rem — matching legacy.
A wave must **not** try to reattach this via `layoutClassName`: `height`,
`min-height`, and `font-size` are not in the allowlist (§8.1, allowlist gap), so
the primitive carries the responsive enlargement and the call site needs nothing
extra. (`size="touch"` is the always-44px desktop+mobile variant for controls
that are touch-sized on desktop too, e.g. the legacy `[data-size="touch"]`.)

- **State** is `pressed` → `data-pressed`. Appearance is partitioned out of the
  shared box so no two utilities target one property; active-beats-hover is
  expressed with mutually-exclusive `data-[pressed=true]:…` vs
  `data-[pressed=false]:hover:…` gating (the Tabs idiom, §1.2) — no reliance on
  variant emission order.
- **`layoutClassName` is proven** by the primitive's `LayoutPlacement` story: a
  parent flex container replicating `.cc-page-actions .cc-ibtn` positions the
  control from the outside via `ml-auto` / `self-stretch` (external geometry
  only), and the pill keeps its own appearance untouched.
- **Allowlist gap to plan around:** the legacy mobile rule
  `.cc-page-actions .cc-ibtn { height/min-height:44px; justify-content:center;
  flex:1 }` is only **partly** expressible through `layoutClassName` — `flex:1`→
  `grow` and `align-self`→`self-*` are allowed, but `height`/`min-height` and
  `justify-content` are **not** in `LAYOUT_ALLOWED`
  (`eslint-rules/tailwind-guardrails.mjs`). When a parent touch-enlarges an
  `IconButton`, apply those from the **parent's own** flex/grid utilities (or a
  wrapper), not the child's `layoutClassName`.

`EmptyState` (`.empty-state*`) and `FormField` (`.form-*`) follow the same rules.
Note `.form-input` is defined twice in `globals.css` (lines 989 & 7991); the
primitive captures the merged effective recipe (later def wins overlapping
properties; first contributes `::placeholder`).

### 8.2 Arbitrary-descendant-variant idiom (legacy `.parent:hover .child`)

A migrated child must **not** stay the target of a surviving legacy descendant
selector (§1.3). When a legacy rule styles a child from a stateful parent, move
the rule onto the child with `group` + a `group-*`/arbitrary variant — never
resurrect a `.parent .child` selector:

1. Put `group` on the parent, plus its state attribute (e.g. `data-activity`).
2. `.parent[data-x=v] .child` → on the child: `group-data-[x=v]:<utility>`.
3. `.parent[data-x=v]:hover .child` (parent-state **and** parent-hover → child) →
   on the child use the **arbitrary variant** the pilot proved in `NAME_CLASS`:

```tsx
// legacy: .idle .project-name {…}  /  .idle:hover .project-name {…}
"group-data-[activity=idle]:text-text-secondary " +
"[.group[data-activity=idle]:hover_&]:text-text-primary"
```

The `_` inside the bracket is the descendant-combinator space; `&` is the styled
child. This keeps the child fully utility-owned and leaves no legacy descendant
rule alive to half-own it.

### 8.3 Effects use arbitrary utilities over EXISTING tokens — never add tokens

Parallel waves **MUST NOT add, rename, or remove** entries in `tokens.css` /
`theme.css`. For shadows, glows, accent/translucent borders, and `drop-shadow`
filters, reference an **existing** token/var inside an arbitrary utility:

```tsx
"focus:shadow-[0_0_0_3px_var(--cyan-glow)]"                  // focus ring
"data-[pressed=true]:[filter:drop-shadow(0_0_4px_var(--cc-amber-a50))]" // glow
"data-[pressed=true]:border-cyan-glow-strong"               // token-utility border
```

- The legacy `.cc-ibtn.active` cyan border `rgba(0,229,255,0.3)` is **exactly**
  `--cyan-glow-strong` — reuse it (`border-cyan-glow-strong`), do not mint a token.
- Raw `#hex` / `rgb()` / `rgba()` / `hsl()` literals in a class string fail
  `no-hardcoded-color` (§7). If an effect colour has **no** existing token, that
  is a signal to escalate to the token bridge — **not** to inline a literal or add
  a feature-wave token.

#### The token-backed-arbitrary-utility parity pattern (when a parity color has no token)

Zero-visual-change parity sometimes needs a color that has **no** Tailwind scale
entry and **no** existing token — e.g. the `.conv-stop-btn` soft-red
`rgb(248,113,113)`, which is distinct from `--red` (`#ff3d5a`). The standing
resolution (proven in the B-6 foundation context) keeps `no-hardcoded-color`
satisfied without any wave editing the token files:

1. A **single designated token-owner context** (the foundation/token-bridge
   context for a wave group) mints the parity-only token in `tokens.css` **up
   front** — e.g. `--cc-red-soft-a45`, `--cc-amber-a08`, `--cc-bg-void-a70`.
2. Migration slices then reproduce the exact color via a **token-backed arbitrary
   utility** — `bg-[var(--cc-red-soft-a45)]`, `border-t-[var(--cc-amber-a08)]`,
   `text-[var(--cc-red-check-fail)]`. A `var(--…)` inside an arbitrary utility
   carries no literal, so it **passes `no-hardcoded-color`**.
3. Slices **never** edit `tokens.css`/`theme.css` themselves — only the token-owner
   context does. This makes the "forbid token edits in a wave" rule (above)
   satisfiable instead of a deadlock: the color exists as a token before the slice
   that needs it runs.

For a value derivable from an existing token, prefer `color-mix(in srgb, var(--…)
N%, transparent)` inside the arbitrary utility (also literal-free, also exact) over
minting a near-duplicate token; reserve minting for genuinely new parity colors.
The minted parity tokens join the `@theme` surface for the R9 dedup pass (e.g.
normalizing `--cc-amber-a08` into the amber scale).

### 8.4 Single-side borders (reminder — no global border reset)

CC's reset does not zero borders globally and Preflight is not imported, so
`border-solid` + a single-side width utility renders a ~3px box on the other three
sides. **Zero them explicitly** (`border-x-0 border-b-0 border-t …`); a full-box
`border` is unaffected. Full detail and example in **§1.5** — re-read it before
authoring any single-side border.

## Pointers

- `cn()` helper → `src/lib/ui/cn.ts` (built in the primitives context).
- Guardrail rules → `eslint-rules/tailwind-guardrails.mjs` (+ `.test.mjs`); §7.
- Primitives → `src/components/ui/{Button,Badge,StatusDot,Tabs,SectionHeader,ModalShell,IconButton,EmptyState,FormField}.tsx` + stories.
- Stage B-1 shared-primitive survey (which recipes are primitives vs wave-local) → `.cc/graph-workflow-docs/shared-primitive-survey.md`.
- `@theme` token surface → `src/features/_root/styles/theme.css` (alias + extract lanes; frozen `max-*` variants).
- Cascade backstops → `src/lib/shared/tailwind-cascade-order.test.ts` (unlayered legacy beats layered utilities) + `tailwind-reset-cascade.test.ts` (reset is in `@layer base`, below utilities).
- CSS ownership + preserved-CSS catalog → `scripts/css-inventory.ts` → `docs/reports/css-inventory.md`.
- Toolchain wiring + Storybook logging stub → `.cc/graph-workflow-docs/toolchain-integration-notes.md`.
