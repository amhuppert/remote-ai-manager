import { formatUsd } from "./present";

/**
 * What a run or context cost. Once a seat's conversation is gone its spending
 * is unknown, so the total is what is still known, and says so.
 */
export function Cost({
  usd,
  complete,
}: {
  usd: number | null;
  complete: boolean;
}) {
  if (complete || usd === null) return <>{formatUsd(usd)}</>;
  return (
    <span
      aria-label={`at least ${formatUsd(usd)}`}
      title="A seat's conversation is gone, so what it spent is not counted"
    >
      {formatUsd(usd)}+
    </span>
  );
}
