/**
 * Shared helpers used by both the Codex task runner and conversation runtime.
 */

/** Converts an env record (with possible `undefined` values) to a plain string record. */
export function toStringEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
