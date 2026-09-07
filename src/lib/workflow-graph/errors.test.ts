import { describe, expect, it } from "vitest";
import {
  AgentTurnFailedError,
  ConversationTurnSettlementError,
  WorktreeCreationDirty,
  isTypedWorkflowError,
  toHaltReason,
  type DirtyPath,
} from "./errors";
import {
  IterationFailureWithProgressError,
  hasPartialIterationProgress,
} from "./iteration-failure-with-progress";

function makeSettlementError(
  code: "delivery_receipt" | "persistence" | "runtime_close" = "persistence",
) {
  return new ConversationTurnSettlementError({
    outcome: {
      kind: "settlement_failed",
      code,
      message: "commit unavailable",
      result: null,
    },
    attemptId: "attempt-9",
    contextId: "ctx-settle",
    engine: "codex",
  });
}

function makeDirty(path: string, statusCode = "M ", tracked = true): DirtyPath {
  return { path, statusCode, tracked };
}

describe("errors module", () => {
  describe("AgentTurnFailedError", () => {
    it("captures contextId, engine, cause, originalMessage", () => {
      const err = new AgentTurnFailedError("boom", {
        contextId: "ctx-1",
        engine: "claude",
        cause: "sdk_error",
        originalMessage: "boom",
      });
      expect(err.name).toBe("AgentTurnFailedError");
      expect(err.contextId).toBe("ctx-1");
      expect(err.engine).toBe("claude");
      expect(err.cause).toBe("sdk_error");
      expect(err.originalMessage).toBe("boom");
    });
  });

  describe("WorktreeCreationDirty", () => {
    it("captures worktreePath, branchName, dirtyPaths", () => {
      const err = new WorktreeCreationDirty("dirty after create", {
        worktreePath: "/tmp/wt",
        branchName: "feat/x",
        dirtyPaths: [makeDirty("foo.ts")],
      });
      expect(err.name).toBe("WorktreeCreationDirty");
      expect(err.worktreePath).toBe("/tmp/wt");
      expect(err.branchName).toBe("feat/x");
      expect(err.dirtyPaths).toEqual([makeDirty("foo.ts")]);
    });
  });

  describe("ConversationTurnSettlementError", () => {
    it("retains the original outcome and attempt identity", () => {
      const err = makeSettlementError("delivery_receipt");
      expect(err.name).toBe("ConversationTurnSettlementError");
      expect(err.message).toBe("commit unavailable");
      expect(err.outcome).toEqual({
        kind: "settlement_failed",
        code: "delivery_receipt",
        message: "commit unavailable",
        result: null,
      });
      expect(err.attemptId).toBe("attempt-9");
      expect(err.contextId).toBe("ctx-settle");
      expect(err.engine).toBe("codex");
      expect(err).not.toBeInstanceOf(AgentTurnFailedError);
    });
  });

  describe("isTypedWorkflowError", () => {
    it("returns true for settlement errors", () => {
      expect(isTypedWorkflowError(makeSettlementError())).toBe(true);
    });

    it("returns true for typed errors", () => {
      expect(
        isTypedWorkflowError(
          new AgentTurnFailedError("m", {
            contextId: "c",
            engine: "claude",
            cause: "sdk_error",
            originalMessage: "m",
          }),
        ),
      ).toBe(true);
      expect(
        isTypedWorkflowError(
          new WorktreeCreationDirty("m", {
            worktreePath: "/x",
            branchName: "b",
            dirtyPaths: [],
          }),
        ),
      ).toBe(true);
    });

    it("returns false for generic Error or non-error values", () => {
      expect(isTypedWorkflowError(new Error("plain"))).toBe(false);
      expect(isTypedWorkflowError("string")).toBe(false);
      expect(isTypedWorkflowError(null)).toBe(false);
      expect(isTypedWorkflowError(undefined)).toBe(false);
    });
  });

  describe("toHaltReason", () => {
    it("converts AgentTurnFailedError to agent_turn_failed", () => {
      const err = new AgentTurnFailedError("turn failed", {
        contextId: "ctx-2",
        engine: "codex",
        cause: "timeout",
        originalMessage: "turn failed",
      });
      const reason = toHaltReason(err, { cause: "unknown" });
      expect(reason).toEqual({
        type: "agent_turn_failed",
        contextId: "ctx-2",
        engine: "codex",
        cause: "timeout",
        message: "turn failed",
      });
    });

    it("converts WorktreeCreationDirty to worktree_creation_dirty with truncation", () => {
      const paths: DirtyPath[] = Array.from({ length: 7 }, (_, i) =>
        makeDirty(`f-${i}.ts`),
      );
      const err = new WorktreeCreationDirty("dirty", {
        worktreePath: "/tmp/wt",
        branchName: "feat/x",
        dirtyPaths: paths,
      });
      const reason = toHaltReason(err, {
        contextId: "ctx-3",
        cause: "unknown",
      });
      if (reason.type !== "worktree_creation_dirty") {
        throw new Error("expected worktree_creation_dirty");
      }
      expect(reason.worktreePath).toBe("/tmp/wt");
      expect(reason.branchName).toBe("feat/x");
      expect(reason.dirtyPaths).toHaveLength(5);
      expect(reason.totalDirtyCount).toBe(7);
      expect(reason.contextId).toBe("ctx-3");
    });

    it("WorktreeCreationDirty without fallback contextId yields null contextId", () => {
      const err = new WorktreeCreationDirty("dirty", {
        worktreePath: "/tmp/wt",
        branchName: "feat/x",
        dirtyPaths: [],
      });
      const reason = toHaltReason(err, { cause: "unknown" });
      if (reason.type !== "worktree_creation_dirty") {
        throw new Error("expected worktree_creation_dirty");
      }
      expect(reason.contextId).toBeNull();
    });

    it.each(["delivery_receipt", "persistence", "runtime_close"] as const)(
      "projects a %s settlement error as an io execution_loop_failed halt despite an sdk fallback",
      (code) => {
        const reason = toHaltReason(makeSettlementError(code), {
          contextId: "ctx-other",
          cause: "sdk_error",
        });
        expect(reason).toEqual({
          type: "execution_loop_failed",
          contextId: "ctx-settle",
          message: expect.stringContaining("settlement"),
          cause: "io",
        });
        if (reason.type !== "execution_loop_failed")
          throw new Error("unreachable");
        expect(reason.message).toContain(code);
        expect(reason.message).toContain("commit unavailable");
      },
    );

    it("projects a progress-wrapped settlement error the same way and keeps the completed turn count", () => {
      const wrapped = new IterationFailureWithProgressError(
        makeSettlementError("runtime_close"),
        2,
      );
      expect(hasPartialIterationProgress(wrapped)).toBe(true);
      expect(wrapped.completedTurnCount).toBe(2);
      const reason = toHaltReason(wrapped, {
        contextId: "ctx-other",
        cause: "sdk_error",
      });
      expect(reason).toMatchObject({
        type: "execution_loop_failed",
        contextId: "ctx-settle",
        cause: "io",
      });
      if (reason.type !== "execution_loop_failed")
        throw new Error("unreachable");
      expect(reason.message).toContain("runtime_close");
    });

    it("keeps a progress-wrapped generic error on the fallback projection", () => {
      const wrapped = new IterationFailureWithProgressError(
        new Error("plain failure"),
        1,
      );
      expect(
        toHaltReason(wrapped, { contextId: "ctx-g", cause: "sdk_error" }),
      ).toEqual({
        type: "execution_loop_failed",
        contextId: "ctx-g",
        message: "plain failure",
        cause: "sdk_error",
      });
    });

    it("falls back to execution_loop_failed for generic Error", () => {
      const err = new Error("something blew up");
      const reason = toHaltReason(err, { cause: "sdk_error" });
      expect(reason).toEqual({
        type: "execution_loop_failed",
        contextId: null,
        message: "something blew up",
        cause: "sdk_error",
      });
    });

    it("falls back to execution_loop_failed with contextId when provided", () => {
      const err = new Error("io trouble");
      const reason = toHaltReason(err, {
        contextId: "ctx-z",
        cause: "io",
      });
      expect(reason).toEqual({
        type: "execution_loop_failed",
        contextId: "ctx-z",
        message: "io trouble",
        cause: "io",
      });
    });

    it("falls back to execution_loop_failed for non-error values", () => {
      const reason = toHaltReason("string error", { cause: "unknown" });
      expect(reason).toEqual({
        type: "execution_loop_failed",
        contextId: null,
        message: "string error",
        cause: "unknown",
      });
    });
  });
});
