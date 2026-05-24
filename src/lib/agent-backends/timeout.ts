export function resolveConfiguredTimeoutMs(
  timeoutSeconds: number | null | undefined,
): number {
  if (timeoutSeconds === null || timeoutSeconds === undefined) return 0;
  return timeoutSeconds * 1000;
}
