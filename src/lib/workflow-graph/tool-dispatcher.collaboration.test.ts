import { describe, expect, it, vi } from "vitest";
import {
  createRequestCollaborationHandler,
  type RequestCollaborationHandlerContext,
} from "./tool-server";
import {
  createTurnDispatcher,
  type PendingToolBlock,
  type ToolUseBlock,
} from "./tool-dispatcher";
import type { ResolvedCollaborationConfig } from "@/lib/workflows/schemas";

function resolvedConfigFixture(): ResolvedCollaborationConfig {
  return {
    secondAgent: {
      value: { backend: "codex", model: "gpt-5.4", reasoningEffort: "medium" },
      source: "global",
    },
    negotiationRounds: { value: 4, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
  };
}

interface BlockRef {
  current: PendingToolBlock | null;
}

function buildRequestCollaborationContext(
  triggerWorkflowCollaboration: ReturnType<typeof vi.fn>,
): RequestCollaborationHandlerContext {
  return {
    executionContextTitle: "Implement",
    parentImplementerTurnId: "turn-1",
    executionContextId: "ctx-implement",
    conversationId: "conv-1",
    executionId: "exec-1",
    iterationIndex: 0,
    resolveCollaborationConfig: () => resolvedConfigFixture(),
    triggerWorkflowCollaboration,
    setPendingHaltReason: async () => undefined,
  };
}

function tu(id: string, name: string, input: unknown = {}): ToolUseBlock {
  return { id, name, input };
}

describe("request_collaboration pending dispatch guard", () => {
  it("starts collaboration, blocks sibling complete_task in the same turn, and returns a started acknowledgement", async () => {
    const blockRef: BlockRef = { current: null };
    const triggerWorkflowCollaboration = vi.fn(async () => {
      blockRef.current = {
        type: "pending_collaboration",
        workflowId: "collab-1",
        contextId: "ctx-implement",
      };
      return { workflowId: "collab-1" };
    });
    const requestHandler = createRequestCollaborationHandler(
      buildRequestCollaborationContext(triggerWorkflowCollaboration),
      { getExecutionLogger: () => null },
    );

    const completeTaskHandler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    const invocationOrder: string[] = [];
    const dispatcher = createTurnDispatcher({
      getPendingHaltReason: async () => null,
      getPendingToolBlock: async () => blockRef.current,
      async invokeHandler(toolUse) {
        invocationOrder.push(toolUse.name);
        if (toolUse.name === "request_collaboration") {
          const result = await requestHandler(toolUse.input);
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
            ...("isError" in result && result.isError
              ? { is_error: true }
              : {}),
          };
        }
        if (toolUse.name === "complete_task") {
          const result = await completeTaskHandler();
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
          };
        }
        throw new Error(`unexpected tool: ${toolUse.name}`);
      },
    });

    const results = await dispatcher.dispatchTurn([
      tu("tu-req", "request_collaboration", { brief: "use Postgres?" }),
      tu("tu-complete", "complete_task", {
        taskSlug: "wire-it",
        summary: "done",
      }),
    ]);

    expect(invocationOrder).toEqual(["request_collaboration"]);
    expect(triggerWorkflowCollaboration).toHaveBeenCalledTimes(1);
    expect(completeTaskHandler).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);

    const requestPayload = JSON.parse(results[0]?.content[0]?.text ?? "{}");
    expect(requestPayload).toEqual({
      status: "started",
      workflowId: "collab-1",
    });
    expect(results[1]).toMatchObject({
      tool_use_id: "tu-complete",
      is_error: true,
    });
    expect(results[1]?.content[0]?.text).toContain(
      "collaboration pending: collab-1",
    );
  });

  it("blocks later-turn tool calls while the collaboration remains pending", async () => {
    const blockRef: BlockRef = { current: null };
    const triggerWorkflowCollaboration = vi.fn(async () => {
      blockRef.current = {
        type: "pending_collaboration",
        workflowId: "collab-2",
        contextId: "ctx-implement",
      };
      return { workflowId: "collab-2" };
    });
    const requestHandler = createRequestCollaborationHandler(
      buildRequestCollaborationContext(triggerWorkflowCollaboration),
      { getExecutionLogger: () => null },
    );

    const completeTaskHandler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    const dispatcher = createTurnDispatcher({
      getPendingHaltReason: async () => null,
      getPendingToolBlock: async () => blockRef.current,
      async invokeHandler(toolUse) {
        if (toolUse.name === "request_collaboration") {
          const result = await requestHandler(toolUse.input);
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
          };
        }
        if (toolUse.name === "complete_task") {
          const result = await completeTaskHandler();
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
          };
        }
        throw new Error(`unexpected tool: ${toolUse.name}`);
      },
    });

    const turn1Results = await dispatcher.dispatchTurn([
      tu("tu-req", "request_collaboration", { brief: "use Postgres?" }),
    ]);
    expect(turn1Results).toHaveLength(1);
    expect(blockRef.current?.workflowId).toBe("collab-2");

    const turn2Results = await dispatcher.dispatchTurn([
      tu("tu-complete", "complete_task", {
        taskSlug: "wire-it",
        summary: "done",
      }),
    ]);

    expect(completeTaskHandler).not.toHaveBeenCalled();
    expect(turn2Results).toHaveLength(1);
    expect(turn2Results[0]).toMatchObject({
      tool_use_id: "tu-complete",
      is_error: true,
    });
    expect(turn2Results[0]?.content[0]?.text).toContain(
      "collaboration pending: collab-2",
    );
  });
});
