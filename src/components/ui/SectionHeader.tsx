import type { HTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

const sectionHeaderBase =
  "flex items-center gap-sm min-h-[28px] mb-header-content";

export type SectionHeaderProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function SectionHeader({
  layoutClassName,
  ...rest
}: SectionHeaderProps) {
  return <div {...rest} className={cn(sectionHeaderBase, layoutClassName)} />;
}

// `transition-transform` (which in v4 also covers the individual `rotate`
// property) animates the collapse, matching legacy `transition: transform`.
const sectionChevronBase =
  "inline-flex items-center justify-center size-[16px] text-text-secondary transition-transform duration-150 ease-[ease] shrink-0 data-[collapsed=true]:-rotate-90";

export type SectionChevronProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  collapsed?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function SectionChevron({
  collapsed = false,
  layoutClassName,
  ...rest
}: SectionChevronProps) {
  return (
    <span
      {...rest}
      data-collapsed={collapsed}
      className={cn(sectionChevronBase, layoutClassName)}
    />
  );
}

const sectionLabelBase =
  "font-mono text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-text-secondary";

export type SectionLabelProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function SectionLabel({ layoutClassName, ...rest }: SectionLabelProps) {
  return <span {...rest} className={cn(sectionLabelBase, layoutClassName)} />;
}

const sectionCountBase =
  "font-mono text-[0.7rem] font-normal text-text-tertiary";

export type SectionCountProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function SectionCount({ layoutClassName, ...rest }: SectionCountProps) {
  return <span {...rest} className={cn(sectionCountBase, layoutClassName)} />;
}

const sectionActionsBase = "flex items-center gap-xs ml-auto";

export type SectionActionsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function SectionActions({
  layoutClassName,
  ...rest
}: SectionActionsProps) {
  return <div {...rest} className={cn(sectionActionsBase, layoutClassName)} />;
}
