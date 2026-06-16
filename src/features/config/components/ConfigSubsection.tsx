import type { ReactNode } from "react";
import { cn } from "@/lib/ui/cn";

const SUBSECTION_BOX =
  "block overflow-hidden ml-md pl-md mb-md border border-solid rounded-md bg-bg-surface";
const BADGE_BOX =
  "ml-auto inline-flex items-center px-[7px] py-[2px] rounded-full border border-solid font-mono text-[0.7rem] font-semibold tracking-[0.08em] uppercase";

export function ConfigSubsection({
  title,
  id,
  isDefault,
  children,
}: {
  title: string;
  id: string;
  isDefault: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        SUBSECTION_BOX,
        isDefault
          ? "border-border-subtle"
          : "border-y-border-subtle border-r-border-subtle border-l-cyan",
      )}
      data-subsection={id}
    >
      <div className="flex items-center gap-[7px] px-md py-[10px] border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-base text-text-secondary font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase text-left cursor-default select-text">
        <span>{title}</span>
        <span
          className={cn(
            BADGE_BOX,
            isDefault
              ? "border-border-subtle bg-bg-raised text-text-tertiary"
              : "border-amber/30 bg-amber-glow text-amber",
          )}
        >
          {isDefault ? "DEFAULT" : "MODIFIED"}
        </span>
      </div>
      <div className="flex flex-col gap-md p-md">{children}</div>
    </div>
  );
}
