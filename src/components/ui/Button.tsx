import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

export type ButtonVariant =
  | "default"
  | "primary"
  | "danger"
  | "success"
  | "ghost";
export type ButtonSize = "sm" | "md";

export type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style"
> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * External-geometry utilities applied by the parent (margin, grid/flex
   * placement, order, self-align, width/basis). Appended after the appearance
   * utilities and never overrides them. NOT for appearance — the primitive owns
   * background/color/border/radius/shadow.
   */
  layoutClassName?: string;
};

// Invariant box only: layout, border width/style, radius, font family, gap,
// transition. Background, border-color, text color, and font-weight vary by
// variant; padding and font-size vary by size. Those live in the maps below so
// that no two applied utilities ever target the same CSS property on one element
// (the cascade between same-property utilities is sort-order dependent, which we
// must not rely on without tailwind-merge).
const base =
  "inline-flex items-center gap-sm rounded-md border border-solid font-mono transition-all duration-150 ease-[ease]";

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
};

export function Button({
  variant = "default",
  size = "md",
  layoutClassName,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={cn(
        base,
        variantClass[variant],
        sizeClass[size],
        layoutClassName,
      )}
    />
  );
}
