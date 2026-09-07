import { runtimeConfigurationFixture } from "./testing/runtime-configuration-fixture";
import {
  conversationTargetStoreSessionName,
  targetFromStoreSessionName,
} from "@/lib/conversations/conversation-target";
import { createConversationManagerFixture } from "@/lib/workflows/conversation/testing/manager-fixture";

import { admitConversationProfileForTurn as admitFixtureProfile } from "@/lib/conversations/profile-admission";
const managerFixture: ReturnType<typeof createConversationManagerFixture> =
  createConversationManagerFixture({
    loadActors: async () => conversationActors,
    dependencies: {
      admitProfileForTurn: (identity) => admitFixtureProfile(identity),
    },
  });
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
let conversationActors: ReturnType<typeof createTestActorImplementations>;
import type {
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import { afterEach, expect, it, vi } from "vitest";

import {
  getConversationRuntime,
  conversationRuntimeKey,
  _resetForTesting as resetRuntime,
  type ConversationRuntimeState,
} from "./runtime-state";
import {
  registerRuntime,
  unregisterRuntime,
  _resetForTesting as resetBackendIndex,
} from "@/lib/agent-backends/runtime-registry";
import {
  createMockBackendRuntime,
  createActorDependenciesFixture,
} from "./testing/actor-deps-fixture";
import type { ConversationInput } from "./types";

import type { AgentSessionRef } from "@/lib/shared/schemas";

const backendIndex = {
  register: registerRuntime,
  unregister: unregisterRuntime,
};
function installBackend(
  runtime: ConversationRuntimeState,
  backend: ReturnType<typeof createMockBackendRuntime>,
): void {
  runtime.managed.install(
    runtime.managed.beginCreation(),
    backend,
    runtimeConfigurationFixture({
      backend: backend.backend,
      modelSelection: backend.modelSelection,
    }),
    backendIndex,
  );
}

const input: ConversationInput = {
  persistence: "ephemeral",
  projectPath: "/cancel-test",
  target: targetFromStoreSessionName("cancel-test", "test", "cancel-test"),

  worktreePath: "/cancel-test",
  createdAt: "2026-09-06T00:00:00.000Z",
  lastActivityAt: "2026-09-06T00:00:00.000Z",
  agentBackend: "claude",
  backendRef: null,
  role: null,
  transcriptPath: null,
  forkedFrom: null,
  promptCount: 0,
  totalCostUsd: null,
  totalDurationMs: null,
  totalTurns: null,
  contextTokens: null,
  contextWindowMax: null,
};

afterEach(() => {
  managerFixture.dispose();
  resetRuntime();
  resetBackendIndex();
});

it("keeps the host owned until backend close actually finishes", async () => {
  const actor = managerFixture.host.start(input);
  let unblock!: () => void;
  const close = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const backend = createMockBackendRuntime({ close: () => close });
  const runtime = getConversationRuntime(
    conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    ),
  );
  if (!runtime) throw new Error("Missing runtime fixture");
  installBackend(runtime, backend);
  let settled = false;
  const stopping = Promise.resolve(
    managerFixture.manager.stopConversationActor(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
      "test",
    ),
  ).then(() => {
    settled = true;
  });
  try {
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(
      managerFixture.actor(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
    ).toBe(actor);
  } finally {
    unblock();
    await stopping;
  }
  expect(
    managerFixture.actor(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    ),
  ).toBeUndefined();
});

it("forwards a persisted task continuation through a fresh ephemeral host", async () => {
  const resumeRef: AgentSessionRef = {
    backend: "codex",
    ref: "thread-before-restart",
  };
  let observed: AgentSessionRef | null | undefined;
  conversationActors = createTestActorImplementations(
    createActorDependenciesFixture({
      getTaskRunner: () => ({
        backend: "codex",
        async run(request) {
          observed = request.resumeRef;
          return {
            backendRef: resumeRef,
            text: "continued",
            usage: null,
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      }),
    }),
  );
  const result = await managerFixture.manager.executeConversationTurn({
    binding: {
      kind: "ephemeral",
      address: {
        projectPath: input.projectPath,
        target: {
          scope: "session",
          projectName: input.target.projectName,
          sessionName: conversationTargetStoreSessionName(input.target),
          conversationId: input.target.conversationId,
        },
      },
      backend: "codex",
      worktreePath: input.worktreePath,
      role: null,
    },
    turn: {
      kind: "task_run",
      promptText: "Continue",
      executionClass: "nongoverned-task",
      resumeRef,
    },
  });
  expect(result).toMatchObject({
    kind: "settled",
    turn: {
      outcome: {
        kind: "call_result",
        result: { outcome: { kind: "completed" } },
      },
    },
  });
  expect(observed).toEqual(resumeRef);
});

const binding = {
  kind: "ephemeral" as const,
  address: {
    projectPath: input.projectPath,
    target: {
      scope: "session" as const,
      projectName: input.target.projectName,
      sessionName: conversationTargetStoreSessionName(input.target),
      conversationId: input.target.conversationId,
    },
  },
  backend: "claude" as const,
  worktreePath: input.worktreePath,
  role: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it("cancels a full semaphore waiter without dispatching after capacity is released", async () => {
  const {
    acquireQuerySlot,
    setQuerySemaphoreDeps,
    resetQuerySemaphoreDeps,
    getQuerySemaphoreStatus,
  } = await import("@/lib/shared/query-semaphore");
  setQuerySemaphoreDeps({
    readConfig: async () => ({ maxConcurrentQueries: 1 }),
  });
  const releaseIncumbent = await acquireQuerySlot("incumbent");
  let dispatched = 0;
  let locked = false;
  conversationActors = createTestActorImplementations(
    createActorDependenciesFixture({
      acquireQuerySlot,
      acquireConversationLock: () => {
        locked = true;
        return () => {
          locked = false;
        };
      },
      getTaskRunner: () => ({
        backend: "claude",
        async run() {
          dispatched++;
          return {
            text: "should not run",
            usage: null,
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      }),
    }),
  );
  try {
    const admission = await managerFixture.manager.submitConversationTurn({
      binding,
      turn: {
        kind: "task_run",
        promptText: "cancel while queued",
        executionClass: "nongoverned-task",
      },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    await vi.waitFor(() => expect(getQuerySemaphoreStatus().waiting).toBe(1));
    expect(locked).toBe(true);
    const turn = await admission.turn.cancel("user");
    expect(turn.outcome).toMatchObject({
      kind: "not_started",
      reason: "cancelled",
    });
    expect(locked).toBe(false);
    expect(getQuerySemaphoreStatus()).toMatchObject({ active: 1, waiting: 0 });
    releaseIncumbent();
    await Promise.resolve();
    expect(dispatched).toBe(0);
    expect(getQuerySemaphoreStatus().active).toBe(0);
  } finally {
    releaseIncumbent();
    resetQuerySemaphoreDeps();
  }
});

it("holds the conversation lock until cancelled preparation has unwound", async () => {
  const transcript = deferred<string>();
  let preparing = false;
  let locked = false;
  conversationActors = createTestActorImplementations(
    createActorDependenciesFixture({
      acquireConversationLock: () => {
        locked = true;
        return () => {
          locked = false;
        };
      },
      getTranscriptPath: () => {
        preparing = true;
        return transcript.promise;
      },
    }),
  );
  const admission = await managerFixture.manager.submitConversationTurn({
    binding,
    turn: {
      kind: "task_run",
      promptText: "prepare",
      executionClass: "nongoverned-task",
    },
  });
  if (admission.kind !== "accepted") throw new Error(admission.message);
  await vi.waitFor(() => expect(preparing).toBe(true));
  let completed = false;
  const stopping = admission.turn.cancel("user").then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(locked).toBe(true);
  expect(completed).toBe(false);
  transcript.resolve("/transcript");
  await stopping;
  expect(locked).toBe(false);
});

it("admits debug retry as a distinct attempt and preserves its prompt", async () => {
  const preparation = deferred<string>();
  let preparations = 0;
  conversationActors = createTestActorImplementations(
    createActorDependenciesFixture({
      getTranscriptPath: async () => {
        preparations++;
        if (preparations === 1) throw new Error("Transcript unavailable");
        return preparation.promise;
      },
    }),
  );
  const actor = managerFixture.host.start(input);
  const { createDebugAdapter } = await import("./debug-adapter");
  const adapter = createDebugAdapter({
    executeCommand: (_target, command) =>
      managerFixture.manager.executeConversationCommand(
        binding.address,
        command,
      ),
  });
  const target = {
    projectPath: input.projectPath,
    sessionName: conversationTargetStoreSessionName(input.target),
    conversationId: input.target.conversationId,
  };
  expect(
    await adapter.enterDebugMode(target, { logFilePath: "/debug/log.jsonl" }),
  ).toEqual({ kind: "applied" });
  const first = await managerFixture.manager.submitConversationTurn({
    binding,
    turn: { promptText: "Preserved retry prompt" },
  });
  if (first.kind !== "accepted") throw new Error(first.message);
  await first.turn.completed;
  expect(actor.getSnapshot().context.debugMode?.lastTurnFailed).toBe(true);
  expect(await adapter.retryDebugTurn(target)).toEqual({ kind: "applied" });
  const runtime = getConversationRuntime(
    conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    ),
  )!;
  const retry = runtime.attempt!;
  expect(retry.attemptId).not.toBe(first.turn.attemptId);
  expect(actor.getSnapshot().context.activeTurn).toMatchObject({
    promptText: "Preserved retry prompt",
    executionAttemptId: retry.attemptId,
  });
  expect(actor.getSnapshot().context.debugMode?.lastTurnFailed).toBe(false);
  await first.turn.cancel("user");
  expect(retry.controller.signal.aborted).toBe(false);
  const cancelled = retry.cancel("user");
  preparation.resolve("/transcript");
  await cancelled;
});

it("waits for a timed-out task to unwind before admitting the next task and ignores its stale handle", async () => {
  const firstResult = deferred<AgentTaskResult>();
  const secondResult = deferred<AgentTaskResult>();
  const calls: AgentTaskRequest[] = [];
  conversationActors = createTestActorImplementations(
    createActorDependenciesFixture({
      getTaskRunner: () => ({
        backend: "claude",
        run(request) {
          calls.push(request);
          return calls.length === 1
            ? firstResult.promise
            : secondResult.promise;
        },
      }),
    }),
  );
  const first = await managerFixture.manager.submitConversationTurn({
    binding,
    turn: {
      kind: "task_run",
      promptText: "A",
      executionClass: "nongoverned-task",
      timeoutMs: 100,
    },
  });
  if (first.kind !== "accepted") throw new Error(first.message);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  const second = managerFixture.manager.submitConversationTurn({
    binding,
    turn: {
      kind: "task_run",
      promptText: "B",
      executionClass: "nongoverned-task",
    },
    waitUntilReady: true,
  });
  await vi.waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
  expect(calls).toHaveLength(1);
  firstResult.resolve({
    text: null,
    usage: null,
    error: "timed out",
    timedOut: true,
    failure: { kind: "timeout", message: "timed out", retryable: false },
    continuationDisposition: "retain",
  });
  const a = await first.turn.completed;
  expect(a.outcome).toMatchObject({
    kind: "call_result",
    result: { outcome: { kind: "failed", error: { failureKind: "timeout" } } },
  });
  const acceptedSecond = await second;
  if (acceptedSecond.kind !== "accepted")
    throw new Error(acceptedSecond.message);
  expect(acceptedSecond.turn.attemptId).not.toBe(first.turn.attemptId);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await first.turn.cancel("user");
  const actor = managerFixture.actor(
    input.projectPath,
    conversationTargetStoreSessionName(input.target),
    input.target.conversationId,
  )!;
  actor.send({
    type: "BACKEND_INIT",
    executionAttemptId: first.turn.attemptId,
    backendRef: { backend: "claude", ref: "stale" },
  });
  expect(actor.getSnapshot().context.backendRef).toBeNull();
  expect(calls[1]?.signal?.aborted).toBe(false);
  secondResult.resolve({
    text: "B result",
    usage: null,
    error: null,
    timedOut: false,
    failure: null,
    continuationDisposition: "retain",
  });
  const b = await acceptedSecond.turn.completed;
  expect(b.outcome).toMatchObject({
    kind: "call_result",
    result: { outcome: { kind: "completed", text: "B result" } },
  });
});

it("stops and drains an external turn that never sends a completion event", async () => {
  const { createExternalTurnHandler } = await import("./external-turn-handler");
  const append = deferred<void>();
  let writing = false;
  const actor = managerFixture.host.start(input);
  const runtime = getConversationRuntime(
    conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    ),
  )!;
  const incarnation = runtime.managed.beginCreation();
  const written: string[] = [];
  const handler = createExternalTurnHandler(
    { conversationId: input.target.conversationId },
    {
      isCurrent: () => runtime.managed.isCurrent(incarnation),
      sendToMachine: (event) => actor.send(event),
    },
    {
      safeAppendTranscriptEntry: async (_id, entry) => {
        writing = true;
        await append.promise;
        written.push(entry.type);
      },
    },
  );
  runtime.managed.install(
    incarnation,
    createMockBackendRuntime(),
    runtimeConfigurationFixture(),
    backendIndex,
    handler,
  );
  handler({ type: "external_turn_started" });
  handler({
    type: "transcript_entry",
    entry: {
      seq: 1,
      backend: "claude",
      type: "assistant",
      raw: {
        timestamp: "2026-09-06T00:00:00Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "external" }],
      },
    },
  });
  await vi.waitFor(() => expect(writing).toBe(true));
  let stopped = false;
  const stopping = managerFixture.manager
    .stopConversationActor(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
      "external-stop",
    )
    .then(() => {
      stopped = true;
    });
  await Promise.resolve();
  expect(stopped).toBe(false);
  append.resolve();
  await stopping;
  expect(written).toEqual(["assistant"]);
  runtime.managed.beginCreation();
  handler({ type: "external_turn_started" });
  await handler.drain();
  expect(
    managerFixture.actor(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    ),
  ).toBeUndefined();
});

it("closes the replacement backend when cancellation follows a readiness recreation", async () => {
  const provider = deferred<AgentTaskResult>();
  let dispatched = false;
  conversationActors = createTestActorImplementations(
    createActorDependenciesFixture({
      getTaskRunner: () => ({
        backend: "claude",
        run() {
          dispatched = true;
          return provider.promise;
        },
      }),
    }),
  );
  const admitted = await managerFixture.manager.submitConversationTurn({
    binding,
    turn: {
      kind: "task_run",
      promptText: "recreate then stop",
      executionClass: "nongoverned-task",
    },
  });
  if (admitted.kind !== "accepted") throw new Error(admitted.message);
  await vi.waitFor(() => expect(dispatched).toBe(true));
  const runtime = getConversationRuntime(
    conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    ),
  )!;
  const original = createMockBackendRuntime();
  installBackend(runtime, original);
  await runtime.attempt!.closeBackend();
  const closeReplacement = vi.fn(async () => {});
  const replacement = createMockBackendRuntime({ close: closeReplacement });
  installBackend(runtime, replacement);
  const stopping = admitted.turn.cancel("user");
  try {
    await vi.waitFor(() => expect(closeReplacement).toHaveBeenCalledTimes(1));
  } finally {
    provider.resolve({
      text: null,
      usage: null,
      error: "Aborted",
      timedOut: false,
      failure: { kind: "aborted", message: "Aborted", retryable: false },
      continuationDisposition: "retain",
    });
    await stopping;
  }
});

it("refuses admission while an idle backend is still closing", async () => {
  const close = deferred<void>();
  conversationActors = createTestActorImplementations(
    createActorDependenciesFixture({
      getTaskRunner: () => ({
        backend: "claude",
        async run() {
          return {
            text: "unexpected admission",
            usage: null,
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      }),
    }),
  );
  managerFixture.host.start(input);
  const runtime = getConversationRuntime(
    conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    ),
  )!;
  installBackend(
    runtime,
    createMockBackendRuntime({
      close: () => close.promise,
    }),
  );

  const stopping = managerFixture.manager.requestConversationStop(
    binding.address,
    "user",
  );
  try {
    const submitted = await managerFixture.manager.submitConversationTurn({
      binding,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "during close",
      },
    });
    expect(submitted).toMatchObject({ kind: "refused", code: "busy" });
  } finally {
    close.resolve();
    await stopping.settled;
  }
});

it("reconciles a failed backend close before the host can be reused", async () => {
  managerFixture.host.start(input);
  const runtime = getConversationRuntime(
    conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    ),
  )!;
  let closes = 0;
  installBackend(
    runtime,
    createMockBackendRuntime({
      close: async () => {
        if (++closes === 1) throw new Error("Close unavailable");
      },
    }),
  );

  await expect(
    managerFixture.manager.requestConversationStop(binding.address, "user")
      .settled,
  ).rejects.toThrow("Close unavailable");
  expect(
    await managerFixture.manager.submitConversationTurn({
      binding,
      turn: { promptText: "Cannot reuse" },
    }),
  ).toMatchObject({ kind: "refused", code: "busy" });
  await managerFixture.manager.ensureConversationLifecycle(binding);
  expect(closes).toBe(2);
  expect(runtime.stopping).toBeUndefined();
  expect(runtime.managed.backend).toBeUndefined();
});
