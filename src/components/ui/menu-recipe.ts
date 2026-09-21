// Shared class recipe for the CC menu primitives (`DropdownMenu` + `ContextMenu`).
// Both implement the same WAI-ARIA menu pattern with byte-identical CC appearance;
// only their Radix Root/Trigger differ (a button opens the dropdown; a right-click
// opens the context menu). The surface/item/label/separator recipes live here so
// the two primitives cannot drift. Radix's per-primitive content CSS vars
// (`--radix-{dropdown,context}-menu-content-*`) stay in each primitive, since the
// variable name is namespaced per primitive.
//
// These are complete static strings consumed via `cn(...)`, satisfying the
// `no-dynamic-class` guardrail (no interpolation, no `+`-concat).

// Elevated card + canonical menu drop shadow, shared by Content and SubContent.
// `data-state=open` plays the restrained CC fade (motion-safe); Radix unmounts on
// close (no exit animation).
export const menuSurface =
  "z-menu min-w-[180px] max-w-[calc(100vw-16px)] rounded-lg border border-solid border-border-default bg-bg-surface p-xs shadow-menu data-[state=open]:motion-safe:animate-[fadeIn_0.12s_ease]";

// Item box. The UA outline is suppressed so pointer hover stays clean (just the
// `data-highlighted` tint), but keyboard focus gets the canonical cyan outline via
// `:focus-visible` — which Radix's real DOM-focus roving makes match on keyboard
// nav only. Inset offset so the ring hugs the item inside the menu padding. (The
// faint highlight tint alone is ~1.2:1 against the surface — not a sufficient focus
// indicator on its own; the outline carries WCAG 2.4.7 / 1.4.11.)
export const menuItemBase =
  "group/menu-item flex min-h-[36px] items-center gap-sm w-full select-none cursor-pointer rounded-md border-0 bg-transparent py-sm px-md text-left font-mono text-[0.78rem] leading-[20px] font-medium outline-none transition-[background,color] duration-[100ms] ease-[ease] [&_svg]:size-[18px] [&_svg]:shrink-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-60 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]";
export const menuItemTone =
  "text-text-primary [&_svg]:text-text-secondary data-[highlighted]:bg-bg-raised data-[highlighted]:[&_svg]:text-current";
export const menuItemDanger =
  "text-red [&_svg]:text-current data-[highlighted]:bg-[var(--cc-red-a10)]";
// Opt-in row height for menus a reader reaches by thumb: the row grows to the
// 44px touch minimum below 768px. Off by default — a pointer menu's density is
// part of its design, and only the call site knows whether its menu is a mobile
// affordance.
export const menuItemTouch = "max-768:min-h-[44px]";

// Checkbox / radio items reserve a left indicator column. The checked row takes the
// raised-surface treatment; the highlighted-but-unchecked bg and the checked bg are
// mutually exclusive via chained `data-state`/`data-highlighted` variants so no two
// utilities ever target `background` on one element (no reliance on emit order).
export const menuChoiceBase =
  "group/menu-item relative flex min-h-[36px] items-center gap-sm w-full select-none cursor-pointer rounded-md border-0 bg-transparent py-sm pr-md pl-[40px] text-left font-mono text-[0.78rem] leading-[20px] font-medium outline-none transition-[background,color] duration-[100ms] ease-[ease] data-[disabled]:pointer-events-none data-[disabled]:opacity-60 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]";
export const menuChoiceTone =
  "data-[state=unchecked]:text-text-primary data-[state=unchecked]:data-[highlighted]:bg-bg-raised data-[state=checked]:bg-bg-raised data-[state=checked]:text-cyan data-[state=checked]:shadow-[inset_2px_0_0_var(--color-cyan)]";
export const menuChoiceIndicator =
  "absolute left-[12px] top-1/2 inline-flex size-[20px] -translate-y-1/2 items-center justify-center text-cyan";

// Open-submenu highlight for a SubTrigger.
export const menuSubTriggerOpen = "data-[state=open]:bg-bg-raised";

export const menuLabel =
  "select-none px-md pt-sm pb-xs font-mono text-[0.7rem] leading-[20px] font-semibold uppercase tracking-[0.1em] text-text-secondary";
export const menuSeparator = "mx-md my-sm h-px bg-border-default";

// Right-aligned keyboard-shortcut / hotkey hint inside an item.
export const menuShortcut =
  "ml-auto pl-lg font-mono text-[0.7rem] tracking-[0.02em] text-text-secondary";
