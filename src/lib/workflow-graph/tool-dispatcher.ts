/**
 * Same-Turn Tool Dispatch Contract (design §Same-Turn Tool Dispatch Contract).
 *
 * Production runtime path:
 *
 *   Lane HTTP endpoint (`lane-route-handlers.ts`)
 *     → `resolveLaneHaltReason(getPendingHaltReason, getPendingToolBlock)`
 *
 * Each lane tool call arrives as a separate HTTP request, so the dispatch loop
 * is in the transport layer, not in this module. `resolveLaneHaltReason`
 * supplies pre-dispatch halt and non-terminal blocker inspection at the runtime
 * boundary where the lane endpoints run real work — a pending halt or
 * collaboration block yields a 409 with the exact reason text an agent observes.
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
 * Pre-dispatch halt resolution shared by the lane HTTP endpoints (doc 02 §4:
 * "the new endpoints perform the same check first"). Returns the exact reason
 * text an agent observes today — a terminal halt (`buildHaltMessage`) takes
 * precedence over a non-terminal collaboration blocker
 * (`buildPendingToolBlockMessage`) — or null when the turn may proceed.
 */
export async function resolveLaneHaltReason(
  getPendingHaltReason: GetPendingHaltReasonFn,
  getPendingToolBlock?: GetPendingToolBlockFn,
): Promise<string | null> {
  const haltReason = await getPendingHaltReason();
  if (haltReason) {
    return buildHaltMessage(haltReason);
  }
  const block = await getPendingToolBlock?.();
  if (block) {
    return buildPendingToolBlockMessage(block);
  }
  return null;
}
