# Tailwind authoring conventions & per-slice migration protocol

How to author and migrate Command Center UI with Tailwind v4. This document is
the operational contract behind the design's UI-primitive and migration rules
(requirements 3.4, 4.3); it is meant to be **self-sufficient** — an implementer
should be able to migrate a slice from it without further design input.

Source of truth for the architecture is `.kiro/specs/tailwind-design-system-migration/design.md`;
for the visual language, `.claude/skills/cc-design-system/SKILL.md`. The toolchain
wiring is recorded in `.cc/graph-workflow-docs/toolchain-integration-notes.md`.

## The model in one paragraph

CC styles itself with a CSS-custom-property token system. Tailwind v4 is the
**authoring mechanism** over those tokens, not a redesign. New and migrated UI is
written as **utilities** (layout + appearance) plus a small set of **React
primitives** (`Button`, `Badge`, `StatusDot`, `Tabs`, `SectionHeader`,
`ModalShell` — `src/components/ui/`) that own canonical recipes. State is
expressed with `data-*` attributes mapped to **static class maps**. Tokens are
exposed through `@theme` in `src/features/_root/styles/theme.css`; legacy
`var(--…)` names keep resolving during the migration. Preflight is OFF — CC's
`reset.css` is the base reset.

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
legacy beats utilities). Preflight stays OFF until Stage B.

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

### 1.5 Single-side borders need the other sides zeroed (Preflight is OFF)

Preflight's `*{border-width:0;border-style:solid}` reset is **not** loaded, so an
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
visually per slice; there is no global border reset until Preflight lands in Stage B.

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
| grid/flex placement: `col-*`, `row-*`, `justify-self-*`, `self-*`, `place-self-*` | background: `bg-*` |
| order: `order-*` | border: `border-*`, `ring-*` |
| alignment of self: `self-*`, `justify-self-*` | radius: `rounded-*` |
| width / basis: `w-*`, `min-w-*`, `max-w-*`, `basis-*`, `grow`, `shrink` | shadow / effects: `shadow-*`, `opacity-*` |
| | padding (`p-*`) — it shapes the primitive's own box |

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
<div className="flex flex-row max-md:flex-col" />
```

The canonical breakpoint tokens and `max-*` variant set are **frozen in
`theme.css` by the token-bridge context** (design task 2.3); use those names, do
not invent thresholds. CC's spine (from `.claude/skills/cc-design-system/SKILL.md`
and the CSS inventory):

| Threshold | Meaning | Variant (frozen in theme.css) |
|---|---|---|
| ≤768px | mobile single-panel mode | `max-md` (the dominant spine) |
| ≤960px | sidebar shrinks to 280px | `max-lg` |
| ≤1080px | topbar crumbs shrink | `max-xl` |
| ≤1180px | right pane hides; single column | `max-2xl` |
| 769px `min-width` | the few genuinely mobile-first rules | `min-md` companion |

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
| **Base reset** (`*`, `html`, `body`) | `reset.css` — preserved until Preflight is reconciled in Stage B |

When a slice's component sits next to preserved CSS (e.g. a conversation message
rendering markdown), migrate the **authored chrome** and leave the
generated-content selectors untouched. "Completion" is **Tailwind-backed tokens +
route/component migration**, not zero CSS files.

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
| `tailwind-guardrails/no-appearance-in-layout-classname` | any non-layout utility in `layoutClassName` (allowlist: margin, grid/flex placement, order, self-align, width/basis) | migrated paths |
| `tailwind-guardrails/no-unapproved-global-css` | new CSS rules in a stylesheet outside the approved **foundation/vendor** areas (`_root/styles/`, `workflow-graph`). Feature `styles/` dirs are migration **debt**: the existing files are grandfathered, but a NEW stylesheet there fails | all `*.css` |

**Extending per wave — keep these FOUR allowlists in sync** (each gates a different
tool against the same "this surface is migrated" fact):

1. `MIGRATED_UTILITY_FIRST` in `eslint.config.mjs` — enables the 3 JS guardrails.
2. `overrides[].files` in `.prettierrc` — enables Tailwind class-sorting.
3. `UTILITY_FIRST_PATHS` in `src/lib/shared/tailwind-utility-collisions.test.ts` — exempts the surface from the bare-token collision heuristic.
4. `APPROVED_GLOBAL_CSS_AREAS` in `eslint.config.mjs` — only when adding genuine foundation/vendor CSS (not for normal slice migration, which removes CSS). Do **not** grow `GRANDFATHERED_LEGACY_CSS` to make room for new global CSS — migrate to utilities instead; that list only shrinks as legacy stylesheets are deleted.

Effect colors with no solid-color token (custom-alpha glows/shadows/translucent borders) live as `--cc-*` custom properties in `tokens.css`; reference them via `var(--cc-…)` inside the composite utility.

## Pointers

- `cn()` helper → `src/lib/ui/cn.ts` (built in the primitives context).
- Guardrail rules → `eslint-rules/tailwind-guardrails.mjs` (+ `.test.mjs`); §7.
- Primitives → `src/components/ui/{Button,Badge,StatusDot,Tabs,SectionHeader,ModalShell}.tsx` + stories.
- `@theme` token surface → `src/features/_root/styles/theme.css` (alias + extract lanes; frozen `max-*` variants).
- Cascade backstops → `src/lib/shared/tailwind-cascade-order.test.ts` (unlayered legacy beats layered utilities) + `tailwind-reset-cascade.test.ts` (reset is in `@layer base`, below utilities).
- CSS ownership + preserved-CSS catalog → `scripts/css-inventory.ts` → `docs/reports/css-inventory.md`.
- Toolchain wiring + Storybook logging stub → `.cc/graph-workflow-docs/toolchain-integration-notes.md`.
