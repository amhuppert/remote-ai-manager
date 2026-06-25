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
