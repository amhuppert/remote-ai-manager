/**
 * Extract a human-readable error message from an unknown thrown value.
 *
 * Replaces the repeated pattern:
 *   err instanceof Error ? err.message : String(err)
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
