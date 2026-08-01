# Command Center — design conventions

Command Center (CC) is a **dark-themed** control-plane UI. Every component is built for a dark
surface with light text and a cyan (`#00e5ff`) accent. Designs must stay dark-on-dark — never
place these components on a white background.

## Setup — no provider, but keep the theme

The components are presentational: they take props + `className` and need **no React provider** to
render. The shipped `styles.css` already sets the theme on `body` — dark background
(`--bg-void` = `#0b1019`/`#06090f`), light text (`--text-primary`), and the brand fonts
(Manrope body, Anybody display, Geist Mono code). Build inside that: a top-level
`<div className="bg-bg-base text-text-primary font-body">…</div>` is the canonical shell.

Optional: hover tooltips. Some components carry `data-tooltip="…"`; the tooltip only appears if a
single `TooltipProvider` is mounted once at the app root. It's cosmetic — skip it unless you want
hover tooltips.

## Styling idiom — Tailwind v4 utilities, CC token vocabulary

Style your own layout glue with CC's **token-backed Tailwind utilities** (not raw hex, not generic
Tailwind palette colors). The real families:

| Purpose | Utilities (real, in the shipped CSS) |
|---|---|
| Surfaces | `bg-bg-void` `bg-bg-base` `bg-bg-surface` `bg-bg-raised` `bg-bg-elevated` `bg-bg-hover` |
| Text | `text-text-primary` `text-text-secondary` `text-text-tertiary` `text-text-inverse` |
| Borders | `border-border-default` `border-border-subtle` `border-border-strong` `border-border-dim` |
| Accent (cyan) | `text-cyan` `bg-cyan` `border-cyan` `bg-cyan-glow` |
| Status | `text-red` `text-green` `text-amber` `text-blue` `text-violet` (each + `-dim`/`-glow`) |
| Spacing | `gap-md` `p-md` `px-lg` `py-sm` … scale: `2xs xs sm md lg xl 2xl 3xl` |
| Radius | `rounded-sm` `rounded-md` `rounded-lg` |
| Fonts | `font-body` (Manrope) `font-display` (Anybody, headings) `font-mono` (Geist Mono, code/ids) |
| z-index | `z-dropdown` `z-menu` `z-toast` `z-tooltip` … |

Component variants are props, not classes — e.g. `<Button variant="primary">` (cyan),
`variant="default"` (surface), `"danger"`/`"success"` (outlined), `"ghost"`. Badge is
tier-discriminated: `<Badge status="running">`, `<Badge tier="type" kind="bug">`,
`<Badge tier="count">3</Badge>`. IDs and code use `font-mono`.

## Interactive primitives are Radix-backed — use them, don't hand-roll

Menus, dialogs, selects, disclosures, and form controls are built on **Radix UI** (the
WAI-ARIA APG patterns), so correct keyboard navigation, focus management, type-ahead, ARIA
roles, collision-aware positioning, and outside-click dismissal come for free. **Compose
these primitives instead of building custom ones.** They share one shape — a `Root` +
`Trigger`/parts + (for overlays) a self-portalled `Content` — and own their appearance via
props + Radix `data-*` state, **not `className`**; the only style escape hatch is the
layout-only `layoutClassName` prop (margin / width / placement). Triggers compose
`Button`/`IconButton` via `asChild`. Each component's `.prompt.md` has copy-paste examples.

**Menus & selects** — `DropdownMenu` (a button that opens an actions menu, APG Menu Button),
`ContextMenu` (the same, opened by right-click), `Select` (pick one value, APG Listbox —
`SelectValue`/`SelectItem`, optional per-row `description`). Menu parts:
`Item`/`CheckboxItem`/`RadioItem`/`Label`/`Separator`/`Sub*`; a destructive row takes
`danger`; `DropdownMenuShortcut` right-aligns a hotkey hint. Non-modal, self-portalling.

**Dialogs & overlays** — portalled, with the scrim/positioning baked in (no manual portal):

- **`Dialog`** — a modal task surface. `DialogTrigger` + `DialogContent` (with `DialogTitle`,
  `DialogDescription`, `DialogActions`) + `DialogClose`.
- **`AlertDialog`** — a confirm/destructive modal (use instead of `window.confirm`).
  `AlertDialogAction` (add `danger` for destructive) / `AlertDialogCancel`.
- **`Popover`** — a floating panel anchored to a trigger: `PopoverTrigger` + `PopoverContent`.
- **`Tooltip`** — a hover/focus hint. Mount one **`TooltipProvider`** at the app root, then
  `Tooltip` + `TooltipTrigger asChild` + `TooltipContent`.

**Disclosure** — **`Accordion`** (`type="single"|"multiple"`;
`AccordionItem`/`AccordionTrigger`/`AccordionContent`) and **`Collapsible`** (one show/hide
region; `CollapsibleTrigger`/`CollapsibleContent`).

