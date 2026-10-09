import { describe, expect, it } from "vitest";
import type { DebugModeState } from "@/lib/debug-log/schemas";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { storeSessionNameFromScopeRef } from "@/lib/conversations/conversation-target";
import { settledConversationTurn } from "@/lib/conversation-core/turn/testing/turn-result-fixture";
import { taskTurnRequestSchema } from "@/lib/conversation-core/turn/turn-spec";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { AgentCallFacadeDeps } from "@/lib/workflows/primitives/agent-call-facade";
import type { ConversationRecordPort } from "./conversation-record";
import type { TaskTurn } from "./executor";
import {
  createTaskLane,
  createTaskTurns,
  type TaskLaneDeps,
  type TaskTurnDeps,
} from "./task-turns";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/conversation-core/turn/execute-workflow-task-run";

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
  if (
    execution.kind !== "settled" ||
    execution.turn.outcome.kind !== "call_result"
  )
    throw new Error("fixture");
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
  const backendRef: AgentSessionRef | null = {
    backend: "claude",
    ref: "sdk-1",
  };
  const records: Pick<
    ConversationRecordPort,
    "read" | "beginTurn" | "settleTurn" | "admitProfile"
  > = {
    async read() {
      return {
        agentBackend: "claude",
        backendRef,
        promptCount: 3,
        transcriptPath: null,
        debugMode,
        pendingQuestionId: null,
        owner: null,
      };
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
      return {
        instructionBlock: null,
        snapshot: null,
        lockedAt: "2026-10-03T10:00:00.000Z",
      };
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
      target.scope === "session"
        ? `${projectPath}/.worktrees/${target.sessionName}`
        : projectPath,
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
    lineageCost: async (_conversationId, lineageId) =>
      lineageId === "sdk-1" ? 0.178 : null,
    log: createCapturingLogger(),
  };
  const run = (request: TaskTurn, signal = new AbortController().signal) =>
    createTaskTurns(deps).run({
      conversationId: "conv-1",
      enrollment: turnEnrollment,
      request,
      attemptId: "attempt-1",
      signal,
    });
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

    expect(outcome).toMatchObject({
      kind: "call_result",
      result: { outcome: { kind: "completed", text: "feat: add notices" } },
    });
    expect(result).toMatchObject({
      status: "succeeded",
      finalText: "feat: add notices",
    });
    expect(h.calls[0]?.request).toMatchObject({
      kind: "task_run",
      prompt: "<ticket/>\n\nWrite a commit message",
      modelSelection: { modelId: "sonnet", parameters: {} },
    });
    expect(h.calls[0]?.deps.taskExecution).toMatchObject({
      workingDirectory: "/repo/.worktrees/session",
      resumeRef: { backend: "claude", ref: "sdk-1" },
      defaultTimeoutMs: 60_000,
      conversationTarget: {
        scope: "session",
        sessionName: "session",
        conversationId: "conv-1",
      },
    });
    expect(h.entries).toEqual([
      expect.objectContaining({ type: "cost_settlement" }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "feat: add notices" }],
      }),
    ]);
    // The profile is locked once a turn runs under it, whichever kind; the row shows running until the runtime is closed.
    expect(h.events).toEqual([
      "begin:workflow",
      "admit-profile",
      "release",
      "settle:true:workflow",
    ]);
  });

  it("runs a project conversation's task in the project root as the project, with no session to scope the agent's CC calls to", async () => {
    const projectEnrollment = {
      ...enrollment,
      sessionName: storeSessionNameFromScopeRef({ scope: "project" }),
    };
    const governed = task({ executionClass: "governed-execution" });

    const session = harness(() =>
      callResult({ outcome: { kind: "completed", text: "done" } }),
    );
    await session.run(governed);
    expect(session.calls[0]?.deps.taskExecution).toMatchObject({
      ccSessionScope: {
        project: "repo",
        session: "session",
        conversationId: "conv-1",
      },
    });

    const project = harness(
      () => callResult({ outcome: { kind: "completed", text: "done" } }),
      null,
      projectEnrollment,
    );
    const { result } = await project.run(governed);
    expect(result).toMatchObject({ status: "succeeded" });
    expect(project.calls[0]?.deps.taskExecution).toMatchObject({
      workingDirectory: "/repo",
      conversationTarget: {
        scope: "project",
        projectName: "repo",
        conversationId: "conv-1",
      },
    });
    expect(project.calls[0]?.deps.taskExecution).not.toHaveProperty(
      "ccSessionScope",
    );
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
    expect(h.entries[0]?.raw).toMatchObject({
      lineageId: "sdk-1",
      cumulativeCostUsd: 0.193,
    });
    expect(h.settledCosts[0]).toBeCloseTo(0.015, 9);
  });

  it("runs fresh when the caller asks for no continuation, and keeps a failed task's partial output out of the transcript", async () => {
    const h = harness(() =>
      callResult({
        outcome: {
          kind: "failed",
          contentBlocks: [{ type: "text", text: "half a message" }],
          error: {
            backend: "claude",
            failureKind: "backend_error",
            message: "transport closed",
          },
        },
      }),
    );
    const { result } = await h.run(task({ resumeRef: null }));

    expect(h.calls[0]?.deps.taskExecution).not.toHaveProperty("resumeRef");
    expect(result).toMatchObject({
      status: "failed",
      failure: "transport closed",
    });
    expect(h.entries.filter((entry) => entry.role === "assistant")).toEqual([]);
  });

  it("tells the task's caller it failed when the conversation record could not be settled after it ran", async () => {
    const h = harness(() =>
      callResult({ outcome: { kind: "completed", text: "feat: add notices" } }),
    );
    h.deps.records.settleTurn = async () => {
      throw new Error("database is locked");
    };
    const { result, outcome } = await h.run(task());

    expect(result).toMatchObject({ status: "failed" });
    expect(outcome).toMatchObject({
      kind: "settlement_failed",
      code: "persistence",
      message:
        "The conversation record could not be settled: database is locked",
    });
  });

  it("tells the task's caller it failed when the runtime it ran in could not be closed", async () => {
    const h = harness(() =>
      callResult({ outcome: { kind: "completed", text: "feat: add notices" } }),
    );
    h.deps.host.release = async () => {
      throw new Error("the agent process did not exit");
    };
    const { outcome } = await h.run(task());

    expect(outcome).toMatchObject({
      kind: "settlement_failed",
      code: "runtime_close",
      message:
        "The agent runtime could not be closed: the agent process did not exit",
    });
  });

  it("refuses a task the backend cannot run without touching the conversation", async () => {
    const h = harness(() => callResult({}));
    h.deps.admit = async () => {
      throw new Error('Backend "cursor" cannot run tasks');
    };
    const { result, outcome } = await h.run(task());

    expect(outcome).toMatchObject({
      kind: "not_started",
      reason: "configuration",
      message: 'Backend "cursor" cannot run tasks',
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([]);
  });
});

