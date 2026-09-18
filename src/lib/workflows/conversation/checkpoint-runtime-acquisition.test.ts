import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createActorDependenciesFixture,
  groupActorFixtureDependencies,
  createMockBackendRuntime,
} from "./testing/actor-deps-fixture";
import { createManagedRuntimeFixture } from "./testing/runtime-binding-fixture";
import {
  registerConversationRuntime,
  conversationRuntimeKey,
  _resetForTesting,
} from "./runtime-state";
import {
  createConversationActorImplementations,
  type CheckpointCaptureRuntimeInput,
} from "./actor-implementations";

const input: CheckpointCaptureRuntimeInput = {
  target: {
    scope: "session",
    projectName: "repo",
    sessionName: "session",
    conversationId: "conv",
  },
  projectPath: "/repo",
  worktreePath: "/repo/worktree",
  agentBackend: "claude",
  modelSelection: { modelId: "opus", parameters: { effort: "high" } },
  backendRef: { backend: "claude", ref: "source-ref" },
  captureId: "capture",
  mode: "tool-disabled",
};
afterEach(() => _resetForTesting());
describe("checkpoint runtime acquisition", () => {
  it("resumes a dormant source under its maintenance purpose without ordinary context delivery", async () => {
    const deps = createActorDependenciesFixture({ executeAgentCall: vi.fn() });
    const actors = createConversationActorImplementations(
      groupActorFixtureDependencies(deps),
    );
    const key = conversationRuntimeKey(input.projectPath, "session", "conv");
    const managed = createManagedRuntimeFixture(key);
    registerConversationRuntime(key, {
      managed,
      abortController: new AbortController(),
    });
    const result = await actors.acquireCheckpointCaptureRuntime(input);
    expect(result).toBeDefined();
    expect(managed.backend).toBe(result);
    expect(
      deps.getConversationBackendFactory("claude").createRuntime,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPurpose: {
          kind: "checkpoint_handoff",
          captureId: "capture",
          mode: "tool-disabled",
        },
        persistedRef: input.backendRef,
        modelSelection: input.modelSelection,
        sessionInstructions: [],
      }),
    );
    expect(deps.getReferenceDocuments).not.toHaveBeenCalled();
    expect(deps.executeAgentCall).not.toHaveBeenCalled();
    expect(deps.mutateConversation).not.toHaveBeenCalled();
  });
  it("reuses a matching live owner and refuses a changed model without replacing it", async () => {
    const deps = createActorDependenciesFixture({ executeAgentCall: vi.fn() });
    const actors = createConversationActorImplementations(
      groupActorFixtureDependencies(deps),
    );
    const key = conversationRuntimeKey(input.projectPath, "session", "conv");
    const backend = createMockBackendRuntime({ notifyTurnStarting: vi.fn() });
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key, backend),
      abortController: new AbortController(),
    });
    expect(await actors.acquireCheckpointCaptureRuntime(input)).toBe(backend);
    expect(
      await actors.acquireCheckpointCaptureRuntime({
        ...input,
        modelSelection: { modelId: "other", parameters: {} },
      }),
    ).toBeUndefined();
    expect(
      deps.getConversationBackendFactory("claude").createRuntime,
    ).not.toHaveBeenCalled();
    expect(backend.close).not.toHaveBeenCalled();
    expect(backend.notifyTurnStarting).toHaveBeenCalledOnce();
  });
  it("resolves dormant selection read-only from the existing backend defaults", async () => {
    const deps = createActorDependenciesFixture();
    const actors = createConversationActorImplementations(
      groupActorFixtureDependencies(deps),
    );
    const selection = await actors.resolveCheckpointCaptureSelection({
      agentBackend: "claude",
      projectPath: "/repo",
      transcriptPath: "/source",
    });
    expect(selection).toEqual(input.modelSelection);
    expect(deps.readConversationMessages).toHaveBeenCalledWith("/source");
    expect(deps.getConversationBackendFactory).not.toHaveBeenCalled();
    expect(deps.mutateConversation).not.toHaveBeenCalled();
  });
  it("installs a runtime before observing cancellation so cleanup stays owned", async () => {
    const controller = new AbortController();
    const backend = createMockBackendRuntime();
    const deps = createActorDependenciesFixture({
      getConversationBackendFactory: () => ({
        backend: "claude",
        async createRuntime() {
          controller.abort();
          return backend;
        },
      }),
    });
    const actors = createConversationActorImplementations(
      groupActorFixtureDependencies(deps),
    );
    const key = conversationRuntimeKey(input.projectPath, "session", "conv");
    const managed = createManagedRuntimeFixture(key);
    registerConversationRuntime(key, {
      managed,
      abortController: new AbortController(),
    });
    await expect(
      actors.acquireCheckpointCaptureRuntime(input, controller.signal),
    ).rejects.toThrow();
    expect(backend.close).toHaveBeenCalledOnce();
    expect(deps.registerBackendRuntime).toHaveBeenCalledWith("conv", backend);
  });
});
