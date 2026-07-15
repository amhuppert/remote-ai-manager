/**
 * Claude sub-agent suppression strategy verification.
 *
 * The installed `@anthropic-ai/claude-agent-sdk` `Settings` type does not
 * expose a typed per-agent disable map. The only deterministic, in-SDK
 * suppression path is the `canUseTool` permission callback (`Options.canUseTool`):
 * Claude routes every sub-agent invocation through the Task tool, and the
 * callback receives the tool input — including `subagent_type` — before the
 * tool fires. Denying the call returns a message to the model and prevents
 * the sub-agent from running.
 *
 * Apply point: because `Options.canUseTool` is bound at session creation, this
 * strategy can only change behavior for new conversations (no idle-live-apply
 * path exists for swapping the callback mid-session). The metadata registry
 * records this as `applySemantics: "next-conversation"`. Plugin-level disable
 * remains the only way to remove a plugin-contributed agent from a live
 * session — via `reloadPlugins()` after toggling `enabledPlugins`.
 */

import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeAgentSuppressionStrategy {
  kind: "permission-layer";
  /** Apply point — when this suppression takes effect. */
  applyPoint: "next-conversation";
  /** Tool names the suppression layer must intercept. */
  interceptedToolNames: readonly string[];
}

export const CLAUDE_AGENT_SUPPRESSION_STRATEGY: ClaudeAgentSuppressionStrategy =
  {
    kind: "permission-layer",
    applyPoint: "next-conversation",
    interceptedToolNames: ["Task"],
  };

export interface ClaudeAgentSuppressionDecisionInput {
  toolName: string;
  input: Record<string, unknown>;
  disabledAgentNames: ReadonlySet<string>;
}

/**
 * Pure decision function: returns the permission result for a single tool
 * invocation under the suppression strategy. Exported so resolver/runtime
 * tests can exercise the logic without constructing an SDK session.
 */
export function buildClaudeAgentSuppressionDecision(
  args: ClaudeAgentSuppressionDecisionInput,
): PermissionResult {
  if (
    !CLAUDE_AGENT_SUPPRESSION_STRATEGY.interceptedToolNames.includes(
      args.toolName,
    )
  ) {
    return { behavior: "allow" };
  }

  const subagentType = args.input["subagent_type"];
  if (typeof subagentType !== "string" || subagentType.length === 0) {
    return { behavior: "allow" };
  }

  if (!args.disabledAgentNames.has(subagentType)) {
    return { behavior: "allow" };
  }

  return {
    behavior: "deny",
    message: `Sub-agent "${subagentType}" is disabled by Command Center capability configuration; this Task invocation cannot run.`,
  };
}

export interface ComposeClaudeAgentCanUseToolInput {
  disabledAgentNames: ReadonlySet<string>;
  /** Optional pre-existing `canUseTool` chain — usually the project's MCP
   * permission gate. The composed callback denies a Task invocation on a
   * disabled agent before delegating to this inner handler. */
  inner?: CanUseTool;
}

/**
 * Compose a `CanUseTool` callback suitable for `Options.canUseTool`. The
 * suppression layer takes precedence over the inner gate — once we decide to
 * deny a disabled agent invocation, the inner callback is never consulted.
 */
export function composeClaudeAgentCanUseTool(
  args: ComposeClaudeAgentCanUseToolInput,
): CanUseTool {
  return async (toolName, input, options) => {
    const decision = buildClaudeAgentSuppressionDecision({
      toolName,
      input,
      disabledAgentNames: args.disabledAgentNames,
    });
    if (decision.behavior === "deny") {
      return decision;
    }
    if (args.inner) {
      return args.inner(toolName, input, options);
    }
    return { behavior: "allow" };
  };
}
