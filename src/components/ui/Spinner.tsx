import type { HTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

export type SpinnerSize = "sm" | "md";
export type SpinnerTone = "cyan" | "inherit";

// The ring draws in currentColor with a transparent gap, so the "inherit" tone
// stays legible on any Button variant (e.g. cyan-filled primary, where a cyan
// spinner would vanish).
const base =
  "inline-block rounded-full border-2 border-solid border-current border-t-transparent animate-spin";

const sizeClass: Record<SpinnerSize, string> = {
  sm: "size-[12px]",
  md: "size-[16px]",
};

export type SpinnerProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  size?: SpinnerSize;
  tone?: SpinnerTone;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function Spinner({
  size = "md",
  tone = "cyan",
  layoutClassName,
  ...rest
}: SpinnerProps) {
  return (
    <span
      aria-hidden="true"
      {...rest}
      className={cn(
        base,
        sizeClass[size],
        tone === "cyan" && "text-cyan",
        layoutClassName,
      )}
    />
  );
}
