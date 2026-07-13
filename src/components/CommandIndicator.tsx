"use client";

import { memo } from "react";
import { cn } from "@/lib/ui/cn";
import { CompactMarkdown } from "@/components/markdown/Markdown";

interface Props {
  name: string;
  args: string | null;
}

// Cyan accent recolours to violet when the enclosing conversation runs the codex
// backend (legacy `.conversation[data-backend="codex"] .command-name`), expressed
// as an arbitrary ancestor variant so the out-of-component `.conversation` parent
// needs no `group` hook. The override is `!important` because `text-cyan` resolves
// through the unlayered legacy `.text-cyan` (typography.css), which otherwise beats
// any layered utility regardless of specificity (cascade-layer rule).
const commandName =
  "shrink-0 font-mono text-[0.75rem] font-semibold text-cyan [.conversation[data-backend=codex]_&]:text-violet!";

// Single-side left accent border (Preflight is OFF) — zero the other sides so
// `border-solid` does not paint a ~3px box on them.
const accentBorder =
  "border-y-0 border-r-0 border-l-2 border-solid border-cyan [.conversation[data-backend=codex]_&]:border-l-violet";

export default memo(function CommandIndicator({
  name,
  args,
}: Props): React.JSX.Element {
  const expanded = args !== null && args.includes("\n");

  if (expanded) {
    return (
      <div
        className={cn(
          "my-sm flex flex-col items-stretch gap-sm rounded-sm bg-bg-raised px-md py-sm font-mono text-[0.78rem]",
          accentBorder,
        )}
      >
        <span className={cn(commandName, "self-start")}>{name}</span>
        <CompactMarkdown content={args} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "my-sm flex min-h-[30px] items-center gap-[4px] rounded-sm bg-bg-raised px-sm py-[6px] font-mono text-[0.78rem]",
        accentBorder,
      )}
    >
      <span className={commandName}>{name}</span>
      {args && (
        <span className="min-w-0 overflow-hidden text-[0.72rem] font-normal text-ellipsis whitespace-nowrap text-text-tertiary">
          {args}
        </span>
      )}
    </div>
  );
});
