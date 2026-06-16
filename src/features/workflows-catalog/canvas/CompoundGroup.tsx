"use client";

import type React from "react";
import { cn } from "@/lib/ui/cn";

interface CompoundGroupProps {
  /** Top-left in canvas space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Display label (rendered uppercase in mono). */
  label: string;
  /** Optional sub-label rendered after the main one, e.g. "compound". */
  hint?: string;
  /** Status hint that changes the border color. */
  status?: "neutral" | "warning" | "success" | "failure";
  /** Becomes true when the compound state is selected. */
  selected?: boolean;
  /** Click handler — fired when the compound's chrome (not its children) is clicked. */
  stateId?: string;
  onClickHeader?: (stateId: string) => void;
  children?: React.ReactNode;
}

const GROUP_BORDER: Record<
  NonNullable<CompoundGroupProps["status"]>,
  string
> = {
  neutral: "border-border-default",
  warning: "border-amber-dim",
  success: "border-green-dim",
  failure: "border-red-dim",
};

/**
 * A dashed wrapper around a compound state's children. Children are rendered
 * inside the same absolute-positioning context (positions are still in canvas
 * coordinates, not relative to the group).
 */
export default function CompoundGroup({
  x,
  y,
  width,
  height,
  label,
  hint,
  status,
  selected,
  stateId,
  onClickHeader,
  children,
}: CompoundGroupProps): React.JSX.Element {
  const borderColor = selected
    ? "border-cyan"
    : GROUP_BORDER[status ?? "neutral"];

  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute rounded-lg border border-dashed bg-bg-base/40",
          borderColor,
          selected && "shadow-[0_0_0_1px_var(--cyan-glow)]",
        )}
        style={{
          left: `${x}px`,
          top: `${y}px`,
          width: `${width}px`,
          height: `${height}px`,
        }}
        aria-hidden="true"
      >
        <button
          type="button"
          className="pointer-events-auto absolute left-[16px] top-[-12px] inline-flex cursor-pointer items-center gap-[8px] rounded-sm border border-solid border-border-default bg-bg-base px-[10px] py-[2px] font-mono text-[0.7rem] uppercase tracking-[0.08em] text-text-secondary transition-all duration-150 ease-[ease] enabled:hover:border-border-strong enabled:hover:bg-bg-raised enabled:hover:text-text-primary disabled:cursor-default"
          onClick={() => stateId && onClickHeader?.(stateId)}
          disabled={!stateId || !onClickHeader}
          tabIndex={stateId ? 0 : -1}
        >
          <span className="text-text-primary">{label}</span>
          {hint && (
            <span className="normal-case tracking-[0.02em] text-text-tertiary">
              {hint}
            </span>
          )}
        </button>
      </div>
      {children}
    </>
  );
}