**Form controls** — value via `checked`/`value` + `onCheckedChange`/`onValueChange`:
**`Checkbox`** (+ `CheckboxField` for label & description), **`RadioGroup`**
(`RadioGroupItem`/`RadioGroupOption`), **`Switch`** (on/off; `tone="green"` for a positive
on-state), **`SegmentedControl`** (`SegmentedControlItem` — a compact inline single-choice
toggle). **`Progress`** is a determinate/indeterminate bar with
`tone="accent"|"warning"|"danger"` (the context-fill meter's threshold language).

**`Autocomplete`** — the listbox surface (`AutocompleteListbox` + `AutocompleteOption` /
`AutocompleteMatchText` / `AutocompleteNavFooter`) behind CC's command / file / conversation
pickers.

## The "exceeds the scale" rainbow signal

The two top reasoning-effort tiers — **Max** and **XHigh** — render with an animated
rainbow gradient as a deliberate "beyond the normal scale" signal, in two places:

- **`ReasoningLevelSelector`**'s trigger takes a rainbow gradient border + gradient text
  when Max/XHigh is selected; every lower tier uses the plain surface trigger.
- In the conversation panel, a message's effort label renders as rainbow gradient text
  via **`EffortLabel`** (`<EffortLabel effort="max" />`) — the shared `cc-rainbow-text`
  treatment. Lower tiers (and effort-less models) render as plain secondary text.

Reserve the rainbow strictly for Max/XHigh — it's a meaningful signal, not decoration.

## Where the truth lives

- The shipped stylesheet and its tokens: read `styles.css` (and its `@import` closure) before styling.
- Per-component API + usage: each component's `<Name>.d.ts` (`<Name>Props`) and `<Name>.prompt.md`.

## Build snippet

```jsx
<div className="bg-bg-base text-text-primary font-body flex flex-col gap-md p-lg">
  <SectionHeader>
    <SectionLabel>Sessions</SectionLabel>
    <SectionCount>3</SectionCount>
  </SectionHeader>
  <CopyableId label="branch" value="csm/migrate-to-tailwind" />
  <div className="flex gap-sm">
    <Button variant="primary">Merge</Button>
    <Button variant="ghost">Cancel</Button>
  </div>
</div>
```

## Note

`MarkdownContent` renders markdown + syntax-highlighted code faithfully, but ```mermaid blocks
show a placeholder (the mermaid engine is excluded to keep the bundle within size limits).

# CommandCenterUI (command-center@0.1.0)

This design system is the published command-center React library, bundled as a single
browser global. All 38 components are the real upstream code.

## Where things are

- `_ds_bundle.js` — the whole-DS bundle at the project root; loads every component to `window.CommandCenterUI`. First line is a `/* @ds-bundle: … */` metadata header.
- `styles.css` — the single stylesheet entry: it `@import`s the tokens, fonts, and component styles (`_ds_bundle.css`). Link this one file.
- `components/<group>/<Name>/<Name>.prompt.md` (example JSX + variants), `<Name>.d.ts` (types), `<Name>.html` (variant grid).
- `tokens/*.css` — CSS custom properties, names verbatim from upstream.
- `fonts/` — `@font-face` files + `fonts.css` (when the package ships fonts).
- `guidelines/` — the design system's own usage guidance (6 doc(s), see `guidelines/index.md`). Read these before composing larger layouts.

For a specific component, `read_file("components/<group>/<Name>/<Name>.prompt.md")`.

## Loading

Add these two lines to your page once (React must be on the page first):

```html
<link rel="stylesheet" href="styles.css">
<script src="_ds_bundle.js"></script>
```

Components are then available at `window.CommandCenterUI.*`. Mount into a dedicated child node (e.g. `<div id="ds-root">`), not the host page's own React root, so the two trees don't collide:

```jsx
const { Accordion } = window.CommandCenterUI;
ReactDOM.createRoot(document.getElementById('ds-root')).render(<Accordion />);
```

This DS's storybook wraps every story in decorators from `.storybook/preview`
(bundled for the preview cards as `_vendor/preview-decorators.js`). Components
likely need equivalent context — theme/i18n providers — in your tree too. The
exact chain hasn't been distilled into config, so check the DS's documented
provider setup before composing.

## Tokens

328 CSS custom properties from command-center. Names are
preserved verbatim from upstream. They are declared inside `_ds_bundle.css` (this DS ships one compiled stylesheet rather than separate token files).

- **color** (82): `--color-red-500`, `--color-black`, `--color-white`, …
- **spacing** (15): `--space-2xs`, `--space-xs`, `--space-sm`, …
- **typography** (17): `--font-sans`, `--font-mono`, `--font-weight-normal`, …
- **radius** (4): `--radius-xs`, `--radius-sm`, `--radius-md`, …
- **shadow** (15): `--shadow-dropdown`, `--shadow-menu`, `--tw-shadow`, …
- **other** (195): `--spacing`, `--animate-spin`, `--default-transition-duration`, …

## Components

### ui
- `Accordion`
- `AlertDialog`
- `Autocomplete`
- `Badge`
- `Button`
- `Checkbox`
- `Collapsible`
- `ContextMenu`
- `Dialog`
- `DropdownMenu`
- `EmptyState`
- `FormField`
- `IconButton`
- `Popover`
- `Progress`
- `RadioGroup`
- `SectionHeader`
- `SegmentedControl`
- `Select`
- `Spinner`
- `StatusDot`
- `Switch`
- `Tabs`
- `Tooltip`

### components
- `BackendToggle`
- `BranchSelector`
- `CardContextMenu`
- `CollapsibleText`
- `ConfirmDialog`
- `ContextFillIndicator`
- `ConversationNav`
- `CopyableId`
- `MarkdownContent`
- `MergeToast`
- `ModelSelector`
- `ReasoningLevelSelector`
- `TddToggle`

### conversation
- `EffortLabel`
