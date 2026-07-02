/**
 * Pure helper functions for extracting and computing context window fill data
 * from Agent SDK messages.
 */

/**
 * Sum input tokens from an SDK usage object.
 * This represents the current context size sent to the model.
 */
export function extractContextTokens(
  usage:
    | {
        input_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      }
    | undefined,
): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Extract the context window max from the SDK's per-model usage breakdown.
 * Selects the largest contextWindow across all model entries, independent of
 * Record insertion order. On a multi-model turn (e.g. a sub-agent alongside the
 * main conversation model) the main conversation model has the largest window,
 * so the max reflects the true window the utilization percentage is measured
 * against. Returns null when there are no model entries.
 */
export function extractContextWindow(
  modelUsage: Record<string, { contextWindow: number }> | undefined,
): number | null {
  if (!modelUsage) return null;
  const windows = Object.values(modelUsage).map((entry) => entry.contextWindow);
  if (windows.length === 0) return null;
  return Math.max(...windows);
}

/**
 * Compute the context fill percentage from token counts.
 * Returns null if either input is null or contextWindowMax is 0.
 */
export function computeContextFillPercent(
  contextTokens: number | null,
  contextWindowMax: number | null,
): number | null {
  if (
    contextTokens == null ||
    contextWindowMax == null ||
    contextWindowMax === 0
  )
    return null;
  return (contextTokens / contextWindowMax) * 100;
}
