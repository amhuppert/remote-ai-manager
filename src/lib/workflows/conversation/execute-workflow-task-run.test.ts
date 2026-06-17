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
  _resetExecuteWorkflowTaskRunForTesting,
} from "./execute-workflow-task-run";

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
          error: null,
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
    projectName: "test-project",
    sessionWorktreePath: "/test/project/.worktrees/test-session",
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
    error: null,
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
});
