import { describe, expect, it } from "vitest";
import { createCursorTaskRunner } from "@/lib/agent-backends/cursor/task-runner";
import { createScriptedTransport } from "@/lib/agent-backends/cursor/testing/scripted-worker";
import { translatePortableMcpToCursor } from "@/lib/agent-backends/cursor/mcp-translation";
import { createConflictResolver } from "@/lib/sessions/conflict-resolution";
import { createValidationFixer } from "./validation-fix";
import {
  executeFreshTaskRun,
  type ExecuteFreshTaskRunInput,
} from "./conversation/execute-fresh-task-run";

const modelSelection = {
  modelId: "composer-2.5",
  parameters: { fast: "false" },
};
const context = {
  projectPath: "/projects/repo",
  sessionName: "feature",
  conversationId: "cursor-conversation",
  worktreePath: "/projects/repo/.worktrees/merge",
  agentTurnDispatch: "fresh-run" as const,
};
const conflicts = [
  {
    file: "src/index.ts",
    description: "Both sides add imports",
    resolution: "Preserve both imports",
    rationale: "Both are used",
  },
];

function harness(text: string) {
  const transport = createScriptedTransport({
    onTurn(turn, worker) {
      worker.sendNativeEvent(turn.runId, 0, {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      worker.settle(turn.runId, "completed");
    },
  });
  const runner = createCursorTaskRunner({
    transport,
    storePath: (id) => `/state/${id}`,
    resolveModel: async (selection) => ({ ok: true, selection }),
    translatePortableMcpToCursor,
    newRunId: () => "cursor-assistance",
    now: Date.now,
    stallTimeoutMs: 1000,
    cancelSettleTimeoutMs: 50,
  });
  return {
    transport,
    executeWorkflowTaskRun: async () => {
      throw new Error("Conversation resume unavailable");
    },
    executeFreshTaskRun: (input: ExecuteFreshTaskRunInput) =>
      executeFreshTaskRun(input, {
        resolveIdentity: async () => ({ backend: "cursor", modelSelection }),
        runTask: (backend, request) => {
          if (backend !== "cursor") throw new Error(`${backend} unavailable`);
          expect(request.resumeRef).toBeUndefined();
          expect(request.modelSelection).toEqual(modelSelection);
          return runner.run(request);
        },
      }),
  };
}

describe("Cursor git assistance through the task adapter", () => {
  it("completes validation auto-fix in the merge worktree", async () => {
    const deps = harness(
      "Fixed the missing import and reran the scoped check.",
    );
    const result = await createValidationFixer(deps).fixValidationErrors({
      ...context,
      validationOutput: "src/index.ts: missing import",
      branchName: "feature",
    });
    expect(result).toEqual({ status: "fixed" });
    expect(deps.transport.startInputs[0]?.cwd).toBe(context.worktreePath);
    expect(deps.transport.workers[0]?.turns[0]?.input.promptText).toContain(
      "missing import",
    );
  });

  it.each(["analyzeConflicts", "resolveConflicts"] as const)(
    "%s accepts Cursor JSON after domain validation",
    async (operation) => {
      const deps = harness(
        "```json\n" + JSON.stringify({ conflicts }) + "\n```",
      );
      const resolver = createConflictResolver({
        ...deps,
        listUnmergedFiles: async () => [],
        listTrackedMarkerFiles: async () => [],
        readWorktreeFile: async () => "import a from 'a';\nimport b from 'b';",
      });
      const result = await resolver[operation](context);
      expect(result.status).toBe(
        operation === "analyzeConflicts" ? "analyzed" : "resolved",
      );
      expect(result).toMatchObject({ conflicts });
      expect(deps.transport.startInputs).toHaveLength(1);
      expect(deps.transport.startInputs[0]?.cwd).toBe(context.worktreePath);
    },
  );
});
