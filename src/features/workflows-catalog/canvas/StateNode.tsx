"use client";

import { cn } from "@/lib/ui/cn";
import type { StateNodeKind, StateStatus } from "../machine-spec-types";
import type { NodeProps } from "./types";

const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT_BASE = 56;
const DEFAULT_HEIGHT_WITH_INVOKE = 84;

/** Kind → fill. `selected` overrides this to elevated (see below). */
const KIND_BG: Record<StateNodeKind, string> = {
  atomic: "bg-bg-raised",
  history: "bg-bg-raised",
  compound: "bg-bg-surface",
  final: "bg-bg-base",
  transient: "bg-[linear-gradient(180deg,var(--bg-elevated),var(--bg-raised))]",
};

/** Status → node border color (only success/warning/failure tint the border). */
const STATUS_BORDER: Record<StateStatus, string> = {
  neutral: "border-border-default",
  initial: "border-border-default",
  success: "border-green-dim",
  warning: "border-amber-dim",
  failure: "border-red-dim",
};

/** Status → status dot fill. */
const STATUS_DOT: Record<StateStatus, string> = {
  neutral: "bg-text-tertiary",
  initial: "bg-cyan",
  success: "bg-green",
  warning: "bg-amber",
  failure: "bg-red",
};

/**
 * A single state in a machine diagram. Rendered as an absolutely-positioned
 * HTML node so it can use full CSS (gradients, hover, focus rings) while the
 * SVG edge layer underneath stays simple.
 *
 * The static (non-hover) appearance is composed from union-keyed maps; the
 * `hover:` utilities sit on top and win by `:hover` specificity, matching the
 * legacy `.mc-node:hover` rule which overrides every status/selection border.
 */
export default function StateNode({
  id,
  label,
  kind,
  status,
  x,
  y,
  width,
  height,
  invokes,
  selected,
  related,
  onClick,
}: NodeProps): React.JSX.Element {
  const hasInvokes = (invokes?.length ?? 0) > 0;
  const w = width ?? DEFAULT_WIDTH;
  const h =
    height ?? (hasInvokes ? DEFAULT_HEIGHT_WITH_INVOKE : DEFAULT_HEIGHT_BASE);

  const effectiveStatus: StateStatus = status ?? "neutral";

  const radius = kind === "final" ? "rounded-full" : "rounded-md";
  const borderStyle = kind === "transient" ? "border-dashed" : "border-solid";
  const borderColor = selected
    ? "border-cyan"
    : related
      ? "border-cyan-dim"
      : STATUS_BORDER[effectiveStatus];
  const bg = selected ? "bg-bg-elevated" : KIND_BG[kind];
  const shadow = selected
    ? "shadow-[0_0_0_1px_var(--cyan),0_0_18px_var(--cyan-glow)]"
    : "shadow-[0_1px_0_var(--cc-shadow-soft)]";

  const dotFill = selected ? "bg-cyan" : STATUS_DOT[effectiveStatus];
  const dotGlow =
    selected || effectiveStatus === "initial"
      ? "shadow-[0_0_8px_var(--cyan-glow-strong)]"
      : "";

  const glyphColor =
    effectiveStatus === "success"
      ? "text-green"
      : effectiveStatus === "failure"
        ? "text-red"
        : kind === "final"
          ? "text-text-secondary"
          : "text-text-tertiary";

  return (
    <button
      type="button"
      className={cn(
        "pointer-events-auto absolute flex cursor-pointer flex-col justify-center gap-[6px] border px-[14px] py-[10px] text-left font-mono text-[0.85rem] text-text-primary transition-all duration-150 ease-[ease] hover:-translate-y-[1px] hover:border-border-strong hover:bg-bg-elevated",
        radius,
        borderStyle,
        borderColor,
        bg,
        shadow,
      )}
      data-state-id={id}
      style={{
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      }}
      onClick={() => onClick?.(id)}
      aria-pressed={selected}
    >
      <div className="flex items-center gap-[8px]">
        <span
          className={cn(
            "h-[6px] w-[6px] shrink-0 rounded-full",
            dotFill,
            dotGlow,
          )}
          aria-hidden="true"
        />
        <span className="flex-1 font-medium tracking-[0.01em]">{label}</span>
        {kind === "final" && (
          <span
            className={cn("text-[0.95rem]", glyphColor)}
            aria-label="final state"
          >
            ◉
          </span>
        )}
        {kind === "transient" && (
          <span
            className={cn("text-[0.95rem]", glyphColor)}
            aria-label="transient state"
          >
            ⤳
          </span>
        )}
      </div>
      {hasInvokes && (
        <div className="flex flex-wrap gap-[4px]">
          {invokes!.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-[4px] rounded-sm border border-solid border-violet-dim bg-violet-glow px-[6px] py-[1px] font-mono text-[0.7rem] tracking-[0.02em] text-violet"
            >
              <span className="text-[0.7rem]" aria-hidden="true">
                ▸
              </span>
              {name}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
