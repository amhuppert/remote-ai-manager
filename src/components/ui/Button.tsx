import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";
import { Spinner } from "./Spinner";

export type ButtonVariant =
  | "default"
  | "primary"
  | "danger"
  | "success"
  | "ghost";
export type ButtonSize = "sm" | "md" | "touch";

export type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style"
> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Opt-in mobile-spine touch sizing: 44px min-height + enlarged horizontal
   * padding below 768px (mirrors the global `.btn-sm` mobile touch target the
   * primitive otherwise does not bake in). The primitive owns this box
   * appearance; the layout-only allowlist forbids `min-h`/padding in
   * `layoutClassName` (docs/tailwind-conventions.md §2).
   */
  touch?: boolean;
  /**
   * Visible in-progress state for a mutation triggered by this button: renders
   * an inherit-tone spinner before the label, disables the button, and sets
   * `aria-busy`. This is the perceived-responsiveness floor (rung 3) — use it
   * whenever the click fires work whose outcome the UI can't show optimistically.
   */
  loading?: boolean;
  /**
   * External-geometry utilities applied by the parent (margin, grid/flex
   * placement, order, self-align, width/basis). Appended after the appearance
   * utilities and never overrides them. NOT for appearance — the primitive owns
   * background/color/border/radius/shadow.
   */
  layoutClassName?: string;
};

const touchClass = "max-768:min-h-[44px] max-768:px-[16px]";

// Invariant box only: layout, border width/style, radius, font family, gap,
// transition. Background, border-color, text color, and font-weight vary by
// variant; padding and font-size vary by size. Those live in the maps below so
// that no two applied utilities ever target the same CSS property on one element
// (the cascade between same-property utilities is sort-order dependent, which we
// must not rely on without tailwind-merge).
const base =
  "inline-flex items-center justify-center gap-sm rounded-md border border-solid font-mono transition-all duration-150 ease-[ease] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

const variantClass: Record<ButtonVariant, string> = {
  default:
    "bg-bg-surface border-border-default text-text-primary font-medium hover:bg-bg-raised hover:border-border-strong",
  primary:
    "bg-cyan border-cyan text-text-inverse font-semibold hover:bg-cyan-dim hover:border-cyan-dim hover:shadow-[0_0_20px_var(--color-cyan-glow)]",
  danger:
    "bg-transparent border-[var(--cc-red-border)] text-red font-medium hover:bg-red-glow hover:border-red-dim",
  success:
    "bg-transparent border-[var(--cc-green-border)] text-green font-medium hover:bg-green-glow hover:border-green-dim",
  ghost:
    "bg-transparent border-transparent text-text-secondary font-medium hover:bg-bg-hover hover:border-border-default hover:text-cyan",
};

const sizeClass: Record<ButtonSize, string> = {
  md: "px-[18px] py-[10px] text-[0.78rem]",
  sm: "px-[12px] py-[6px] text-[0.72rem]",
  touch: "min-h-[44px] min-w-[44px] px-[12px] py-[6px] text-[0.72rem]",
};

export function Button({
  variant = "default",
  size = "md",
  touch = false,
  loading = false,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const { layoutClassName, ...buttonProps } = rest;
  return (
    <button
      {...buttonProps}
      disabled={loading || disabled}
      aria-busy={loading || undefined}
      className={cn(
        base,
        variantClass[variant],
        sizeClass[size],
        touch && touchClass,
        layoutClassName,
      )}
    >
      {loading ? <Spinner size="sm" tone="inherit" /> : null}
      {children}
    </button>
  );
}
