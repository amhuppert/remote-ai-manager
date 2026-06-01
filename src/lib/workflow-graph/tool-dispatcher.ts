/**
 * Same-Turn Tool Dispatch Contract (design §Same-Turn Tool Dispatch Contract).
 *
 * Production runtime path:
 *
 *   SDK MCP transport (serializes individual tool_use requests one at a time)
 *     → `wrapMcpHandlerWithHaltCheck(getPendingHaltReason, handler, getPendingToolBlock)`
 *
 * The MCP transport already serializes each tool_use as a separate request to
 * the registered MCP handler, so the dispatch loop is in the transport layer,
 * not in this module. `wrapMcpHandlerWithHaltCheck` supplies pre-dispatch
 * halt and non-terminal blocker inspection at the runtime boundary where
 * production tool handlers are invoked — see `tool-server.ts` for every
 * registered handler being wrapped this way.
 *
 * `createTurnDispatcher` in this file is a TEST HARNESS that reproduces the
 * contract behavior in isolation: it walks a synthetic `tool_use[]` list
 * sequentially, calls the pre-dispatch guards before each invocation, and
 * emits synthetic `tool_result` blocks for the remaining sibling tool_use
 * blocks when a halt or blocker fires mid-turn. This is what backs the
 * dispatch integration tests. It is
 * intentionally separate from the production path because the SDK gives us no
 * application-level list of tool_use blocks to walk over; the transport
 * already provides the serialization the contract asserts.
 */

import type { GraphWorkflowHaltReason } from "@/lib/workflows/schemas";
import { IterationHaltedError } from "./iteration-orchestrator";

export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: Array<{ type: "text"; text: string }>;
  is_error?: boolean;
}

export type GetPendingHaltReasonFn =
  () => Promise<GraphWorkflowHaltReason | null>;

export interface PendingToolBlock {
  type: "pending_collaboration";
  workflowId: string;
  contextId: string;
}

export type GetPendingToolBlockFn = () => Promise<PendingToolBlock | null>;

export interface TurnDispatcherDeps {
  getPendingHaltReason: GetPendingHaltReasonFn;
  getPendingToolBlock?: GetPendingToolBlockFn;
  invokeHandler(toolUse: ToolUseBlock): Promise<ToolResultBlock>;
}

export interface TurnDispatcher {
  dispatchTurn(toolUses: ToolUseBlock[]): Promise<ToolResultBlock[]>;
}

/**
 * Canonical halt message used by every same-turn enforcement path so the
 * production wrapper and the test dispatcher cannot drift. R5.3 specifies the
 * exact text the agent observes (`"iteration halted: <haltReason.type>"`)
 * because the iteration orchestrator's between-turn check compares against
 * this prefix when deciding whether to short-circuit follow-up turns.
 */
export function buildHaltMessage(haltReason: GraphWorkflowHaltReason): string {
  return `iteration halted: ${haltReason.type}`;
}

export function buildPendingToolBlockMessage(block: PendingToolBlock): string {
  if (block.type === "pending_collaboration") {
    return `collaboration pending: ${block.workflowId}`;
  }
  return "tool dispatch blocked";
}

function buildSyntheticHaltResult(
  toolUseId: string,
  haltReason: GraphWorkflowHaltReason,
): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      {
        type: "text",
        text: buildHaltMessage(haltReason),
      },
    ],
    is_error: true,
  };
}

function buildSyntheticBlockResult(
  toolUseId: string,
  block: PendingToolBlock,
): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      {
        type: "text",
        text: buildPendingToolBlockMessage(block),
      },
    ],
    is_error: true,
  };
}

export function createTurnDispatcher(deps: TurnDispatcherDeps): TurnDispatcher {
  async function dispatchTurn(
    toolUses: ToolUseBlock[],
  ): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];

    for (let i = 0; i < toolUses.length; i++) {
      const toolUse = toolUses[i];
      if (!toolUse) {
        continue;
      }

      const haltReason = await deps.getPendingHaltReason();
      if (haltReason) {
        const synthetic: ToolResultBlock[] = [];
        for (let j = i; j < toolUses.length; j++) {
          const remaining = toolUses[j];
          if (!remaining) {
            continue;
          }
          synthetic.push(buildSyntheticHaltResult(remaining.id, haltReason));
        }
        throw new IterationHaltedError(haltReason, synthetic);
      }

      const block = await deps.getPendingToolBlock?.();
      if (block) {
        for (let j = i; j < toolUses.length; j++) {
          const remaining = toolUses[j];
          if (!remaining) {
            continue;
          }
          results.push(buildSyntheticBlockResult(remaining.id, block));
        }
        break;
      }

      const result = await deps.invokeHandler(toolUse);
      results.push(result);
    }

    return results;
  }

  return { dispatchTurn };
}

/**
 * Production-path pre-dispatch guard for MCP tool handlers.
 *
 * This is the runtime enforcement of the Same-Turn Tool Dispatch Contract
 * (see file header). It is applied per-handler at registration time in
 * `tool-server.ts` so every registered tool inspects terminal halt state and
 * non-terminal collaboration blockers before doing real work. The MCP
 * transport already serializes sibling tool_use blocks one at a time, so the
 * per-handler pre-dispatch check is sufficient to prevent additional tool
 * mutations after a halt or collaboration request has been recorded. After
 * the turn ends, the iteration orchestrator observes the same persisted state
 * and either unwinds for a halt or waits for collaboration completion.
 *
 * The synthetic `tool_result` content uses the exact text format produced by
 * `buildHaltMessage` (`"iteration halted: <haltReason.type>"`) so the
 * production path and the `createTurnDispatcher` test harness are guaranteed
 * to emit byte-identical halt messages — the same prefix the agent sees in
 * the test integration paths.
 */
export type McpHandlerResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function wrapMcpHandlerWithHaltCheck<I>(
  getPendingHaltReason: GetPendingHaltReasonFn,
  handler: (input: I) => Promise<McpHandlerResult>,
  getPendingToolBlock?: GetPendingToolBlockFn,
): (input: I) => Promise<McpHandlerResult> {
  return async (input) => {
    const haltReason = await getPendingHaltReason();
    if (haltReason) {
      return {
        content: [
          {
            type: "text",
            text: buildHaltMessage(haltReason),
          },
        ],
        isError: true,
      };
    }
    const block = await getPendingToolBlock?.();
    if (block) {
      return {
        content: [
          {
            type: "text",
            text: buildPendingToolBlockMessage(block),
          },
        ],
        isError: true,
      };
    }
    return handler(input);
  };
}
