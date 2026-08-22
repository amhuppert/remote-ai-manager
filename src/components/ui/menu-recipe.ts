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
  "z-menu min-w-[180px] rounded-md border border-solid border-border-default bg-bg-elevated p-[4px] shadow-menu data-[state=open]:motion-safe:animate-[fadeIn_0.12s_ease]";

// Item box. The UA outline is suppressed so pointer hover stays clean (just the
// `data-highlighted` tint), but keyboard focus gets the canonical cyan outline via
// `:focus-visible` — which Radix's real DOM-focus roving makes match on keyboard
// nav only. Inset offset so the ring hugs the item inside the menu padding. (The
// faint highlight tint alone is ~1.2:1 against the surface — not a sufficient focus
// indicator on its own; the outline carries WCAG 2.4.7 / 1.4.11.)
export const menuItemBase =
  "flex items-center gap-[8px] w-full select-none cursor-pointer rounded-sm border-0 bg-transparent py-[7px] px-[10px] text-left font-mono text-[0.74rem] font-medium outline-none transition-[background,color] duration-[100ms] ease-[ease] [&_svg]:shrink-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-40 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]";
export const menuItemTone =
  "text-text-primary [&_svg]:text-text-tertiary data-[highlighted]:bg-[var(--cc-cyan-a08)] data-[highlighted]:[&_svg]:text-current";
export const menuItemDanger =
  "text-red [&_svg]:text-text-tertiary data-[highlighted]:bg-[var(--cc-red-a10)] data-[highlighted]:[&_svg]:text-current";
// Opt-in row height for menus a reader reaches by thumb: the row grows to the
// 44px touch minimum below 768px. Off by default — a pointer menu's density is
// part of its design, and only the call site knows whether its menu is a mobile
// affordance.
export const menuItemTouch = "max-768:min-h-[44px]";

// Checkbox / radio items reserve a left indicator column. The checked row takes the
// cyan-glow treatment; the highlighted-but-unchecked bg and the checked bg are
// mutually exclusive via chained `data-state`/`data-highlighted` variants so no two
// utilities ever target `background` on one element (no reliance on emit order).
export const menuChoiceBase =
  "relative flex items-center gap-[8px] w-full select-none cursor-pointer rounded-sm border-0 bg-transparent py-[7px] pr-[10px] pl-[28px] text-left font-mono text-[0.74rem] font-medium outline-none transition-[background,color] duration-[100ms] ease-[ease] data-[disabled]:pointer-events-none data-[disabled]:opacity-40 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]";
export const menuChoiceTone =
  "data-[state=unchecked]:text-text-primary data-[state=unchecked]:data-[highlighted]:bg-[var(--cc-cyan-a08)] data-[state=checked]:bg-cyan-glow data-[state=checked]:text-cyan";
export const menuChoiceIndicator =
  "absolute left-[8px] top-1/2 inline-flex -translate-y-1/2 items-center justify-center text-cyan";

// Open-submenu highlight for a SubTrigger.
export const menuSubTriggerOpen = "data-[state=open]:bg-[var(--cc-cyan-a08)]";

export const menuLabel =
  "select-none px-[10px] pt-[6px] pb-[4px] font-mono text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";
export const menuSeparator = "mx-[2px] my-[4px] h-px bg-border-subtle";

// Right-aligned keyboard-shortcut / hotkey hint inside an item.
export const menuShortcut =
  "ml-auto pl-[16px] font-mono text-[0.7rem] tracking-[0.02em] text-text-tertiary";
