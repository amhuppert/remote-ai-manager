type FillLevel = "normal" | "warning" | "danger";

interface ContextFillIndicatorProps {
  /** Context window fill percentage (0–100). Values outside range are clamped. */
  percentage: number;
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

const trackClass =
  "w-[60px] h-[4px] bg-bg-base rounded-[2px] overflow-hidden shrink-0 " +
  "max-768:[.mobile-context-fill_&]:flex-1 max-768:[.mobile-context-fill_&]:w-auto";

const fillBase =
  "h-full rounded-[2px] [transition:width_0.4s_ease,background_0.3s_ease,box-shadow_0.3s_ease]";

const fillLevel: Record<FillLevel, string> = {
  normal: "bg-cyan [box-shadow:0_0_6px_var(--cyan-glow-strong)]",
  warning: "bg-amber [box-shadow:0_0_6px_var(--amber-glow)]",
  danger: "bg-red [box-shadow:0_0_6px_var(--red-glow)]",
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
}: ContextFillIndicatorProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
  const level = getLevel(clamped);

  return (
    <div className={rootClass}>
      <span className={labelClass}>Context</span>
      <div className={trackClass}>
        <div
          className={`${fillBase} ${fillLevel[level]}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className={`${pctBase} ${pctLevel[level]}`}>{clamped}%</span>
    </div>
  );
}
