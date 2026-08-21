/**
 * Shared helpers used by both the Codex task runner and conversation runtime.
 */

import type { ModelReasoningEffort } from "@openai/codex-sdk";
import type { CodexReasoningEffort } from "@/lib/agent-backends/schemas";

/**
 * Widen a CC reasoning-effort value to the Codex SDK's `ModelReasoningEffort`.
 *
 * The SDK's type only lists `minimal`→`xhigh` (through 0.144.0), but the Codex
 * CLI accepts the GPT-5.6 Sol `max` and `ultra` levels — the SDK serializes this
 * field verbatim into `--config model_reasoning_effort="…"`, which is exactly how
 * those levels are configured. Callers validate the value against
 * `codexReasoningEffortSchema` (and the per-model level table) before it reaches
 * here, so bridging past the SDK's stale type is sound.
 */
export function toSdkModelReasoningEffort(
  effort: CodexReasoningEffort,
): ModelReasoningEffort {
  return effort as ModelReasoningEffort;
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
