import { ephemeralConversationPersistence } from "./persistence-adapter";
import { createConversationManagerFixture } from "@/lib/workflows/conversation/testing/manager-fixture";
import type { ConversationManagerDependencies } from "@/lib/workflows/conversation/manager";
import type { EnsureActorInputData } from "@/lib/workflows/conversation/actor-input-loader";
let machineFactory: NonNullable<
  Parameters<typeof createConversationManagerFixture>[0]
>["machine"];
let actorInputLoader: ConversationManagerDependencies["loadActorInput"] =
  async () => {
    throw new Error("Fixture actor loader is not configured");
  };
let admissionReader: ConversationManagerDependencies["readAdmissionState"] =
  async () => ({ found: true, requiresQueueReview: false });
import { getConversationQueueDeps as currentQueueDependencies } from "@/lib/conversations/message-queue-drain";
import { admitConversationProfileForTurn as admitFixtureProfile } from "@/lib/conversations/profile-admission";
const managerFixture: ReturnType<typeof createConversationManagerFixture> =
  createConversationManagerFixture({
    loadActors: async () => conversationActors,
    machine: (adapter, deps) =>
      machineFactory
        ? machineFactory(adapter, deps)
        : managerFixture.providedMachine(adapter),
    dependencies: {
      persistence: () => ephemeralConversationPersistence,
      forgetPersistence: () => {},
      admitProfileForTurn: (identity) => admitFixtureProfile(identity),
      loadActorInput: (...args) => actorInputLoader(...args),
      readAdmissionState: (...args) => admissionReader(...args),
      queue: {
        submitTurn: (...args) => currentQueueDependencies().submitTurn(...args),
        claimNextTurnBatch: (...args) =>
          currentQueueDependencies().claimNextTurnBatch(...args),
        markPending: (...args) =>
          currentQueueDependencies().markPending(...args),
        markDelivered: (...args) =>
          currentQueueDependencies().markDelivered(...args),
        markFailed: (...args) => currentQueueDependencies().markFailed(...args),
        recoverAbandonedDeliveries: (...args) =>
          currentQueueDependencies().recoverAbandonedDeliveries(...args),
        runConversationCommand: (...args) =>
          currentQueueDependencies().runConversationCommand(...args),
      },
    },
  });
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
let conversationActors: ReturnType<typeof createTestActorImplementations>;
import { classifyFailureForBackend } from "./failure-classification";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  setConversationProfileAdmissionDeps,
  _resetConversationProfileAdmissionDepsForTesting,
} from "@/lib/conversations/profile-admission";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import {
  setConversationQueueDeps,
  _resetConversationQueueDepsForTesting,
} from "@/lib/conversations/message-queue-drain";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
/**
 * Tests for `executeWorkflowTaskRun` — the named entrypoint that routes
 * workflow callers through the conversation actor for `task_run` turns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { PromptActorResult } from "./types";

import {
  _resetForTesting as resetRuntime,
  getConversationRuntime,
  conversationRuntimeKey,
} from "./runtime-state";

import { createActorDependenciesFixture } from "./testing/actor-deps-fixture";
import type {
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";

import { createConflictResolver } from "@/lib/sessions/conflict-resolution";
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

type RunTaskRunInvocation = {
  input: AgentTaskRequest;
  resolve(result: PromptActorResult): void;
};

let pendingRunTaskRunInvocations: RunTaskRunInvocation[] = [];

async function nextPendingInvocation(): Promise<RunTaskRunInvocation> {
  await vi.waitFor(() =>
    expect(pendingRunTaskRunInvocations.length).toBeGreaterThan(0),
  );
  return pendingRunTaskRunInvocations.shift()!;
}

function runTask(
  input: AgentTaskRequest,
  backend: AgentBackendId,
): Promise<AgentTaskResult> {
  return new Promise((resolve) => {
    const abort = () =>
      resolve({
        text: "",
        usage: {},
        error:
          input.signal?.reason === "timeout"
            ? `task_run timed out after ${input.timeoutMs}ms`
            : "Aborted",
        timedOut: input.signal?.reason === "timeout",
        failure: {
          kind: input.signal?.reason === "timeout" ? "timeout" : "aborted",
          message:
            input.signal?.reason === "timeout"
              ? `task_run timed out after ${input.timeoutMs}ms`
              : "Aborted",
          retryable: false,
        },
        continuationDisposition: "retain",
      });
    input.signal?.addEventListener("abort", abort, { once: true });
    pendingRunTaskRunInvocations.push({
      input,
      resolve(result) {
        input.signal?.removeEventListener("abort", abort);
        resolve({
          text: result.contentBlocks
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(""),
          usage: {
            ...(result.costUsd !== null ? { costUsd: result.costUsd } : {}),
            ...(result.durationMs !== null
              ? { durationMs: result.durationMs }
              : {}),
            ...(result.contextTokens !== null
              ? { contextTokens: result.contextTokens }
              : {}),
            ...(result.contextWindow !== null
              ? { contextWindowMax: result.contextWindow }
              : {}),
          },
          error: result.error,
          timedOut: result.abortReason === "timeout",
          ...(result.structuredOutput !== undefined
            ? { structuredOutput: result.structuredOutput }
            : {}),
          ...(result.transcript ? { transcript: result.transcript } : {}),
          ...(result.backendRef ? { backendRef: result.backendRef } : {}),
          failure:
            result.failure ??
            (result.aborted
              ? {
                  kind: "aborted",
                  message: result.error ?? "Aborted",
                  retryable: false,
                }
              : result.error
                ? classifyFailureForBackend(backend, result.error)
                : null),
          continuationDisposition: result.continuationDisposition,
        });
      },
    });
    if (input.signal?.aborted) abort();
  });
}

function createTestMachine(
  adapter: import("./persistence-adapter").ConversationPersistenceAdapter,
) {
  return managerFixture.providedMachine(adapter).provide({
    actions: {
      persistSnapshot: () => {},
      syncDerivedFields: () => {},
      broadcastConversationStatus: () => {},
      broadcastAskQuestion: () => {},
      broadcastDebugModeStatus: () => {},
      dispatchPushNotification: () => {},
    },
  });
}

function makeActorInputData(
  overrides: Partial<EnsureActorInputData> = {},
): EnsureActorInputData {
  return {
    conversationScope: "session",
    projectName: "project",
    sessionWorktreePath: "/test/project/.worktrees/test-session",
    persistence: "durable",
    conversation: {
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
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
    managerFixture.dispose();
    resetRuntime();

    machineFactory = createTestMachine;
    setConversationProfileAdmissionDeps({
      mutateConversation: async (_p, _s, _c, _l, mutate) =>
        mutate(
          conversationStateSchema.parse({
            id: CONVERSATION_ID,
            name: "test",
            transcriptPath: "/test.jsonl",
            status: "new",
            promptCount: 0,
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
    });
    setConversationQueueDeps({
      submitTurn: async () => ({
        kind: "refused",
        code: "busy",
        message: "test",
      }),
      claimNextTurnBatch: async () => null,
      markPending: async () => {},
      markDelivered: async () => {},
      markFailed: async () => {},
      recoverAbandonedDeliveries: async () => 0,
      runConversationCommand: async () => {
        throw new Error("No command expected");
      },
    });
    admissionReader = async () => ({ found: true, requiresQueueReview: false });
    conversationActors = createTestActorImplementations(
      createActorDependenciesFixture({
        getTaskRunner: (backend) => ({
          backend,
          run: (input) => runTask(input, backend),
        }),
      }),
    );
    actorInputLoader = async () => makeActorInputData();
  });

  afterEach(() => {
    _resetConversationProfileAdmissionDepsForTesting();
    _resetConversationQueueDepsForTesting();

    managerFixture.dispose();
    resetRuntime();

    vi.clearAllMocks();
  });

  it("creates the conversation actor on first call and resolves a text task_run", async () => {
    expect(
      managerFixture.actor(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID),
    ).toBeUndefined();

    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "say hi",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    expect(invocation.input.prompt).toBe("say hi");
    invocation.resolve(defaultResult());

    const result = await callPromise;

    expect(result).toMatchObject({ kind: "text" });
    if (result.kind === "text") {
      expect(result.text).toBe("hello world");
      expect(result.usage.costUsd).toBe(0.0123);
      expect(result.usage.durationMs).toBeNull();
    }
    expect(
      managerFixture.actor(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID),
    ).toBeDefined();
  });

  it("releases the admitted attempt after the task settles", async () => {
    const call = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "one turn",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    invocation.resolve(defaultResult());
    await call;
    await Promise.resolve();

    expect(
      getConversationRuntime(
        conversationRuntimeKey(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID),
      )?.attempt,
    ).toBeUndefined();
  });

  it("reuses the existing actor on a second call with the same identifiers", async () => {
    const first = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "first",
      timeoutMs: 5000,
    });
    const inv1 = await nextPendingInvocation();
    inv1.resolve(
      defaultResult({ contentBlocks: [{ type: "text", text: "1" }] }),
    );
    await first;

    const actorAfterFirst = managerFixture.actor(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(actorAfterFirst).toBeDefined();

    const second = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
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
      managerFixture.actor(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID),
    ).toBe(actorAfterFirst);
  });

  it("returns an error, not the preceding turn's success, when a task_run is aborted mid-flight", async () => {
    // The machine actor persists across task-runs on the same conversation,
    // so `lastResult` still holds run 1's success when run 2 starts. An
    // abort mid-run-2 must not surface run 1's result as run 2's outcome —
    // for a validator turn that would report a stale PASS for a validation
    // that never ran.
    const first = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
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

    const second = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "second",
      timeoutMs: 5000,
    });
    // Wait until run 2 is genuinely in flight, then abort it.
    await nextPendingInvocation();
    const actor = managerFixture.actor(
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

  it("cancels the in-flight turn and reports it as aborted when the caller's signal fires", async () => {
    const controller = new AbortController();
    const call = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "long resolution",
      timeoutMs: 5000,
      signal: controller.signal,
    });

    await nextPendingInvocation();
    controller.abort();

    const result = await call;

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      // The classification is what callers branch on: an aborted turn is not
      // retryable, unlike the backend failures that share the error variant.
      expect(result.aborted).toBe(true);
      expect(result.failure?.kind).toBe("aborted");
      expect(result.failure?.retryable).toBe(false);
    }
  });

  it("never dispatches a turn whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "already stopped",
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.failure?.kind).toBe("aborted");
    }
    expect(pendingRunTaskRunInvocations).toHaveLength(0);
  });

  it("returns the parsed structured output when outputFormat is set", async () => {
    const structured = { answer: 42, label: "the-meaning" };

    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
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
    expect(invocation.input.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "number" }, label: { type: "string" } },
    });
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
    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "echo",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    expect(invocation.input.outputSchema).toBeUndefined();
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
    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
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

    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "governed-execution" as const,
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
    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
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
    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
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
    expect(
      managerFixture
        .actor(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID)
        ?.getSnapshot().context.activeTurn,
    ).toMatchObject({ structuredOutputTextField: "message" });
    invocation.resolve(
      defaultResult({
        contentBlocks: [{ type: "text", text: "Readable message" }],
        structuredOutput: { message: "Readable message" },
      }),
    );

    const result = await callPromise;
    expect(result.kind).toBe("structured");
  });

  it("cancels the backend turn the entrypoint timer gave up on", async () => {
    // The timeout is what bounds a conflict resolver holding a worktree
    // mid-merge. Returning without cancelling would leave that agent editing
    // the tree while the caller's retry merges and dispatches into it again.

    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "will-time-out",
      timeoutMs: 25,
    });

    const invocation = await nextPendingInvocation();
    const result = await callPromise;

    expect(result.kind).toBe("error");
    expect(invocation.input.signal?.aborted).toBe(true);
    const actor = managerFixture.actor(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(actor?.getSnapshot().context.activeTurn).toBeNull();
  });

  it("resolves to an error TaskRunResult when the entrypoint timer fires", async () => {
    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "will-time-out",
      timeoutMs: 25,
    });

    // The runner unwinds on cancellation; the entrypoint must surface the
    // timeout as a TaskRunResult error after that work settles.
    const invocation = await nextPendingInvocation();
    expect(invocation.input.timeoutMs).toBe(25);

    const result = await callPromise;
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("timed out after 25ms");
      expect(result.aborted).toBe(false);
    }
  });

  // The conflict resolver is the caller whose turn must be bounded: it holds a
  // worktree mid-merge for as long as it runs. This is the only harness with a
  // real conversation actor behind the entrypoint, so the arming of the timer
  // and the resolver's reading of the result are proven together here.
  it("bounds a resolver turn that never returns, and the resolver calls it retryable", async () => {
    const resolution = createConflictResolver({
      executeWorkflowTaskRun: managerFixture.executeWorkflowTaskRun,
    }).resolveConflicts({
      worktreePath: "/test/project/.worktrees/test-session",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      resolutionTimeoutMs: 25,
    });

    const invocation = await nextPendingInvocation();
    expect(invocation.input.timeoutMs).toBe(25);

    const result = await resolution;
    expect(result.status).toBe("infrastructure");
    if (result.status !== "infrastructure") return;
    expect(result.failure.kind).toBe("timeout");
    expect(result.failure.retryable).toBe(true);
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
    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
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
    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
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
    const callPromise = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
        worktreePath: "/test/project/.worktrees/lane-feature",
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "resolve conflicts",
      timeoutMs: 5000,
    });

    const invocation = await nextPendingInvocation();
    invocation.resolve(defaultResult());
    await callPromise;

    const actor = managerFixture.actor(
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
    const first = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "first",
      timeoutMs: 5000,
    });
    const inv1 = await nextPendingInvocation();
    inv1.resolve(defaultResult());
    await first;

    const actorAfterFirst = managerFixture.actor(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(actorAfterFirst!.getSnapshot().context.worktreePath).toBe(
      "/test/project/.worktrees/test-session",
    );

    const second = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
        worktreePath: "/test/project/.worktrees/lane-feature",
      },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "second",
      timeoutMs: 5000,
    });
    const inv2 = await nextPendingInvocation();
    inv2.resolve(defaultResult());
    await second;

    const actorAfterSecond = managerFixture.actor(
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

    const first = managerFixture
      .executeWorkflowTaskRun({
        binding: {
          kind: "durable",
          address: {
            projectPath: PROJECT_PATH,
            target: targetFromStoreSessionName(
              "project",
              SESSION_NAME,
              CONVERSATION_ID,
            ),
          },
        },
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        prompt: "first",
        timeoutMs: 5000,
      })
      .then((res) => {
        firstSettled = true;
        return res;
      });

    const inv1 = await nextPendingInvocation();
    expect(inv1.input.prompt).toBe("first");

    // Second call is started while the first turn is in flight. It must not
    // dispatch its SUBMIT_TASK_RUN until the first finalizes, so no new
    // runTaskRun invocation should be observable yet.
    const second = managerFixture.executeWorkflowTaskRun({
      binding: {
        kind: "durable",
        address: {
          projectPath: PROJECT_PATH,
          target: targetFromStoreSessionName(
            "project",
            SESSION_NAME,
            CONVERSATION_ID,
          ),
        },
      },
      executionClass: "nongoverned-task" as const,
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
    expect(inv2.input.prompt).toBe("second");
    inv2.resolve(
      defaultResult({ contentBlocks: [{ type: "text", text: "B" }] }),
    );
    const secondResult = await second;
    expect(secondResult.kind).toBe("text");
    if (secondResult.kind === "text") {
      expect(secondResult.text).toBe("B");
    }
  });

  // A merge-conflict resolver turn that dies on a backend quota wall and a
  // resolver that read the conflict and gave up are the same bare string to
  // every caller downstream (ticket #71 defect 1). The error variant carries
  // the neutral classification so callers branch on `retryable`, not on prose.
  describe("failure classification", () => {
    const QUOTA_MESSAGE =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 19th, 2026 11:29 PM.";

    async function runFailingTaskRun(
      result: Partial<PromptActorResult>,
      backend: "claude" | "codex",
    ) {
      actorInputLoader = async () =>
        makeActorInputData({
          conversation: {
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            totalCostUsd: null,
            totalDurationMs: null,
            totalTurns: null,
            contextTokens: null,
            contextWindowMax: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            forkedFrom: null,
            role: null,
            transcriptPath: null,
            agentBackend: backend,
            backendRef: null,
            promptCount: 0,
            debugMode: null,
          },
        });

      const call = managerFixture.executeWorkflowTaskRun({
        binding: {
          kind: "durable",
          address: {
            projectPath: PROJECT_PATH,
            target: targetFromStoreSessionName(
              "project",
              SESSION_NAME,
              CONVERSATION_ID,
            ),
          },
        },
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        prompt: "resolve conflicts",
        timeoutMs: 5000,
      });
      const invocation = await nextPendingInvocation();
      invocation.resolve(defaultResult({ contentBlocks: [], ...result }));
      return call;
    }

    it("classifies a Codex quota refusal through the conversation's registered backend classifier", async () => {
      const result = await runFailingTaskRun({ error: QUOTA_MESSAGE }, "codex");

      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.failure).toEqual({
        kind: "quota_exhausted",
        message: QUOTA_MESSAGE,
        retryable: false,
        retryAfterHint: "Aug 19th, 2026 11:29 PM",
      });
    });

    it("classifies an ordinary backend failure as non-retryable backend_error", async () => {
      const result = await runFailingTaskRun(
        {
          error: "Codex Exec exited with code 1: Reading prompt from stdin...",
        },
        "codex",
      );

      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.failure).toEqual({
        kind: "backend_error",
        message: "Codex Exec exited with code 1: Reading prompt from stdin...",
        retryable: false,
      });
    });

    it("reports an aborted turn as the aborted classification, not as backend prose", async () => {
      const result = await runFailingTaskRun(
        { aborted: true, error: "Prompt execution was cancelled" },
        "claude",
      );

      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.aborted).toBe(true);
      expect(result.failure).toEqual({
        kind: "aborted",
        message: "Prompt execution was cancelled",
        retryable: false,
      });
    });

    it("classifies the entrypoint timeout as a timeout failure", async () => {
      const callPromise = managerFixture.executeWorkflowTaskRun({
        binding: {
          kind: "durable",
          address: {
            projectPath: PROJECT_PATH,
            target: targetFromStoreSessionName(
              "project",
              SESSION_NAME,
              CONVERSATION_ID,
            ),
          },
        },
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        prompt: "will-time-out",
        timeoutMs: 25,
      });
      await nextPendingInvocation();

      const result = await callPromise;
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.failure?.kind).toBe("timeout");
      expect(result.failure?.retryable).toBe(false);
    });
  });

  // Project compaction and ticket generation both address this entrypoint with
  // the project store key (there is no session to name), and its two lifecycle
  // events reported that key as a session identity (R1.3).
  describe("project-scope diagnostics", () => {
    async function runProjectTaskRun(log: CapturingLogger) {
      actorInputLoader = async () =>
        makeActorInputData({
          conversationScope: "project",
          sessionWorktreePath: PROJECT_PATH,
        });

      const call = managerFixture.executeWorkflowTaskRun(
        {
          binding: {
            kind: "durable",
            address: {
              projectPath: PROJECT_PATH,
              target: targetFromStoreSessionName(
                "project",
                PROJECT_CONVERSATION_SESSION_SENTINEL,
                CONVERSATION_ID,
              ),
            },
          },
          executionClass: "nongoverned-task" as const,
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
      const call = managerFixture.executeWorkflowTaskRun(
        {
          binding: {
            kind: "durable",
            address: {
              projectPath: PROJECT_PATH,
              target: targetFromStoreSessionName(
                "project",
                SESSION_NAME,
                CONVERSATION_ID,
              ),
            },
          },
          executionClass: "nongoverned-task" as const,
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
