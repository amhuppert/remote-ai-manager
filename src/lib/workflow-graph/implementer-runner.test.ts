import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "@/types";
import { createGraphWorkflowImplementerRunner } from "./implementer-runner";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "session-1",
    worktreePath: "/repo/.worktrees/session-1",
    branchName: "csm/session-1",
    createdAt: "2026-03-27T12:00:00.000Z",
    lastActivityAt: "2026-03-27T12:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
    referenceDocuments: [],
    ...overrides,
  };
}

describe("graph workflow implementer runner", () => {
  it("executes claude implementer turns through prompt execution and forwards content frames", async () => {
    const emitStreamFrame = vi.fn();
    const executePromptStream = vi.fn(
      async (
        _projectPath: string,
        _session: SessionState,
        _promptText: string,
        emit: (event: string, data: unknown) => void,
      ) => {
        emit("content", {
          type: "text",
          text: "Inspecting the codebase.",
        });
        emit("error", { message: "ignored by graph stream" });

        return {
          conversationId: "conversation-1",
          contextTokens: 12_345,
          contextWindowMax: 200_000,
        };
      },
    );

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
    });

    const result = await runner.runClaudeIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Inspect the codebase",
      conversationId: "conversation-1",
      contextId: "context-plan",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { id: "tool-server" },
      emitStreamFrame,
    });

    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ sessionName: "session-1" }),
      "Inspect the codebase",
      expect.any(Function),
      "conversation-1",
      "opus",
      undefined,
      expect.objectContaining({
        autonomous: true,
        backend: "claude",
        effort: "high",
        tooling: {
          claudeSdkServers: {
            "graph-workflow": { id: "tool-server" },
          },
        },
      }),
    );
    expect(emitStreamFrame).toHaveBeenCalledWith({
      type: "content",
      conversationId: "conversation-1",
      contextId: "context-plan",
      content: {
        type: "text",
        text: "Inspecting the codebase.",
      },
    });
    expect(result).toEqual({
      contextTokens: 12_345,
      contextWindowMax: 200_000,
    });
  });
});
