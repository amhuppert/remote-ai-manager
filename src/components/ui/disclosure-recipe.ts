// Shared CC appearance recipe for the disclosure family — `Collapsible`
// (WAI-ARIA APG Disclosure) and `Accordion` (WAI-ARIA APG Accordion). Both
// reveal an in-flow region from a header button, so they share one trigger
// recipe, chevron, and reveal motion. Kept here (mirroring `menu-recipe.ts`,
// shared by `DropdownMenu`/`ContextMenu`) so the two primitives cannot drift.
//
// State comes off Radix's own `data-*` attributes: the trigger carries
// `data-state=open|closed` and `data-disabled`; the chevron reads the trigger's
// state via the `group` it sits in.

// Header button: full-width, transparent, inherits the host's font; CC's
// canonical inset cyan `:focus-visible` ring. The disabled treatment dims and
// (matching `menu-recipe`) drops `pointer-events` rather than fighting the
// unlayered `button { cursor: pointer }` base reset with `cursor-not-allowed`
// (an `@layer utilities` rule can't beat an unlayered type selector); blocking
// pointer events also suppresses hover. Mobile gets the 44px touch target. The
// `group` lets the chevron rotate off this button's state.
export const disclosureTriggerBase =
  "group flex w-full cursor-pointer items-center gap-sm border-0 bg-transparent px-md py-sm text-left [font:inherit] text-text-secondary outline-none transition-colors duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 max-768:min-h-[var(--touch-target-min)]";

// Trailing chevron: points down when closed, rotates to point up when the
// trigger's `group` is open. Motion is removed under reduced-motion.
export const disclosureChevron =
  "ml-auto shrink-0 text-text-tertiary transition-transform duration-150 ease-[ease] group-data-[state=open]:rotate-180 motion-reduce:transition-none";

// Revealed region: a restrained fade-in on open, gated `motion-safe` (there is
// no global reduced-motion reset to lean on). Radix mounts the content only
// while open, so a closed region leaves the accessibility tree and tab order.
export const disclosureContentMotion =
  "data-[state=open]:motion-safe:animate-[fadeIn_0.15s_ease]";
