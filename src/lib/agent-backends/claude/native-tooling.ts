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
const denialLogger = createLogger("mcp.tool-denial");

// ============================================================
// Types
// ============================================================

export type CanUseToolResult =
  | { behavior: "deny"; message: string; interrupt?: boolean }
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

/**
 * Resolver-backed lookup consulted by the Claude canUseTool fallback filter.
 * Tests supply deterministic implementations so the permission policy can be
 * exercised without booting the resolver.
 */
export interface McpFilterLookup {
  isToolAllowed(input: {
    conversationId: string;
    serverKey: string;
    toolName: string;
  }):
    | { allowed: true }
    | {
        allowed: false;
        reason: "server-disabled" | "tool-disabled" | "tool-not-in-allowlist";
      };
}

export interface McpFilterDeps {
  conversationId: string;
  mcpFilter: McpFilterLookup;
}

// ============================================================
// Factory
// ============================================================

const MCP_TOOL_DENIAL_MESSAGE = "Tool disabled by MCP configuration";

/** SDK-emitted MCP tool names follow `mcp__<serverKey>__<toolName>`. */
function parseMcpToolName(
  toolName: string,
): { serverKey: string; toolName: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const separatorIdx = rest.indexOf("__");
  if (separatorIdx <= 0 || separatorIdx === rest.length - 2) return null;
  return {
    serverKey: rest.slice(0, separatorIdx),
    toolName: rest.slice(separatorIdx + 2),
  };
}

/**
 * Create a canUseTool callback for the Anthropic SDK QuerySession.
 *
 * The callback reads per-turn context from getTurnContext() at invocation time,
 * so autonomy and question handling can change between turns.
 *
 * Policy:
 * - MCP filter (when supplied): first check, denies via sanitized deny response
 *   without interrupting the turn.
 * - AskUserQuestion: denied in autonomous mode, delegated to onAskQuestion otherwise.
 * - All other tools: allowed (CC runs with bypassPermissions).
 */
export function createCanUseTool(
  getTurnContext: () => CanUseToolTurnContext | null,
  mcpFilterDeps?: McpFilterDeps,
): CanUseToolFn {
  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<CanUseToolResult> => {
    if (mcpFilterDeps) {
      const parsed = parseMcpToolName(toolName);
      if (parsed) {
        const decision = mcpFilterDeps.mcpFilter.isToolAllowed({
          conversationId: mcpFilterDeps.conversationId,
          serverKey: parsed.serverKey,
          toolName: parsed.toolName,
        });
        if (!decision.allowed) {
          denialLogger.info("mcp.tool-denial", {
            conversationId: mcpFilterDeps.conversationId,
            serverKey: parsed.serverKey,
            toolName: parsed.toolName,
            reason: decision.reason,
          });
          return {
            behavior: "deny",
            message: MCP_TOOL_DENIAL_MESSAGE,
            interrupt: false,
          };
        }
      }
    }

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