describe("a task lane: tasks on no conversation", () => {
  /** Capacity that never frees: the wait ends only when the task's signal aborts, as the semaphore's does. */
  function waiting(
    _label: string,
    signal: AbortSignal | undefined,
  ): Promise<() => void> {
    return new Promise((_resolve, reject) => {
      if (signal?.aborted === true) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  }

  /** The task protocol with model capacity always free. */
  function lane(deps: TaskTurnDeps, overrides: Partial<TaskLaneDeps> = {}) {
    return createTaskLane({
      ...deps,
      acquireSlot: async () => () => {},
      ...overrides,
    });
  }
  /** A checkpoint generation pass, as the generators submit one. */
  function pass(
    overrides: Partial<ExecuteWorkflowTaskRunInput> = {},
  ): ExecuteWorkflowTaskRunInput {
    return {
      kind: "task_run",
      executionClass: "nongoverned-task",
      executionProfile: "standard",
      structuredOutputTurns: "work_then_format",
      prompt: "Summarize the captured conversation",
      outputFormat: { type: "json_schema", schema: { type: "object" } },
      timeoutMs: 120_000,
      modelSelection: { modelId: "opus", parameters: {} },
      binding: {
        kind: "ephemeral",
        address: {
          projectPath: "/repo",
          target: {
            scope: "session",
            projectName: "repo",
            sessionName: "session",
            conversationId: "checkpoint-op-1",
          },
        },
        worktreePath: "/repo/.worktrees/session",
        backend: "claude",
        role: null,
        transcriptPath: null,
      },
      ...overrides,
    };
  }

  it("runs a task in the lane's worktree, fresh, with no conversation context and nothing recorded", async () => {
    const h = harness(() =>
      callResult({
        backendRef: { backend: "claude", ref: "sdk-9" },
        usage: { costUsd: 0.1 },
        outcome: {
          kind: "completed",
          text: "",
          structuredOutput: { summary: "done" },
        },
      }),
    );
    const result = await lane(h.deps)(pass());

    expect(result).toMatchObject({
      kind: "structured",
      structuredOutput: { summary: "done" },
      usage: { costUsd: 0.1 },
    });
    expect(h.calls[0]?.request).toMatchObject({
      kind: "task_run",
      backend: "claude",
      prompt: "Summarize the captured conversation",
      modelSelection: { modelId: "opus", parameters: {} },
      outputSchema: { type: "object" },
      structuredOutputTurns: "work_then_format",
    });
    expect(h.calls[0]?.deps.taskExecution).toMatchObject({
      workingDirectory: "/repo/.worktrees/session",
      autonomous: true,
    });
    expect(h.calls[0]?.deps.taskExecution).not.toHaveProperty("resumeRef");
    expect(h.calls[0]?.deps.taskExecution).not.toHaveProperty(
      "conversationTarget",
    );
    expect(h.calls[0]?.deps.taskExecution).not.toHaveProperty("ccSessionScope");
    expect(h.events).toEqual([]);
    expect(h.entries).toEqual([]);
  });

  it("resumes only a session the caller names, and charges a resumed run only what it added", async () => {
    const answers = [
      callResult({
        backendRef: { backend: "claude", ref: "sdk-9" },
        usage: { costUsd: 0.1, cumulativeCostUsd: 0.1 },
        outcome: { kind: "completed", text: "draft" },
      }),
      callResult({
        backendRef: { backend: "claude", ref: "sdk-9" },
        usage: { costUsd: 0.25, cumulativeCostUsd: 0.25 },
        outcome: { kind: "completed", text: "corrected" },
      }),
    ];
    const h = harness(() => {
      const next = answers.shift();
      if (next === undefined) throw new Error("no more answers");
      return next;
    });
    const run = lane(h.deps);

    const first = await run(pass({ outputFormat: undefined }));
    const correction = await run(
      pass({
        outputFormat: undefined,
        structuredOutputTurns: "single",
        resumeRef: { backend: "claude", ref: "sdk-9" },
      }),
    );

    expect(first).toMatchObject({ kind: "text", usage: { costUsd: 0.1 } });
    expect(h.calls[1]?.deps.taskExecution).toMatchObject({
      resumeRef: { backend: "claude", ref: "sdk-9" },
    });
    expect(correction).toMatchObject({ kind: "text", text: "corrected" });
    expect(correction.usage.costUsd).toBeCloseTo(0.15, 9);
  });

  it("answers a task the backend cannot run, or one cancelled before it starts, without calling the agent", async () => {
    const h = harness(() => callResult({}));
    h.deps.admit = async () => {
      throw new Error('Backend "cursor" cannot run tasks');
    };
    const refused = await lane(h.deps)(pass());
    const cancel = new AbortController();
    cancel.abort();
    const cancelled = await lane(h.deps, { admit: async () => {} })(
      pass({ signal: cancel.signal }),
    );

    expect(refused).toMatchObject({
      kind: "error",
      error: 'Backend "cursor" cannot run tasks',
    });
    expect(cancelled).toMatchObject({ kind: "error", aborted: true });
    expect(h.calls).toEqual([]);
  });

  it("refuses to run a task on a conversation's own binding", async () => {
    const h = harness(() => callResult({}));
    const durable = pass({
      binding: {
        kind: "durable",
        address: {
          projectPath: "/repo",
          target: {
            scope: "session",
            projectName: "repo",
            sessionName: "session",
            conversationId: "conv-1",
          },
        },
      },
    });

    await expect(lane(h.deps)(durable)).rejects.toThrow(/no conversation/);
    expect(h.calls).toEqual([]);
  });

  it("waits for model capacity before calling the agent, and frees it once the task ends", async () => {
    const h = harness(() =>
      callResult({ outcome: { kind: "completed", text: "draft" } }),
    );
    const slots: string[] = [];
    let grant: () => void = () => {};
    const run = lane(h.deps, {
      acquireSlot: (label) =>
        new Promise((resolve) => {
          slots.push(`wait:${label}`);
          grant = () => resolve(() => slots.push("free"));
        }),
    });

    const task = run(pass({ outputFormat: undefined }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.calls).toEqual([]);
    grant();
    await task;

    expect(h.calls).toHaveLength(1);
    expect(slots).toEqual(["wait:task:checkpoint-op-1", "free"]);
  });

  it("answers a pass whose wait for capacity expires as not started, without calling the agent", async () => {
    const h = harness(() => callResult({}));
    const result = await lane(h.deps, {
      acquireSlot: async () => {
        throw new Error(
          "Query semaphore timeout after 300000ms waiting for slot",
        );
      },
    })(pass());

    expect(result).toMatchObject({
      kind: "error",
      notStarted: { reason: "query_slot_timeout" },
    });
    expect(h.calls).toEqual([]);
  });

  it("answers a pass cancelled while it waits for capacity as cancelled, and frees capacity when the call itself fails", async () => {
    const h = harness(() => {
      throw new Error("facade fault");
    });
    const cancel = new AbortController();
    const cancelled = lane(h.deps, { acquireSlot: waiting })(
      pass({ signal: cancel.signal }),
    );
    cancel.abort("user");
    expect(await cancelled).toMatchObject({
      kind: "error",
      aborted: true,
      notStarted: { reason: "cancelled" },
    });

    const freed: string[] = [];
    await expect(
      lane(h.deps, { acquireSlot: async () => () => freed.push("free") })(
        pass(),
      ),
    ).rejects.toThrow("facade fault");
    expect(freed).toEqual(["free"]);
  });

  it("cuts a task at its deadline, whether it is still waiting for capacity or already running", async () => {
    const h = harness(() => callResult({}));
    const queued = await lane(h.deps, { acquireSlot: waiting })(
      pass({ timeoutMs: 20 }),
    );
    expect(queued).toMatchObject({
      kind: "error",
      notStarted: { reason: "cancelled", cancelReason: "timeout" },
    });
    expect(h.calls).toEqual([]);

    // Work, format and repair share the one deadline: the call is cut when it passes.
    h.deps.executeAgentCall = (request, facadeDeps) =>
      new Promise((resolve) => {
        h.calls.push({ request, deps: facadeDeps });
        facadeDeps.taskExecution?.signal?.addEventListener(
          "abort",
          () =>
            resolve(
              callResult({
                outcome: {
                  kind: "failed",
                  error: {
                    backend: "claude",
                    failureKind: "aborted",
                    message: "aborted",
                  },
                },
              }),
            ),
          { once: true },
        );
      });
    const running = await lane(h.deps)(pass({ timeoutMs: 20 }));
    expect(running).toMatchObject({
      kind: "error",
      aborted: true,
      interruption: { reason: "timeout", timeoutMs: 20 },
    });
  });
});

describe("a conversation's task deadline", () => {
  it("cuts a running task when its own deadline passes", async () => {
    const h = harness(() => callResult({}));
    h.deps.executeAgentCall = (request, facadeDeps) =>
      new Promise((resolve) => {
        h.calls.push({ request, deps: facadeDeps });
        facadeDeps.taskExecution?.signal?.addEventListener(
          "abort",
          () =>
            resolve(
              callResult({
                outcome: {
                  kind: "failed",
                  error: {
                    backend: "claude",
                    failureKind: "aborted",
                    message: "aborted",
                  },
                },
              }),
            ),
          { once: true },
        );
      });
    const { outcome } = await h.run(task({ timeoutMs: 20 }));

    expect(outcome).toMatchObject({
      kind: "call_result",
      interruption: { reason: "timeout", timeoutMs: 20 },
    });
  });
});
