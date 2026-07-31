import { Progress } from "@/components/ui/Progress";
import { cn } from "@/lib/ui/cn";

type FillLevel = "normal" | "warning" | "danger";

interface ContextFillIndicatorProps {
  /** Context window fill percentage (0–100). Values outside range are clamped. */
  percentage: number;
  condenseAtNarrow?: boolean;
}

function getLevel(pct: number): FillLevel {
  if (pct >= 80) return "danger";
  if (pct >= 60) return "warning";
  return "normal";
}

// `.mobile-context-fill .context-fill*` overrides (≤768) previously lived as a
// residual in session.css; reattached here via arbitrary parent variants so the
// migrated elements are not half-owned by a surviving legacy descendant selector
// (conventions §1.3 / §8.2). The `.mobile-context-fill` container itself stays in
// session.css (not a `.context-fill*` rule).
const rootClass =
  "flex items-center gap-[6px] max-768:[.mobile-context-fill_&]:flex-1 max-768:[.mobile-context-fill_&]:min-w-0";

const labelClass =
  "text-text-tertiary font-semibold uppercase tracking-[0.06em] text-[0.7rem] shrink-0 " +
  "max-768:[.mobile-context-fill_&]:hidden";

// Outer track geometry — appearance (height, fill, glow) is the Progress recipe.
// The responsive `.mobile-context-fill` overrides live on this wrapper (feature
// code), so the primitive only receives plain `w-full` for its layoutClassName.
const trackWrapClass =
  "w-[60px] shrink-0 max-768:[.mobile-context-fill_&]:flex-1 max-768:[.mobile-context-fill_&]:w-auto";

const fillTone: Record<FillLevel, "accent" | "warning" | "danger"> = {
  normal: "accent",
  warning: "warning",
  danger: "danger",
};

const pctBase =
  "text-[0.7rem] font-semibold tracking-[0.02em] min-w-[2.2em] text-right shrink-0";

const pctLevel: Record<FillLevel, string> = {
  normal: "text-cyan-dim",
  warning: "text-amber-dim",
  danger: "text-red-text",
};

export function ContextFillIndicator({
  percentage,
  condenseAtNarrow = false,
}: ContextFillIndicatorProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
  const level = getLevel(clamped);

  return (
    <div className={rootClass}>
      <span className={labelClass}>Context</span>
      <div
        className={cn(
          trackWrapClass,
          condenseAtNarrow && "@max-[520px]:hidden",
        )}
      >
        <Progress
          value={clamped}
          tone={fillTone[level]}
          layoutClassName="w-full"
          aria-label={`Context window ${clamped}% full`}
        />
      </div>
      <span className={`${pctBase} ${pctLevel[level]}`}>{clamped}%</span>
    </div>
  );
}
