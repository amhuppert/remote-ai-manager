"use client";

import Link from "next/link";
import { DropdownMenuItem } from "@/components/ui/DropdownMenu";
import { ServerStackIcon } from "@/components/icons";
import { useRunningDevServerCount } from "@/lib/dev-server/queries";
import { cn } from "@/lib/ui/cn";

function describe(count: number | null): string {
  return count === null || count === 0
    ? "Dev servers"
    : `Dev servers: ${count} running`;
}

/**
 * Topbar destination for the cross-project dev-server view. The running
 * count is the glanceable signal; the label drops first as the bar narrows,
 * and below 768px the entry moves to the overflow menu.
 */
export function DevServersNavLink({
  active,
}: {
  active: boolean;
}): React.JSX.Element {
  const count = useRunningDevServerCount();
  const running = count !== null && count > 0;
  return (
    <Link
      href="/dev-servers"
      aria-label={describe(count)}
      title={describe(count)}
      className={cn(
        "inline-flex h-[28px] items-center gap-[6px] rounded-sm border border-solid bg-transparent px-[10px] font-mono text-[0.7rem] font-medium tracking-[0.06em] uppercase no-underline [transition:all_0.15s_ease] hover:border-cyan hover:bg-bg-hover hover:text-text-primary! max-768:hidden",
        active
          ? "border-cyan text-text-primary!"
          : "border-border-default text-text-secondary!",
      )}
    >
      <ServerStackIcon
        size={16}
        className={running ? "text-green" : undefined}
      />
      <span className="leading-none max-1180:hidden">Dev servers</span>
      {running && (
        <span className="inline-flex min-w-[16px] justify-center rounded-full bg-[var(--cc-devgreen-a06)] px-[5px] py-px text-[0.7rem] leading-[1.2] font-semibold tracking-normal text-green tabular-nums">
          {count}
        </span>
      )}
    </Link>
  );
}

/** Overflow-menu row for viewports where the topbar entry is hidden. */
export function DevServersMenuItem(): React.JSX.Element {
  const count = useRunningDevServerCount();
  return (
    <DropdownMenuItem asChild touch>
      <Link href="/dev-servers" aria-label={describe(count)}>
        <span className="flex w-full items-center gap-sm">
          <span className="flex-1">Dev servers</span>
          {count !== null && count > 0 && (
            <span className="font-mono text-[0.72rem] font-semibold text-green tabular-nums">
              {count}
            </span>
          )}
        </span>
      </Link>
    </DropdownMenuItem>
  );
}
