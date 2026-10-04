import { describe, expect, it } from "vitest";
import type { DebugModeState } from "@/lib/debug-log/schemas";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { storeSessionNameFromScopeRef } from "@/lib/conversations/conversation-target";
import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import { taskTurnRequestSchema } from "@/lib/workflows/conversation/turn-spec";
import type { AgentCallRequest, AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { AgentCallFacadeDeps } from "@/lib/workflows/primitives/agent-call-facade";
import type { ConversationRecordPort } from "./conversation-record";
import type { TaskTurn } from "./executor";
import { createTaskTurns, type TaskTurnDeps } from "./task-turns";

const enrollment = {
  conversationId: "conv-1",
  projectPath: "/repo",
  sessionName: "session",
  enrolledAt: "2026-10-03T10:00:00.000Z",
};

function task(overrides: Record<string, unknown> = {}): TaskTurn {
  return taskTurnRequestSchema.parse({
    kind: "task_run",
    promptText: "Write a commit message",
    executionClass: "nongoverned-task",
    ...overrides,
  });
}

function callResult(result: Partial<AgentCallResult>): AgentCallResult {
  const execution = settledConversationTurn(result);
  if (execution.kind !== "settled" || execution.turn.outcome.kind !== "call_result") throw new Error("fixture");
  return execution.turn.outcome.result;
}

function harness(
  answer: () => AgentCallResult,
  debugMode: DebugModeState | null = null,
  turnEnrollment: typeof enrollment = enrollment,
) {
  const events: string[] = [];
  const entries: TranscriptEntry[] = [];
  const calls: { request: AgentCallRequest; deps: AgentCallFacadeDeps }[] = [];
  const settledCosts: (number | null)[] = [];
  const backendRef: AgentSessionRef | null = { backend: "claude", ref: "sdk-1" };
  const records: Pick<ConversationRecordPort, "read" | "beginTurn" | "settleTurn" | "admitProfile"> = {
    async read() {
      return { agentBackend: "claude", backendRef, promptCount: 3, transcriptPath: null, debugMode };
    },
    async beginTurn(_identity, source) {
      events.push(`begin:${source}`);
    },
    async settleTurn(_identity, settlement, source) {
      events.push(`settle:${settlement.counted}:${source}`);
      settledCosts.push(settlement.costUsd);
      return { debug: null };
    },
    async admitProfile() {
      events.push("admit-profile");
      return { instructionBlock: null, snapshot: null, lockedAt: "2026-10-03T10:00:00.000Z" };
    },
  };
  const deps: TaskTurnDeps = {
    records,
    host: {
      async release() {
        events.push("release");
      },
    },
    async admit() {},
    preparePrompt: async ({ promptText }) => `<ticket/>\n\n${promptText}`,
    resolveSettings: async ({ modelSelection }) => ({
      modelSelection: modelSelection ?? { modelId: "sonnet", parameters: {} },
      timeoutMs: 60_000,
    }),
    async executeAgentCall(request, facadeDeps) {
      calls.push({ request, deps: facadeDeps });
      return answer();
    },
    getTaskRunner() {
      throw new Error("the fake call resolves no runner");
    },
    worktreeOf: async (projectPath, target) =>
      target.scope === "session" ? `${projectPath}/.worktrees/${target.sessionName}` : projectPath,
    transcript: {
      async safeAppendTranscriptEntry(_conversationId, entry) {
        entries.push(entry);
      },
      async safeAppendTranscriptEntryOnce(_conversationId, entry) {
        entries.push(entry);
      },
    },
    projection: () => ({ projectAssistantMetadata: () => undefined }),
    getProjectDisplayName: () => "repo",
    lineageCost: async (_conversationId, lineageId) => (lineageId === "sdk-1" ? 0.178 : null),
    log: createCapturingLogger(),
  };
  const run = (request: TaskTurn, signal = new AbortController().signal) =>
    createTaskTurns(deps).run({ conversationId: "conv-1", enrollment: turnEnrollment, request, attemptId: "attempt-1", signal });
  return { deps, run, events, entries, calls, settledCosts };
}

describe("task turns on an interactive conversation", () => {
  it("runs a workflow's task in the conversation's own session and records its output on the conversation", async () => {
    const h = harness(() =>
      callResult({
        backendRef: { backend: "claude", ref: "sdk-2" },
        usage: { costUsd: 0.05 },
        outcome: { kind: "completed", text: "feat: add notices" },
      }),
    );
    const { result, outcome } = await h.run(task());

    expect(outcome).toMatchObject({ kind: "call_result", result: { outcome: { kind: "completed", text: "feat: add notices" } } });
    expect(result).toMatchObject({ status: "succeeded", finalText: "feat: add notices" });
    expect(h.calls[0]?.request).toMatchObject({
      kind: "task_run",
      prompt: "<ticket/>\n\nWrite a commit message",
      modelSelection: { modelId: "sonnet", parameters: {} },
    });
    expect(h.calls[0]?.deps.taskExecution).toMatchObject({
      workingDirectory: "/repo/.worktrees/session",
      resumeRef: { backend: "claude", ref: "sdk-1" },
      defaultTimeoutMs: 60_000,
      conversationTarget: { scope: "session", sessionName: "session", conversationId: "conv-1" },
    });
    expect(h.entries).toEqual([
      expect.objectContaining({ type: "cost_settlement" }),
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "feat: add notices" }] }),
    ]);
    // The profile is locked once a turn runs under it, whichever kind; the row shows running until the runtime is closed.
    expect(h.events).toEqual(["begin:workflow", "admit-profile", "release", "settle:true:workflow"]);
  });

  it("runs a project conversation's task in the project root as the project, with no session to scope the agent's CC calls to", async () => {
    const projectEnrollment = { ...enrollment, sessionName: storeSessionNameFromScopeRef({ scope: "project" }) };
    const governed = task({ executionClass: "governed-execution" });

    const session = harness(() => callResult({ outcome: { kind: "completed", text: "done" } }));
    await session.run(governed);
    expect(session.calls[0]?.deps.taskExecution).toMatchObject({
      ccSessionScope: { project: "repo", session: "session", conversationId: "conv-1" },
    });

    const project = harness(() => callResult({ outcome: { kind: "completed", text: "done" } }), null, projectEnrollment);
    const { result } = await project.run(governed);
    expect(result).toMatchObject({ status: "succeeded" });
    expect(project.calls[0]?.deps.taskExecution).toMatchObject({
      workingDirectory: "/repo",
      conversationTarget: { scope: "project", projectName: "repo", conversationId: "conv-1" },
    });
    expect(project.calls[0]?.deps.taskExecution).not.toHaveProperty("ccSessionScope");
  });

  it("charges a task that resumed the conversation's session only what it added, on the session's lineage", async () => {
    const h = harness(() =>
      callResult({
        backendRef: { backend: "claude", ref: "sdk-1" },
        usage: { costUsd: 0.193, cumulativeCostUsd: 0.193 },
        outcome: { kind: "completed", text: "feat: add notices" },
      }),
    );
    await h.run(task());
    expect(h.entries[0]?.raw).toMatchObject({ lineageId: "sdk-1", cumulativeCostUsd: 0.193 });
    expect(h.settledCosts[0]).toBeCloseTo(0.015, 9);
  });

  it("runs fresh when the caller asks for no continuation, and keeps a failed task's partial output out of the transcript", async () => {
    const h = harness(() =>
      callResult({
        outcome: {
          kind: "failed",
          contentBlocks: [{ type: "text", text: "half a message" }],
          error: { backend: "claude", failureKind: "backend_error", message: "transport closed" },
        },
      }),
    );
    const { result } = await h.run(task({ resumeRef: null }));

    expect(h.calls[0]?.deps.taskExecution).not.toHaveProperty("resumeRef");
    expect(result).toMatchObject({ status: "failed", failure: "transport closed" });
    expect(h.entries.filter((entry) => entry.role === "assistant")).toEqual([]);
  });

  it("tells the task's caller it failed when the conversation record could not be settled after it ran", async () => {
    const h = harness(() => callResult({ outcome: { kind: "completed", text: "feat: add notices" } }));
    h.deps.records.settleTurn = async () => {
      throw new Error("database is locked");
    };
    const { result, outcome } = await h.run(task());

    expect(result).toMatchObject({ status: "failed" });
    expect(outcome).toMatchObject({
      kind: "settlement_failed",
      code: "persistence",
      message: "The conversation record could not be settled: database is locked",
    });
  });

  it("refuses a task the backend cannot run without touching the conversation", async () => {
    const h = harness(() => callResult({}));
    h.deps.admit = async () => {
      throw new Error('Backend "cursor" cannot run tasks');
    };
    const { result, outcome } = await h.run(task());

    expect(outcome).toMatchObject({ kind: "not_started", reason: "configuration", message: 'Backend "cursor" cannot run tasks' });
    expect(result).toMatchObject({ status: "failed" });
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([]);
  });
});
