"use client";

import { memo } from "react";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import { cn } from "@/lib/ui/cn";

interface Props {
  name: string;
  args: string | null;
}

/** A command invocation and its complete, readable argument body. */
export default memo(function CommandIndicator({
  name,
  args,
}: Props): React.JSX.Element {
  const expanded = args?.includes("\n") ?? false;
  return (
    <section
      className={cn(
        "my-sm max-w-full min-w-0 overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-surface",
        !expanded && "flex flex-wrap items-stretch",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-sm gap-y-2xs bg-bg-raised px-md py-sm",
          expanded
            ? "border-x-0 border-t-0 border-b border-solid border-border-subtle"
            : "border-y-0 border-r border-l-0 border-solid border-border-subtle max-640:basis-full max-640:border-x-0 max-640:border-t-0 max-640:border-b",
        )}
      >
        <span className="min-w-0 font-mono text-[0.76rem] font-semibold break-all text-cyan [.conversation[data-backend=codex]_&]:text-violet!">
          {name}
        </span>
        <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-secondary uppercase">
          Command
        </span>
      </div>
      {args && (
        <div
          className={cn(
            "min-w-0 px-md py-sm",
            !expanded &&
              "flex flex-1 flex-wrap items-baseline gap-x-sm gap-y-xs",
          )}
          data-command-arguments
        >
          <div
            className={cn(
              "font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-secondary uppercase",
              expanded ? "mb-xs" : "max-640:basis-full",
            )}
          >
            Arguments
          </div>
          <div className="min-w-0 flex-1">
            <CompactMarkdown content={args} />
          </div>
        </div>
      )}
    </section>
  );
});
