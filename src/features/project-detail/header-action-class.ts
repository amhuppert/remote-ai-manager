// Byte-for-byte reproduction of the `.cc-ibtn` leaf recipe (project-detail.css)
// for the project header's actions. The matching primitive is
// `IconButton variant="pill"`, but the header's navigation actions are `<Link>`
// anchors — swapping the element would drop native link behaviour
// (middle-click/open-in-new-tab/href) — and the pill primitive does not carry
// the 44px mobile touch target these siblings share. So the pill appearance is
// re-homed as inline utilities used by every header action. The
// `@media (max-width:768px)` 44px touch target the recipe carried is folded
// into the `max-768:` utilities.
export const CC_IBTN_LINK_CLASS =
  "inline-flex h-[30px] items-center gap-[6px] rounded-md border border-solid " +
  "border-border-subtle bg-transparent px-[10px] py-0 font-mono text-[0.72rem] " +
  "font-medium text-text-secondary transition-all duration-150 ease-[ease] " +
  "[&_svg]:text-text-tertiary [&_svg]:transition-colors [&_svg]:duration-150 [&_svg]:ease-[ease] " +
  "hover:border-border-strong hover:bg-bg-hover hover:text-text-primary hover:[&_svg]:text-cyan " +
  "max-768:h-[44px] max-768:min-h-[44px] max-768:flex-1 max-768:justify-center";
