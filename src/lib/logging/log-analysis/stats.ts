export interface NumberSummary {
  count: number;
  total: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

function sortedFinite(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
}

export function nearestRankQuantile(
  values: readonly number[],
  quantile: number,
): number | null {
  const sorted = sortedFinite(values);
  if (sorted.length === 0) return null;

  const boundedQuantile = Math.min(1, Math.max(0, quantile));
  const rawIndex = Math.ceil(boundedQuantile * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rawIndex));
  return sorted[index] ?? null;
}

export function summarizeNumbers(values: readonly number[]): NumberSummary {
  const sorted = sortedFinite(values);
  if (sorted.length === 0) {
    return {
      count: 0,
      total: 0,
      avg: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    };
  }

  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    total,
    avg: total / sorted.length,
    p50: nearestRankQuantile(sorted, 0.5),
    p95: nearestRankQuantile(sorted, 0.95),
    p99: nearestRankQuantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? null,
  };
}

export function clampTop(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(50, Math.max(1, Math.trunc(value)));
}
