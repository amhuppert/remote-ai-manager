// Shared appearance for the right-side agent-capabilities configuration drawer,
// composed onto the `ui/Dialog` unstyled/edge-anchored variant. Both the scoped
// (project/session) and conversation-level entry points render the same
// full-height edge-anchored `<aside>`-shaped card over the same blurred scrim, so
// the box model lives here once rather than being duplicated in each entry point.

// Blurred, saturated backdrop (`data-cc-modal-scrim` is added by the primitive so
// the global ambient-animation freeze rule can pause page animations behind it).
export const capabilitiesDrawerScrim =
  "fixed inset-0 z-dropdown bg-[var(--cc-bg-void-a60)] [backdrop-filter:blur(4px)_saturate(120%)]";

// Full-height, right-edge card with the drawer's left border + drop shadow.
export const capabilitiesDrawerContent =
  "fixed top-0 right-0 bottom-0 z-dropdown flex w-[min(720px,100vw)] flex-col border-y-0 border-r-0 border-l border-solid border-border-default bg-bg-base shadow-[-16px_0_48px_var(--cc-black-a55)]";
