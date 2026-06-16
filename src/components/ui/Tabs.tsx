import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

const tabsBase =
  "flex gap-[2px] p-[3px] bg-bg-surface border border-solid border-border-default rounded-md";

export type TabsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function Tabs({ layoutClassName, ...rest }: TabsProps) {
  return <div {...rest} className={cn(tabsBase, layoutClassName)} />;
}

const tabBase =
  "flex items-center gap-[4px] px-[10px] py-[5px] min-h-[28px] border-0 rounded-sm bg-transparent font-mono text-[0.72rem] font-medium uppercase tracking-[0.05em] cursor-pointer transition-all duration-150 ease-[ease] whitespace-nowrap";

// Active beats hover (legacy source order). Expressed order-independently: the
// active appearance is gated on `data-active=true` and the hover override on
// `data-active=false`, so the two selectors are mutually exclusive — no reliance
// on Tailwind's variant emission order.
const tabState =
  "text-text-secondary data-[active=true]:bg-cyan data-[active=true]:text-text-inverse data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary";

// Fill/touch mode: on the mobile spine each tab centers its label and grows to a
// 36px touch target. The parent supplies the equal-split geometry
// (`grow shrink basis-0`) via `layoutClassName`; the primitive owns the
// appearance (`justify-center`/`min-h`), which the layout-only allowlist forbids
// in `layoutClassName` (docs/tailwind-conventions.md §2).
const tabFill = "max-768:justify-center max-768:min-h-[36px]";

export type TabProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style"
> & {
  active?: boolean;
  /** Mobile-spine fill/touch treatment: center the label, 36px min-height. */
  fill?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function Tab({
  active = false,
  fill = false,
  layoutClassName,
  ...rest
}: TabProps) {
  return (
    <button
      {...rest}
      data-active={active}
      className={cn(tabBase, tabState, fill && tabFill, layoutClassName)}
    />
  );
}

const tabCountBase =
  "font-mono text-[0.7rem] font-medium px-[4px] rounded-full opacity-[0.85] data-[active=true]:opacity-100";

export type TabCountProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  active?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function TabCount({
  active = false,
  layoutClassName,
  ...rest
}: TabCountProps) {
  return (
    <span
      {...rest}
      data-active={active}
      className={cn(tabCountBase, layoutClassName)}
    />
  );
}
