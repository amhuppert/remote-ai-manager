/**
 * Tests for `executeWorkflowTaskRun` — the named entrypoint that routes
 * workflow callers through the conversation actor for `task_run` turns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fromPromise } from "xstate";
import { conversationMachine } from "./machine";
import type {
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
  RunTaskRunInput,
} from "./types";
import {
  setMachineFactory,
  _resetMachineFactoryForTesting,
  _resetForTesting as resetActors,
  getConversationActor,
  setEnsureConversationActorDeps,
  _resetEnsureConversationActorDepsForTesting,
  type EnsureActorInputData,
} from "./manager";
import { _resetForTesting as resetRuntime } from "./runtime-state";
import {
  executeWorkflowTaskRun,
  _getExecuteWorkflowTaskRunInFlightCountForTesting,
  _resetExecuteWorkflowTaskRunForTesting,
} from "./execute-workflow-task-run";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  createCapturingLogger,
  type CapturingLogger,
} from "@/lib/shared/testing/capturing-logger";

// Infrastructure mock — createLogger is called at module load.
vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Controllable test machine — runTaskRun is a fromPromise we can resolve
// on demand to assert serialization, structured-output mapping, etc.
// ---------------------------------------------------------------------------

type RunTaskRunResolver = (result: PromptActorResult) => void;
type RunTaskRunInvocation = {
  input: RunTaskRunInput;
  resolve: RunTaskRunResolver;
  promise: Promise<PromptActorResult>;
};

let pendingRunTaskRunInvocations: RunTaskRunInvocation[] = [];

function nextPendingInvocation(): Promise<RunTaskRunInvocation> {
  return new Promise((resolve) => {
    const tick = (): void => {
      const next = pendingRunTaskRunInvocations.shift();
      if (next) {
        resolve(next);
        return;
      }
      setTimeout(tick, 1);
    };
    tick();
  });
}

function createTestMachine() {
  return conversationMachine.provide({
    actors: {
      prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
        async () => ({ transcriptPath: "/test.jsonl" }),
      ),
      executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
        async () => ({
          backendRef: null,
          costUsd: null,
          durationMs: null,
          numTurns: null,
          contextTokens: null,
          contextWindow: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          contentBlocks: [],
          aborted: false,
          compacted: false,
          error: null,
          continuationDisposition: "retain",
        }),
      ),
      runTaskRun: fromPromise<PromptActorResult, RunTaskRunInput>(
        ({ input }) => {
          let resolve!: RunTaskRunResolver;
          const promise = new Promise<PromptActorResult>((res) => {
            resolve = res;
          });
          pendingRunTaskRunInvocations.push({ input, resolve, promise });
          return promise;
        },
      ),
    },
    actions: {
      persistSnapshot: () => {},
      syncDerivedFields: () => {},
      broadcastConversationStatus: () => {},
      broadcastAskQuestion: () => {},
      broadcastDebugModeStatus: () => {},
      releaseResources: () => {},
      dispatchPushNotification: () => {},
    },
  });
}

function makeActorInputData(
  overrides: Partial<EnsureActorInputData> = {},
): EnsureActorInputData {
  return {
    conversationScope: "session",
    projectName: "test-project",
    sessionWorktreePath: "/test/project/.worktrees/test-session",
    persistence: "ephemeral",
    conversation: {
      createdAt: "2026-01-01T00:00:00.000Z",
      forkedFrom: null,
      role: null,
      transcriptPath: null,
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
      debugMode: null,
    },
    ...overrides,
  };
}

const PROJECT_PATH = "/test/project";
const SESSION_NAME = "test-session";
const CONVERSATION_ID = "conv-abc";

function defaultResult(
  overrides: Partial<PromptActorResult> = {},
): PromptActorResult {
  return {
    backendRef: null,
    costUsd: 0.0123,
    durationMs: 456,
    numTurns: null,
    contextTokens: 1000,
    contextWindow: 200000,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    contentBlocks: [{ type: "text", text: "hello world" }],
    aborted: false,
    compacted: false,
    error: null,
    continuationDisposition: "retain",
    ...overrides,
  };
}

describe("executeWorkflowTaskRun", () => {
  beforeEach(() => {
    pendingRunTaskRunInvocations = [];
    resetActors();
    resetRuntime();
    _resetExecuteWorkflowTaskRunForTesting();
    setMachineFactory(createTestMachine);
    setEnsureConversationActorDeps({
      loadActorInput: async () => makeActorInputData(),
    });
  });

  afterEach(() => {
    _resetMachineFactoryForTesting();
    _resetEnsureConversationActorDepsForTesting();
    vi.clearAllMocks();
  });

  it("creates the conversation actor on first call and resolves a text task_run", async () => {
    expect(
      getConversationActor(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID),
    ).toBeUndefined();

    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "say hi",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    expect(invocation.input.promptText).toBe("say hi");
    invocation.resolve(defaultResult());

    const result = await callPromise;

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe("hello world");
      expect(result.usage.costUsd).toBe(0.0123);
      expect(result.usage.durationMs).toBe(456);
    }
    expect(
      getConversationActor(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID),
    ).toBeDefined();
  });

  it("releases a settled conversation chain from the in-flight registry", async () => {
    const call = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "one turn",
      timeoutMs: 5000,
    });

    expect(_getExecuteWorkflowTaskRunInFlightCountForTesting()).toBe(1);
    const invocation = await nextPendingInvocation();
    invocation.resolve(defaultResult());
    await call;
    await Promise.resolve();

    expect(_getExecuteWorkflowTaskRunInFlightCountForTesting()).toBe(0);
  });

  it("reuses the existing actor on a second call with the same identifiers", async () => {
    const first = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "first",
      timeoutMs: 5000,
    });
    const inv1 = await nextPendingInvocation();
    inv1.resolve(
      defaultResult({ contentBlocks: [{ type: "text", text: "1" }] }),
    );
    await first;

    const actorAfterFirst = getConversationActor(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(actorAfterFirst).toBeDefined();

    const second = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "second",
      timeoutMs: 5000,
    });
    const inv2 = await nextPendingInvocation();
    inv2.resolve(
      defaultResult({ contentBlocks: [{ type: "text", text: "2" }] }),
    );
    await second;

    expect(
      getConversationActor(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID),
    ).toBe(actorAfterFirst);
  });

  it("returns an error, not the preceding turn's success, when a task_run is aborted mid-flight", async () => {
    // The machine actor persists across task-runs on the same conversation,
    // so `lastResult` still holds run 1's success when run 2 starts. An
    // abort mid-run-2 must not surface run 1's result as run 2's outcome —
    // for a validator turn that would report a stale PASS for a validation
    // that never ran.
    const first = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "first",
      timeoutMs: 5000,
    });
    const inv1 = await nextPendingInvocation();
    inv1.resolve(
      defaultResult({ contentBlocks: [{ type: "text", text: "PASS" }] }),
    );
    const firstResult = await first;
    expect(firstResult.kind).toBe("text");

    const second = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "second",
      timeoutMs: 5000,
    });
    // Wait until run 2 is genuinely in flight, then abort it.
    await nextPendingInvocation();
    const actor = getConversationActor(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    actor!.send({ type: "ABORT_TURN", reason: "user" });

    const secondResult = await second;

    expect(secondResult.kind).toBe("error");
    if (secondResult.kind === "error") {
      expect(secondResult.error).toContain("Aborted");
    }
  });

  it("returns the parsed structured output when outputFormat is set", async () => {
    const structured = { answer: 42, label: "the-meaning" };

    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "compute",
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { answer: { type: "number" }, label: { type: "string" } },
        },
      },
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    expect(invocation.input.outputFormat?.type).toBe("json_schema");
    invocation.resolve(
      defaultResult({
        contentBlocks: [],
        structuredOutput: structured,
      }),
    );

    const result = await callPromise;
    expect(result.kind).toBe("structured");
    if (result.kind === "structured") {
      expect(result.structuredOutput).toEqual(structured);
    }
  });

  it("returns the raw final text when outputFormat is omitted", async () => {
    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "echo",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    expect(invocation.input.outputFormat).toBeUndefined();
    invocation.resolve(
      defaultResult({
        contentBlocks: [
          { type: "text", text: "part-one " },
          { type: "text", text: "part-two" },
        ],
      }),
    );

    const result = await callPromise;
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe("part-one part-two");
    }
  });

  it("forwards timeoutMs through SUBMIT_TASK_RUN into the runTaskRun input", async () => {
    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "with-timeout",
      timeoutMs: 12_345,
    });

    const invocation = await nextPendingInvocation();
    expect(invocation.input.timeoutMs).toBe(12_345);
    invocation.resolve(defaultResult());

    const result = await callPromise;
    expect(result.kind).toBe("text");
  });

  it("forwards the server-derived fsWritePolicy through SUBMIT_TASK_RUN into the runTaskRun input", async () => {
    const fsWritePolicy = {
      mode: "allowlist" as const,
      allowWrite: [
        "/private/tmp/lane/scratch",
        "/private/tmp/lane/scratch/tmp",
      ],
      denyWrite: ["/private/repo/worktree"],
    };

    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "restricted turn",
      timeoutMs: 5000,
      fsWritePolicy,
    });

    const invocation = await nextPendingInvocation();
    // The machine event fold and the actor invoke input are two distinct hops;
    // a policy dropped at either one leaves the lane unrestricted with no other
    // signal, so the assertion is on the value the actor actually receives.
    expect(invocation.input.fsWritePolicy).toEqual(fsWritePolicy);
    invocation.resolve(defaultResult());

    const result = await callPromise;
    expect(result.kind).toBe("text");
  });

  it("leaves the runTaskRun input unrestricted when no fsWritePolicy is supplied", async () => {
    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "implementer turn",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    expect(invocation.input.fsWritePolicy).toBeUndefined();
    invocation.resolve(defaultResult());

    await callPromise;
  });

  it("forwards the structured-output transcript field into the runTaskRun input", async () => {
    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "generate message",
      outputFormat: {
        type: "json_schema",
        schema: { type: "object" },
      },
      structuredOutputTextField: "message",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    expect(invocation.input.structuredOutputTextField).toBe("message");
    invocation.resolve(
      defaultResult({
        contentBlocks: [{ type: "text", text: "Readable message" }],
        structuredOutput: { message: "Readable message" },
      }),
    );

    const result = await callPromise;
    expect(result.kind).toBe("structured");
  });

  it("resolves to an error TaskRunResult when the entrypoint timer fires", async () => {
    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "will-time-out",
      timeoutMs: 25,
    });

    // Pop the invocation off the queue but never resolve it — the local
    // timer must win and the entrypoint must surface the timeout as a
    // TaskRunResult error variant (not a thrown/rejected error).
    const invocation = await nextPendingInvocation();
    expect(invocation.input.timeoutMs).toBe(25);

    const result = await callPromise;
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("timed out after 25ms");
      expect(result.aborted).toBe(false);
    }
  });

  it("preserves a captured transcript on failed task_run results", async () => {
    const transcript = [
      {
        seq: 0,
        backend: "claude" as const,
        type: "assistant",
        raw: { type: "assistant", text: "partial analysis" },
      },
    ];
    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "will-error",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    invocation.resolve(
      defaultResult({
        contentBlocks: [],
        transcript,
        error: "backend error",
      }),
    );

    const result = await callPromise;
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toBe("backend error");
      expect(result.transcript).toEqual(transcript);
    }
  });

  it("preserves the adapter continuation verdict on failed task_run results", async () => {
    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "will-error-with-viable-session",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    invocation.resolve(
      defaultResult({
        backendRef: { backend: "claude", ref: "still-viable" },
        contentBlocks: [],
        error: "transient backend error",
        continuationDisposition: "retain",
      }),
    );

    const result = await callPromise;

    expect(result).toMatchObject({
      kind: "error",
      backendRef: { backend: "claude", ref: "still-viable" },
      continuationDisposition: "retain",
    });
  });

  it("pins the conversation actor to the provided worktreePath instead of the session worktree", async () => {
    const callPromise = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "resolve conflicts",
      worktreePath: "/test/project/.worktrees/lane-feature",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    invocation.resolve(defaultResult());
    await callPromise;

    const actor = getConversationActor(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(actor).toBeDefined();
    expect(actor!.getSnapshot().context.worktreePath).toBe(
      "/test/project/.worktrees/lane-feature",
    );
  });

  it("rebinds an existing idle actor bound elsewhere to the requested worktreePath", async () => {
    const first = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "first",
      timeoutMs: 5000,
    });
    const inv1 = await nextPendingInvocation();
    inv1.resolve(defaultResult());
    await first;

    const actorAfterFirst = getConversationActor(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(actorAfterFirst!.getSnapshot().context.worktreePath).toBe(
      "/test/project/.worktrees/test-session",
    );

    const second = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "second",
      worktreePath: "/test/project/.worktrees/lane-feature",
      timeoutMs: 5000,
    });
    const inv2 = await nextPendingInvocation();
    inv2.resolve(defaultResult());
    await second;

    const actorAfterSecond = getConversationActor(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(actorAfterSecond!.getSnapshot().context.worktreePath).toBe(
      "/test/project/.worktrees/lane-feature",
    );
    expect(actorAfterSecond).not.toBe(actorAfterFirst);
  });

  it("serializes concurrent calls so a second call only starts after the first finalizes", async () => {
    let firstSettled = false;

    const first = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "first",
      timeoutMs: 5000,
    }).then((res) => {
      firstSettled = true;
      return res;
    });

    const inv1 = await nextPendingInvocation();
    expect(inv1.input.promptText).toBe("first");

    // Second call is started while the first turn is in flight. It must not
    // dispatch its SUBMIT_TASK_RUN until the first finalizes, so no new
    // runTaskRun invocation should be observable yet.
    const second = executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      kind: "task_run",
      prompt: "second",
      timeoutMs: 5000,
    });

    // Give the event loop a couple of ticks to expose any incorrect parallel
    // dispatch.
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingRunTaskRunInvocations).toHaveLength(0);
    expect(firstSettled).toBe(false);

    inv1.resolve(
      defaultResult({ contentBlocks: [{ type: "text", text: "A" }] }),
    );
    const firstResult = await first;
    expect(firstSettled).toBe(true);
    expect(firstResult.kind).toBe("text");

    const inv2 = await nextPendingInvocation();
    expect(inv2.input.promptText).toBe("second");
    inv2.resolve(
      defaultResult({ contentBlocks: [{ type: "text", text: "B" }] }),
    );
    const secondResult = await second;
    expect(secondResult.kind).toBe("text");
    if (secondResult.kind === "text") {
      expect(secondResult.text).toBe("B");
    }
  });

  // Project compaction and ticket generation both address this entrypoint with
  // the project store key (there is no session to name), and its two lifecycle
  // events reported that key as a session identity (R1.3).
  describe("project-scope diagnostics", () => {
    async function runProjectTaskRun(log: CapturingLogger) {
      setEnsureConversationActorDeps({
        loadActorInput: async () =>
          makeActorInputData({
            conversationScope: "project",
            sessionWorktreePath: PROJECT_PATH,
          }),
      });

      const call = executeWorkflowTaskRun(
        {
          projectPath: PROJECT_PATH,
          sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
          conversationId: CONVERSATION_ID,
          kind: "task_run",
          prompt: "summarize",
          timeoutMs: 5000,
        },
        { log },
      );
      const invocation = await nextPendingInvocation();
      invocation.resolve(defaultResult());
      return call;
    }

    it("emits scope:project from the dispatch and finalized events", async () => {
      const log = createCapturingLogger();
      const result = await runProjectTaskRun(log);

      expect(result.kind).toBe("text");
      const lifecycle = log.entries.filter((e) =>
        e.message.startsWith("conversation.execute_workflow_task_run."),
      );
      expect(lifecycle.map((e) => e.message)).toEqual([
        "conversation.execute_workflow_task_run.dispatch",
        "conversation.execute_workflow_task_run.finalized",
      ]);
      for (const entry of lifecycle) {
        expect(entry.fields).toMatchObject({
          scope: "project",
          conversationId: CONVERSATION_ID,
        });
        expect(entry.fields).not.toHaveProperty("sessionName");
      }
      expect(log.allFieldValues()).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    });

    it("still names the real session for a session-scoped task run", async () => {
      const log = createCapturingLogger();
      const call = executeWorkflowTaskRun(
        {
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          conversationId: CONVERSATION_ID,
          kind: "task_run",
          prompt: "summarize",
          timeoutMs: 5000,
        },
        { log },
      );
      const invocation = await nextPendingInvocation();
      invocation.resolve(defaultResult());
      await call;

      const dispatch = log.entries.find(
        (e) => e.message === "conversation.execute_workflow_task_run.dispatch",
      );
      expect(dispatch?.fields).toMatchObject({
        scope: "session",
        sessionName: SESSION_NAME,
      });
    });
  });
});
