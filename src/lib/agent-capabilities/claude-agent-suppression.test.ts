import { describe, expect, it } from "vitest";

import {
  CLAUDE_AGENT_SUPPRESSION_STRATEGY,
  buildClaudeAgentSuppressionDecision,
  composeClaudeAgentCanUseTool,
} from "./claude-agent-suppression";

describe("Claude sub-agent suppression strategy verification", () => {
  it("declares permission-layer denial as the verified suppression strategy", () => {
    // The installed @anthropic-ai/claude-agent-sdk Settings type does not
    // expose a typed per-agent disable map (only Options.agents lets us
    // *define* agents). We have verified through the SDK typings that the
    // only deterministic suppression path is the canUseTool permission
    // callback, which receives Task invocations with `subagent_type` in the
    // tool input.
    expect(CLAUDE_AGENT_SUPPRESSION_STRATEGY.kind).toBe("permission-layer");
    expect(CLAUDE_AGENT_SUPPRESSION_STRATEGY.applyPoint).toBe(
      "next-conversation",
    );
    expect(CLAUDE_AGENT_SUPPRESSION_STRATEGY.interceptedToolNames).toContain(
      "Task",
    );
  });

  describe("buildClaudeAgentSuppressionDecision", () => {
    it("allows non-Task tool invocations regardless of disabled set", () => {
      const decision = buildClaudeAgentSuppressionDecision({
        toolName: "Bash",
        input: { command: "ls" },
        disabledAgentNames: new Set(["code-reviewer"]),
      });
      expect(decision.behavior).toBe("allow");
    });

    it("allows Task invocations when the requested agent is not in the disabled set", () => {
      const decision = buildClaudeAgentSuppressionDecision({
        toolName: "Task",
        input: { subagent_type: "general-purpose", prompt: "go" },
        disabledAgentNames: new Set(["code-reviewer"]),
      });
      expect(decision.behavior).toBe("allow");
    });

    it("denies Task invocations whose subagent_type matches a disabled agent", () => {
      const decision = buildClaudeAgentSuppressionDecision({
        toolName: "Task",
        input: { subagent_type: "code-reviewer", prompt: "review" },
        disabledAgentNames: new Set(["code-reviewer"]),
      });
      expect(decision.behavior).toBe("deny");
      if (decision.behavior === "deny") {
        expect(decision.message).toMatch(/code-reviewer/);
        expect(decision.message).toMatch(/disabled/i);
      }
    });

    it("allows Task invocations with no subagent_type (main-thread Task fallback)", () => {
      // Defensive: if the SDK ever omits subagent_type on a Task call, we
      // must not deny by default — that would block legitimate tool use.
      const decision = buildClaudeAgentSuppressionDecision({
        toolName: "Task",
        input: { prompt: "go" },
        disabledAgentNames: new Set(["code-reviewer"]),
      });
      expect(decision.behavior).toBe("allow");
    });
  });

  describe("composeClaudeAgentCanUseTool", () => {
    it("returns the inner CanUseTool result when nothing is disabled", async () => {
      const innerCalls: string[] = [];
      const composed = composeClaudeAgentCanUseTool({
        disabledAgentNames: new Set(),
        inner: async (toolName) => {
          innerCalls.push(toolName);
          return { behavior: "allow" };
        },
      });

      const result = await composed(
        "Task",
        { subagent_type: "code-reviewer" },
        { toolUseID: "u1", signal: new AbortController().signal },
      );

      expect(result).toEqual({ behavior: "allow" });
      expect(innerCalls).toEqual(["Task"]);
    });

    it("short-circuits to deny when the suppression strategy denies, never calling inner", async () => {
      let innerCalled = false;
      const composed = composeClaudeAgentCanUseTool({
        disabledAgentNames: new Set(["code-reviewer"]),
        inner: async () => {
          innerCalled = true;
          return { behavior: "allow" };
        },
      });

      const result = await composed(
        "Task",
        { subagent_type: "code-reviewer" },
        { toolUseID: "u2", signal: new AbortController().signal },
      );

      expect(result.behavior).toBe("deny");
      expect(innerCalled).toBe(false);
    });

    it("falls through to a default-allow when no inner is provided", async () => {
      const composed = composeClaudeAgentCanUseTool({
        disabledAgentNames: new Set(["code-reviewer"]),
      });

      const result = await composed(
        "Read",
        { file_path: "/tmp/x" },
        { toolUseID: "u3", signal: new AbortController().signal },
      );

      expect(result.behavior).toBe("allow");
    });
  });
});
