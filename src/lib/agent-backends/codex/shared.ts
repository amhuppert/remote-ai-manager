/**
 * Shared helpers used by both the Codex task runner and conversation runtime.
 */

import type { ModelReasoningEffort } from "@openai/codex-sdk";
import type { CodexReasoningEffort } from "@/lib/agent-backends/schemas";

/** Converts a validated CC reasoning-effort value to the SDK representation. */
export function toSdkModelReasoningEffort(
  effort: CodexReasoningEffort,
): ModelReasoningEffort {
  return effort;
}

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

/**
 * Default per-turn inactivity bound for codex turns and task runs. Single
 * source for the descriptor metadata literal and the task runner's fallback
 * when a request carries no explicit `stallTimeoutMs` (incident 2026-07-18:
 * a codex model turn hung silently for 9h37m with no bound).
 */
export const CODEX_DEFAULT_STALL_TIMEOUT_MS = 20 * 60 * 1000;
