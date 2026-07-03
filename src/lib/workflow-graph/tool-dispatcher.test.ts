/**
 * Tests for the same-turn tool dispatch contract (Task 4.2).
 *
 * The dispatcher serializes tool_use handler invocation within a single
 * assistant turn and, before each handler, reads `pendingHaltReason` from
 * execution state. When non-null, it emits a synthetic tool_result for the
 * current and remaining tool_use blocks, then throws IterationHaltedError
 * so the iteration concludes with the seeded halt reason.
 */

import { describe, expect, it, vi } from "vitest";
import { IterationHaltedError } from "./iteration-orchestrator";
import {
  buildHaltMessage,
  createTurnDispatcher,
  type ToolUseBlock,
} from "./tool-dispatcher";
import type { GraphWorkflowHaltReason } from "@/lib/workflows/schemas";

const HALT_REASON: GraphWorkflowHaltReason = {
  type: "collaboration_failure",
  status: "objective_disagreement",
  brief: "Should we adopt Postgres?",
  executionContextId: "context-implement",
  conversationId: "conv-abc",
  summary:
    "collaboration ended with status=objective_disagreement; 1 open conflict",
};

function block(id: string, name: string): ToolUseBlock {
  return { id, name, input: {} };
}

describe("createTurnDispatcher", () => {
  describe("happy path: no pending halt", () => {
    it("invokes every handler sequentially in the order of the tool_use blocks", async () => {
      const invocationOrder: string[] = [];
      const invokeHandler = vi.fn(async (toolUse: ToolUseBlock) => {
        invocationOrder.push(toolUse.id);
        return {
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: [{ type: "text" as const, text: `ok:${toolUse.id}` }],
        };
      });

      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => null,
        invokeHandler,
      });

      const results = await dispatcher.dispatchTurn([
        block("tu-1", "complete_task"),
        block("tu-2", "upsert_shared_document"),
        block("tu-3", "complete_task"),
      ]);

      expect(invocationOrder).toEqual(["tu-1", "tu-2", "tu-3"]);
      expect(results).toHaveLength(3);
      expect(results[0]?.tool_use_id).toBe("tu-1");
      expect(results[2]?.content[0]?.text).toBe("ok:tu-3");
    });

    it("awaits each handler before starting the next (no parallel dispatch)", async () => {
      const events: string[] = [];
      const invokeHandler = vi.fn(async (toolUse: ToolUseBlock) => {
        events.push(`start:${toolUse.id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`end:${toolUse.id}`);
        return {
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: [{ type: "text" as const, text: "ok" }],
        };
      });

      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => null,
        invokeHandler,
      });

      await dispatcher.dispatchTurn([block("tu-1", "a"), block("tu-2", "b")]);

      expect(events).toEqual([
        "start:tu-1",
        "end:tu-1",
        "start:tu-2",
        "end:tu-2",
      ]);
    });
  });

  describe("pre-dispatch halt check with halt pre-seeded", () => {
    it("never invokes any handler and emits a synthetic tool_result for every tool_use block", async () => {
      const invokeHandler = vi.fn();
      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => HALT_REASON,
        invokeHandler,
      });

      let thrown: unknown = null;
      try {
        await dispatcher.dispatchTurn([
          block("tu-1", "request_collaboration"),
          block("tu-2", "complete_task"),
          block("tu-3", "upsert_shared_document"),
        ]);
      } catch (error) {
        thrown = error;
      }

      expect(invokeHandler).not.toHaveBeenCalled();
      expect(thrown).toBeInstanceOf(IterationHaltedError);
      const iterationHalt = thrown as IterationHaltedError;
      expect(iterationHalt.haltReason).toEqual(HALT_REASON);
    });

    it("records exactly one synthetic tool_result per skipped tool_use block on the thrown error", async () => {
      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => HALT_REASON,
        invokeHandler: vi.fn(),
      });

      let thrown: IterationHaltedError | null = null;
      try {
        await dispatcher.dispatchTurn([
          block("tu-1", "request_collaboration"),
          block("tu-2", "complete_task"),
          block("tu-3", "upsert_shared_document"),
        ]);
      } catch (error) {
        thrown = error as IterationHaltedError;
      }

      expect(thrown).not.toBeNull();
      expect(thrown?.syntheticToolResults).toHaveLength(3);
      const ids = thrown?.syntheticToolResults?.map((r) => r.tool_use_id);
      expect(ids).toEqual(["tu-1", "tu-2", "tu-3"]);
      const allErrored = thrown?.syntheticToolResults?.every(
        (r) => r.is_error === true,
      );
      expect(allErrored).toBe(true);
      const allMessage = thrown?.syntheticToolResults?.every((r) =>
        r.content[0]?.text.includes("collaboration_failure"),
      );
      expect(allMessage).toBe(true);
    });
  });

  describe("halt set mid-turn after handler N", () => {
    it("invokes handler N, then skips remaining handlers and emits synthetic results", async () => {
      let haltReason: GraphWorkflowHaltReason | null = null;
      const invocationOrder: string[] = [];
      const invokeHandler = vi.fn(async (toolUse: ToolUseBlock) => {
        invocationOrder.push(toolUse.id);
        if (toolUse.id === "tu-1") {
          haltReason = HALT_REASON;
        }
        return {
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: [{ type: "text" as const, text: "ok" }],
        };
      });
      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => haltReason,
        invokeHandler,
      });

      let thrown: IterationHaltedError | null = null;
      try {
        await dispatcher.dispatchTurn([
          block("tu-1", "request_collaboration"),
          block("tu-2", "complete_task"),
          block("tu-3", "upsert_shared_document"),
        ]);
      } catch (error) {
        thrown = error as IterationHaltedError;
      }

      expect(invocationOrder).toEqual(["tu-1"]);
      expect(thrown).toBeInstanceOf(IterationHaltedError);
      expect(thrown?.syntheticToolResults).toHaveLength(2);
      const ids = thrown?.syntheticToolResults?.map((r) => r.tool_use_id);
      expect(ids).toEqual(["tu-2", "tu-3"]);
    });
  });

  describe("halt reason propagation", () => {
    it("uses the seeded halt reason verbatim on the thrown IterationHaltedError", async () => {
      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => HALT_REASON,
        invokeHandler: vi.fn(),
      });

      let thrown: IterationHaltedError | null = null;
      try {
        await dispatcher.dispatchTurn([block("tu-1", "complete_task")]);
      } catch (error) {
        thrown = error as IterationHaltedError;
      }

      expect(thrown?.haltReason).toBe(HALT_REASON);
    });
  });

  describe("synthetic halt-message format parity with the production wrapper", () => {
    it("synthetic tool_result content matches buildHaltMessage byte-for-byte so the production wrapper and the test dispatcher cannot drift", async () => {
      const dispatcher = createTurnDispatcher({
        getPendingHaltReason: async () => HALT_REASON,
        invokeHandler: vi.fn(),
      });
      let thrown: IterationHaltedError | null = null;
      try {
        await dispatcher.dispatchTurn([
          block("tu-1", "request_collaboration"),
          block("tu-2", "complete_task"),
        ]);
      } catch (error) {
        thrown = error as IterationHaltedError;
      }

      const expected = buildHaltMessage(HALT_REASON);
      expect(expected).toBe("iteration halted: collaboration_failure");
      expect(thrown?.syntheticToolResults?.[0]?.content[0]?.text).toBe(
        expected,
      );
      expect(thrown?.syntheticToolResults?.[1]?.content[0]?.text).toBe(
        expected,
      );
    });
  });
});
