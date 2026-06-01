/**
 * Integration tests for Task 5.2 — orchestrator same-turn and cross-turn halt.
 *
 * Wires the real `createRequestCollaborationHandler` into a real
 * `createTurnDispatcher` and a stubbed `complete_task` handler. The shared
 * `pendingHaltReason` state is a mutable ref written by the request-
 * collaboration handler (via DI'd `setPendingHaltReason`) and read by the
 * dispatcher (via DI'd `getPendingHaltReason`).
 *
 * Failure modes these tests catch:
 *   - The pre-dispatch halt check is removed → `complete_task` runs after
 *     `request_collaboration` set the halt.
 *   - Per-turn tool_use blocks are parallelized → both handlers run before
 *     the halt-reason ref is observed.
 *   - The halt-reason ref does not persist across turns → cross-turn check
 *     fails to fire.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRequestCollaborationHandler,
  type RequestCollaborationHandlerContext,
} from "./tool-server";
import { createTurnDispatcher, type ToolUseBlock } from "./tool-dispatcher";
import { IterationHaltedError } from "./iteration-orchestrator";
import type {
  GraphWorkflowHaltReason,
  ResolvedCollaborationConfig,
  WorkflowCollaborationResult,
} from "@/lib/workflows/schemas";

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

function buildNonConvergedResult(): WorkflowCollaborationResult {
  return {
    status: "objective_disagreement",
    finalAnswer: null,
    openConflicts: [
      {
        rejectingAgent: "agent_two",
        disputedPoint: "Should we adopt Postgres for the metrics store?",
        severity: "major",
        category: "objective",
      },
    ],
  };
}

interface HaltRef {
  current: GraphWorkflowHaltReason | null;
}

function buildRequestCollaborationContext(
  haltRef: HaltRef,
  envelopeStub: ReturnType<typeof vi.fn>,
): RequestCollaborationHandlerContext {
  return {
    executionContextTitle: "Implement",
    parentImplementerTurnId: "turn-1",
    executionContextId: "ctx-implement",
    conversationId: "conv-1",
    executionId: "exec-1",
    iterationIndex: 0,
    resolveCollaborationConfig: () => resolvedConfigFixture(),
    startWorkflowCollaboration: envelopeStub,
    setPendingHaltReason: async (reason) => {
      haltRef.current = reason;
    },
  };
}

function tu(id: string, name: string, input: unknown = {}): ToolUseBlock {
  return { id, name, input };
}

describe("Task 5.2 — orchestrator same-turn / cross-turn halt integration", () => {
  describe("same-turn dispatch with [request_collaboration, complete_task]", () => {
    it("invokes the request handler, sets pendingHaltReason, skips complete_task, and throws IterationHaltedError with synthetic results for the skipped block", async () => {
      const haltRef: HaltRef = { current: null };
      const envelopeStub = vi.fn(async () => ({
        result: buildNonConvergedResult(),
        roundsConsumed: 2,
      }));
      const requestHandler = createRequestCollaborationHandler(
        buildRequestCollaborationContext(haltRef, envelopeStub),
        { getExecutionLogger: () => null },
      );

      const completeTaskHandler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));

      const invocationOrder: string[] = [];

      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => haltRef.current,
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

      let thrown: IterationHaltedError | null = null;
      let returnedResults: unknown = null;
      try {
        returnedResults = await dispatcher.dispatchTurn([
          tu("tu-req", "request_collaboration", { brief: "use Postgres?" }),
          tu("tu-complete", "complete_task", {
            taskSlug: "wire-it",
            summary: "done",
          }),
        ]);
      } catch (error) {
        thrown = error as IterationHaltedError;
      }

      // Same-turn ordering: real request handler ran exactly once, the
      // complete_task handler was never reached.
      expect(invocationOrder).toEqual(["request_collaboration"]);
      expect(envelopeStub).toHaveBeenCalledTimes(1);
      expect(completeTaskHandler).not.toHaveBeenCalled();
      expect(returnedResults).toBeNull();

      // Pre-dispatch check at i=1 saw the halt that the handler wrote at i=0.
      expect(thrown).toBeInstanceOf(IterationHaltedError);
      expect(thrown?.haltReason.type).toBe("collaboration_failure");
      if (thrown?.haltReason.type === "collaboration_failure") {
        expect(thrown.haltReason.status).toBe("objective_disagreement");
        expect(thrown.haltReason.brief).toBe("use Postgres?");
        expect(thrown.haltReason.executionContextId).toBe("ctx-implement");
        expect(thrown.haltReason.conversationId).toBe("conv-1");
      }

      // Synthetic result is emitted for the skipped complete_task block.
      expect(thrown?.syntheticToolResults).toHaveLength(1);
      const synthetic = thrown?.syntheticToolResults?.[0];
      expect(synthetic?.tool_use_id).toBe("tu-complete");
      expect(synthetic?.is_error).toBe(true);
      expect(synthetic?.content[0]?.text).toContain("collaboration_failure");
    });

    it("delivers the structured failure result to the agent for the request_collaboration block before the halt is observed", async () => {
      const haltRef: HaltRef = { current: null };
      const envelopeStub = vi.fn(async () => ({
        result: buildNonConvergedResult(),
        roundsConsumed: 2,
      }));
      const requestHandler = createRequestCollaborationHandler(
        buildRequestCollaborationContext(haltRef, envelopeStub),
        { getExecutionLogger: () => null },
      );

      let capturedRequestResultText: string | null = null;

      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => haltRef.current,
        async invokeHandler(toolUse) {
          if (toolUse.name === "request_collaboration") {
            const result = await requestHandler(toolUse.input);
            const text = result.content[0]?.text ?? "";
            capturedRequestResultText = text;
            return {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: result.content,
              ...("isError" in result && result.isError
                ? { is_error: true }
                : {}),
            };
          }
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: [{ type: "text", text: "noop" }],
          };
        },
      });

      try {
        await dispatcher.dispatchTurn([
          tu("tu-req", "request_collaboration", { brief: "use Postgres?" }),
          tu("tu-complete", "complete_task", {
            taskSlug: "wire-it",
            summary: "done",
          }),
        ]);
      } catch {
        // expected to throw IterationHaltedError
      }

      expect(capturedRequestResultText).not.toBeNull();
      const parsed = JSON.parse(capturedRequestResultText ?? "{}");
      expect(parsed.status).toBe("objective_disagreement");
      expect(parsed.finalAnswer).toBeNull();
      expect(Array.isArray(parsed.openConflicts)).toBe(true);
      expect(parsed.openConflicts.length).toBeGreaterThan(0);
    });
  });

  describe("cross-turn dispatch: request_collaboration alone, then complete_task in a later turn", () => {
    it("turn 1 returns the structured failure result without throwing; turn 2 fires the pre-dispatch check and never invokes complete_task", async () => {
      const haltRef: HaltRef = { current: null };
      const envelopeStub = vi.fn(async () => ({
        result: buildNonConvergedResult(),
        roundsConsumed: 1,
      }));
      const requestHandler = createRequestCollaborationHandler(
        buildRequestCollaborationContext(haltRef, envelopeStub),
        { getExecutionLogger: () => null },
      );

      const completeTaskHandler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));

      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => haltRef.current,
        async invokeHandler(toolUse) {
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

      // Turn 1: request_collaboration only. No throw — the handler returns
      // the structured failure and the dispatcher emits exactly one result.
      const turn1Results = await dispatcher.dispatchTurn([
        tu("tu-req", "request_collaboration", { brief: "use Postgres?" }),
      ]);
      expect(turn1Results).toHaveLength(1);
      expect(turn1Results[0]?.tool_use_id).toBe("tu-req");
      // Halt ref was written during turn 1.
      expect(haltRef.current).not.toBeNull();
      expect(haltRef.current?.type).toBe("collaboration_failure");

      // Turn 2: complete_task only. Pre-dispatch check fires from the halt
      // that turn 1 persisted on the ref — handler never runs.
      let thrown: IterationHaltedError | null = null;
      try {
        await dispatcher.dispatchTurn([
          tu("tu-complete", "complete_task", {
            taskSlug: "wire-it",
            summary: "done",
          }),
        ]);
      } catch (error) {
        thrown = error as IterationHaltedError;
      }

      expect(completeTaskHandler).not.toHaveBeenCalled();
      expect(thrown).toBeInstanceOf(IterationHaltedError);
      expect(thrown?.haltReason.type).toBe("collaboration_failure");
      expect(thrown?.syntheticToolResults).toHaveLength(1);
      expect(thrown?.syntheticToolResults?.[0]?.tool_use_id).toBe(
        "tu-complete",
      );
      expect(thrown?.syntheticToolResults?.[0]?.is_error).toBe(true);
    });
  });
});
