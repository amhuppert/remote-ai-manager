import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

export type IconButtonVariant = "square" | "pill" | "ghost";
export type IconButtonSize = "md" | "touch";
export type IconButtonTone = "default" | "danger";

// Invariant box: inline-flex centring of the glyph + the shared 0.15s ease
// transition. Shape, sizing, border, colour, and toggle state vary by
// variant/size/state and live in the maps below so that no two applied
// utilities target the same CSS property on one element (the cascade between
// same-property utilities is sort-order dependent, which we must not rely on
// without tailwind-merge).
const base =
  "inline-flex items-center cursor-pointer transition-all duration-150 ease-[ease] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

// `square` — `.btn-icon-only` (globals.css): a square icon-only control with an
// optional 44px touch target. `tone=danger` recolours only the hover state.
// The two global `@media (max-width:768px)` rules enlarge EVERY `.btn-icon-only`
// to a 44px touch target with a 1rem glyph (min-w/min-h + w/h + font-size),
// independent of `size`. The primitive owns this desktop-first `max-768:`
// transcription because a downstream wave cannot reattach it via
// `layoutClassName` — height/min-height/font-size are not in the layout
// allowlist — so migrating a `.btn-icon-only` call site would otherwise shrink
// the mobile control. `position: relative` anchors portal-rendered tooltips.
const squareBox =
  "relative justify-center p-0 rounded-sm border border-solid bg-transparent text-[0.85rem] " +
  "max-768:w-[44px] max-768:h-[44px] max-768:min-w-[44px] max-768:min-h-[44px] max-768:text-[1rem]";
const squareSize: Record<IconButtonSize, string> = {
  md: "size-[30px] [&>svg]:size-[18px]",
  touch: "size-[44px] [&>svg]:size-[26px]",
};
const squareTone: Record<IconButtonTone, string> = {
  default:
    "border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary hover:border-border-strong",
  danger:
    "border-border-default text-text-secondary hover:bg-red-glow hover:text-red hover:border-red-dim",
};

// `pill` — `.cc-ibtn` (project-detail.css): an icon+label control with a cyan
// `pressed` (legacy `.active`) toggle. Active beats hover (legacy source order);
// expressed order-independently via mutually-exclusive `data-[pressed]` gating,
// so we do not depend on Tailwind's variant emission order.
const pillBox =
  "gap-[6px] h-[30px] px-[10px] rounded-md border border-solid bg-transparent font-mono text-[0.72rem] font-medium [&_svg]:transition-colors [&_svg]:duration-150 [&_svg]:ease-[ease]";
const pillState =
  "border-border-subtle text-text-secondary [&_svg]:text-text-tertiary " +
  "data-[pressed=true]:text-cyan data-[pressed=true]:bg-cyan-glow data-[pressed=true]:border-cyan-glow-strong data-[pressed=true]:[&_svg]:text-cyan " +
  "data-[pressed=false]:hover:bg-bg-hover data-[pressed=false]:hover:text-text-primary data-[pressed=false]:hover:border-border-strong data-[pressed=false]:hover:[&_svg]:text-cyan";

// `ghost` — the pin-toggle pilot (ProjectCard): a 24px borderless star button
// with an amber `pressed` (pinned) glow; enlarges to the 44px touch minimum on
// mobile. Replicates the pilot's `PIN_BTN_CLASS` verbatim.
const ghostBox =
  "justify-center size-[24px] shrink-0 p-0 rounded-sm border-0 bg-transparent text-[0.9rem] leading-none max-768:min-h-[44px] max-768:min-w-[44px]";
const ghostState =
  "text-text-tertiary " +
  "hover:text-amber hover:[filter:drop-shadow(0_0_3px_var(--cc-amber-a40))] " +
  "data-[pressed=true]:text-amber data-[pressed=true]:[filter:drop-shadow(0_0_4px_var(--cc-amber-a50))] " +
  "data-[pressed=true]:hover:text-amber-dim data-[pressed=true]:hover:[filter:drop-shadow(0_0_6px_var(--cc-amber-a60))]";

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style"
> & {
  variant?: IconButtonVariant;
  /** Touch-target sizing — `square` only (md=30px, touch=44px). */
  size?: IconButtonSize;
  /** Hover recolour — `square` only. */
  tone?: IconButtonTone;
  /** Toggle state (`pill` = cyan active, `ghost` = amber pinned). */
  pressed?: boolean;
  /**
   * External-geometry utilities applied by the parent (margin, grid/flex
   * placement, order, self-align, width/basis). Appended after the appearance
   * utilities and never overrides them. NOT for appearance — the primitive owns
   * background/color/border/radius/shadow/sizing.
   */
  layoutClassName?: string;
};

function appearance(
  variant: IconButtonVariant,
  size: IconButtonSize,
  tone: IconButtonTone,
): string {
  if (variant === "pill") return cn(pillBox, pillState);
  if (variant === "ghost") return cn(ghostBox, ghostState);
  return cn(squareBox, squareSize[size], squareTone[tone]);
}

export function IconButton({
  variant = "square",
  size = "md",
  tone = "default",
  pressed = false,
  layoutClassName,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      data-pressed={pressed}
      className={cn(base, appearance(variant, size, tone), layoutClassName)}
    />
  );
}
