export function resolveConfiguredTimeoutMs(
  timeoutMs: number | null | undefined,
): number {
  if (timeoutMs === null || timeoutMs === undefined) return 0;
  return timeoutMs;
}
