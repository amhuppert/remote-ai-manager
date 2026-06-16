import type { HTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

// Parity-extracted from `.empty-state*` (globals.css): a centred placeholder
// block for empty lists/panels. Each part owns its appearance and exposes only
// the layout-only `layoutClassName` slot.

const emptyStateBase =
  "flex flex-col items-center justify-center px-xl py-3xl text-center";

export type EmptyStateProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function EmptyState({ layoutClassName, ...rest }: EmptyStateProps) {
  return <div {...rest} className={cn(emptyStateBase, layoutClassName)} />;
}

const emptyStateIconBase = "text-[2.5rem] mb-lg opacity-30";

export type EmptyStateIconProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function EmptyStateIcon({
  layoutClassName,
  ...rest
}: EmptyStateIconProps) {
  return <div {...rest} className={cn(emptyStateIconBase, layoutClassName)} />;
}

const emptyStateTitleBase =
  "font-display font-bold text-[1.1rem] text-text-secondary mb-sm";

export type EmptyStateTitleProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function EmptyStateTitle({
  layoutClassName,
  ...rest
}: EmptyStateTitleProps) {
  return <div {...rest} className={cn(emptyStateTitleBase, layoutClassName)} />;
}

const emptyStateDescBase =
  "font-mono text-[0.78rem] text-text-tertiary max-w-[320px]";

export type EmptyStateDescProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function EmptyStateDesc({
  layoutClassName,
  ...rest
}: EmptyStateDescProps) {
  return <div {...rest} className={cn(emptyStateDescBase, layoutClassName)} />;
}
