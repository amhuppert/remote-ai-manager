interface ContextFillIndicatorProps {
  /** Context window fill percentage (0–100). Values outside range are clamped. */
  percentage: number;
}

function getColorClass(pct: number): string {
  if (pct >= 80) return "context-fill--danger";
  if (pct >= 60) return "context-fill--warning";
  return "context-fill--normal";
}

export function ContextFillIndicator({
  percentage,
}: ContextFillIndicatorProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
  const colorClass = getColorClass(clamped);

  return (
    <div className={`context-fill ${colorClass}`}>
      <span className="context-fill__label">Context</span>
      <div className="context-fill__bar-track">
        <div
          className="context-fill__bar-fill"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="context-fill__pct">{clamped}%</span>
    </div>
  );
}
