/**
 * Claude-specific tool permission policy for the Anthropic SDK.
 *
 * Separates tool permission decisions from the query lifecycle so the
 * conversation runtime can compose them independently.
 *
 * The callback reads per-turn context from a mutable holder, allowing the
 * conversation runtime to update autonomous mode and question handlers
 * between turns without recreating the SDK query.
 */

import { createLogger } from "@/lib/logging";

const logger = createLogger("claude:native-tooling");

// ============================================================
// Types
// ============================================================

export type CanUseToolResult =
  | { behavior: "deny"; message: string }
  | { behavior: "allow"; updatedInput: Record<string, unknown> };

export type CanUseToolFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<CanUseToolResult>;

/**
 * Handler for AskUserQuestion tool invocations.
 * Called when the SDK wants to ask the user a question in non-autonomous mode.
 * Returns the user's answers keyed by question ID.
 */
export type AskUserQuestionHandler = (
  questions: unknown[],
) => Promise<Record<string, string>>;

/**
 * Per-turn context that the canUseTool callback reads at invocation time.
 * The conversation runtime updates this before each turn starts.
 */
export interface CanUseToolTurnContext {
  autonomous: boolean;
  onAskQuestion?: AskUserQuestionHandler;
}

// ============================================================
// Factory
// ============================================================

/**
 * Create a canUseTool callback for the Anthropic SDK QuerySession.
 *
 * The callback reads per-turn context from getTurnContext() at invocation time,
 * so autonomy and question handling can change between turns.
 *
 * Policy:
 * - AskUserQuestion: denied in autonomous mode, delegated to onAskQuestion otherwise
 * - All other tools: allowed (CC runs with bypassPermissions)
 */
export function createCanUseTool(
  getTurnContext: () => CanUseToolTurnContext | null,
): CanUseToolFn {
  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<CanUseToolResult> => {
    if (toolName === "AskUserQuestion") {
      const ctx = getTurnContext();

      if (!ctx || ctx.autonomous) {
        logger.debug("native-tooling.ask_denied", {
          reason: ctx ? "autonomous" : "no_context",
        });
        return {
          behavior: "deny",
          message:
            "Autonomous optimistic mode — make your best judgment and proceed without asking questions.",
        };
      }

      const questions = toolInput.questions;
      if (!questions || !Array.isArray(questions)) {
        return { behavior: "allow", updatedInput: toolInput };
      }

      if (!ctx.onAskQuestion) {
        logger.warn("native-tooling.ask_no_handler", {
          questionCount: questions.length,
        });
        return {
          behavior: "deny",
          message: "No question handler configured — cannot ask user.",
        };
      }

      logger.debug("native-tooling.ask_delegating", {
        questionCount: questions.length,
      });

      const answers = await ctx.onAskQuestion(questions);

      return {
        behavior: "allow",
        updatedInput: { ...toolInput, answers },
      };
    }

    return { behavior: "allow", updatedInput: toolInput };
  };
}
