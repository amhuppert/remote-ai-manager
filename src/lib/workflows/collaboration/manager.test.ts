/**
 * Collaboration Mode manager tests.
 *
 * The manager has narrow responsibilities (validation, session resolution,
 * background dispatch, status reads) so the tests are correspondingly
 * narrow: they assert that input validation rejects bad payloads, that the
 * slice is invoked with the right input shape, that the session-resolution
 * gate produces a typed error, and that envelope status reads delegate to
 * the repository factory.
 *
 * No `vi.mock`. All deps are injected via `createCollaborationManager`.
 */
import { describe, it, expect } from "vitest";

import {
  createCollaborationManager,
  createInMemoryCollaborationStopRegistry,
  CollaborationConversationMismatchError,
  CollaborationConversationNotFoundError,
  CollaborationNotPausedError,
  CollaborationNotStoppableError,
  CollaborationResumeTokenMismatchError,
  CollaborationSessionNotFoundError,
  CollaborationWorkflowNotFoundError,
  type CollaborationManagerDeps,
  type CollaborationStopRegistry,
} from "./manager";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type { CollaborationArtifact } from "./types";
import type {
  AsymmetricCollaborationSliceDeps,
  AsymmetricCollaborationSliceInput,
  AsymmetricCollaborationSliceResult,
} from "./envelope";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import { createWorkflowEnvelopeRepository } from "@/lib/workflows/primitives/workflow-envelope-repository";
import type { WorkflowEnvelope } from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import type { PublishScopedStatusEventInput } from "@/lib/workflows/primitives/default-session-status-bus";

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-test",
    workflowType: "collaboration",
    status: "running",
    phase: "round_1",
    createdAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
    featureSnapshot: { brief: "design X", round: 1 },
    ...overrides,
  };
}

function makeStubSliceDeps(): AsymmetricCollaborationSliceDeps {
  // The manager only forwards this object to runSlice; tests substitute
  // runSlice itself, so the slice deps shape is irrelevant beyond being
  // present. Cast intentionally minimizes setup noise.
  return {} as AsymmetricCollaborationSliceDeps;
}

interface ScriptedDepsOptions {
  resolveSessionResult?: { worktreePath: string } | null | "throw";
  resolveConversationResult?:
    | {
        agentBackend: AgentBackendId;
        backendRef?: AgentSessionRef | null;
      }
    | null
    | "throw";
  runSliceResult?: AsymmetricCollaborationSliceResult;
  runSliceError?: Error;
  envelopeStoreOverride?: ReturnType<
    typeof createInMemoryWorkflowEnvelopeStore
  >;
  stopRegistryOverride?: CollaborationStopRegistry;
  sliceDepsOverride?: AsymmetricCollaborationSliceDeps;
  resolveCodexModelConfigResult?: { model: string; reasoningEffort?: string };
  resolveClaudeModelConfigResult?: { model: string; reasoningEffort?: string };
  /**
   * In-memory stand-in for the durable artifacts sidecar keyed by workflowId.
   * The manager's `getEnvelope`/`listActive`/`listAll` read from here to
   * re-inject `featureSnapshot.artifacts`, so a test can assert the
   * client-visible hydration without touching the filesystem.
   */
  artifactSidecar?: Map<string, CollaborationArtifact[]>;
}

function buildScriptedDeps(options: ScriptedDepsOptions = {}): {
  deps: Partial<CollaborationManagerDeps>;
  runSliceCalls: Array<{
    input: AsymmetricCollaborationSliceInput;
    deps: AsymmetricCollaborationSliceDeps;
  }>;
  buildCallAgentCalls: Array<{
    workflowId: string;
    worktreePath: string;
    codexModel?: string;
    codexReasoningEffort?: string;
    claudeModel?: string;
    claudeReasoningEffort?: string;
  }>;
  publishedStatuses: Array<
    Omit<
      PublishScopedStatusEventInput,
      "scope" | "scopeId" | "projectName" | "sessionName"
    > & {
      projectPath: string;
      sessionName: string;
      workflowId: string;
    }
  >;
  dispatchedPushes: Array<
    Parameters<CollaborationManagerDeps["dispatchPush"]>[0]
  >;
  envelopeStore: ReturnType<typeof createInMemoryWorkflowEnvelopeStore>;
  runSliceCompletion: Promise<void>;
  stopRegistry: CollaborationStopRegistry;
} {
  const runSliceCalls: Array<{
    input: AsymmetricCollaborationSliceInput;
    deps: AsymmetricCollaborationSliceDeps;
  }> = [];
  const buildCallAgentCalls: Array<{
    workflowId: string;
    worktreePath: string;
    codexModel?: string;
    codexReasoningEffort?: string;
    claudeModel?: string;
    claudeReasoningEffort?: string;
  }> = [];
  const publishedStatuses: Array<
    Omit<
      PublishScopedStatusEventInput,
      "scope" | "scopeId" | "projectName" | "sessionName"
    > & {
      projectPath: string;
      sessionName: string;
      workflowId: string;
    }
  > = [];
  const dispatchedPushes: Array<
    Parameters<CollaborationManagerDeps["dispatchPush"]>[0]
  > = [];
  let resolveCompletion: () => void = () => undefined;
  const runSliceCompletion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const envelopeStore =
    options.envelopeStoreOverride ?? createInMemoryWorkflowEnvelopeStore();
  const stopRegistry =
    options.stopRegistryOverride ?? createInMemoryCollaborationStopRegistry();

  let workflowIdCounter = 0;

  const deps: Partial<CollaborationManagerDeps> = {
    resolveSession: async () => {
      if (options.resolveSessionResult === "throw") {
        throw new Error("synthetic resolveSession failure");
      }
      if (options.resolveSessionResult === null) return null;
      return (
        options.resolveSessionResult ?? {
          worktreePath: "/tmp/example/.worktrees/sess-1",
        }
      );
    },
    resolveConversation: async () => {
      if (options.resolveConversationResult === "throw") {
        throw new Error("synthetic resolveConversation failure");
      }
      if (options.resolveConversationResult === null) return null;
      return (
        options.resolveConversationResult ?? {
          agentBackend: "claude",
          backendRef: null,
        }
      );
    },
    stopRegistry,
    createDeps: () => options.sliceDepsOverride ?? makeStubSliceDeps(),
    buildLaneService: () =>
      createLaneService({ store: createInMemoryLaneStore() }),
    buildCallAgent: (input) => {
      buildCallAgentCalls.push({
        workflowId: input.workflowId,
        worktreePath: input.worktreePath,
        codexModel: input.codexModel,
        codexReasoningEffort: input.codexReasoningEffort,
        claudeModel: input.claudeModel,
        claudeReasoningEffort: input.claudeReasoningEffort,
      });
      return async () => {
        throw new Error("stub callAgent should not be called in tests");
      };
    },
    resolveCodexModelConfig: async () =>
      options.resolveCodexModelConfigResult ?? { model: "gpt-5.4" },
    resolveClaudeModelConfig: async () =>
      options.resolveClaudeModelConfigResult ?? { model: "opus" },
    runSlice: async (input, sliceDeps) => {
      runSliceCalls.push({ input, deps: sliceDeps });
      try {
        if (options.runSliceError) throw options.runSliceError;
        return (
          options.runSliceResult ?? {
            kind: "completed_final",
            finalAnswerArtifactId: "art-final",
            negotiationRoundsCompleted: 2,
          }
        );
      } finally {
        resolveCompletion();
      }
    },
    createEnvelopeRepository: () =>
      createWorkflowEnvelopeRepository({ store: envelopeStore }),
    readArtifacts: async (workflowId) =>
      options.artifactSidecar?.get(workflowId) ?? [],
    publishStatus: (input) => {
      publishedStatuses.push(input);
    },
    dispatchPush: (input) => {
      dispatchedPushes.push(input);
    },
    newWorkflowId: () => {
      workflowIdCounter += 1;
      return `wf-${workflowIdCounter}`;
    },
    now: () => "2026-04-28T10:00:00.000Z",
  };

  return {
    deps,
    runSliceCalls,
    buildCallAgentCalls,
    publishedStatuses,
    dispatchedPushes,
    envelopeStore,
    runSliceCompletion,
    stopRegistry,
  };
}

describe("createCollaborationManager.start", () => {
  it("rejects an empty brief via Zod", async () => {
    const { deps } = buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        conversationId: "conv-1",
      }),
    ).rejects.toThrow();
  });

  it("rejects out-of-range negotiationRounds via Zod", async () => {
    const { deps } = buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 0,
        autonomousResolutionThreshold: "major",
        conversationId: "conv-1",
      }),
    ).rejects.toThrow();
  });

  it("rejects an invalid autonomousResolutionThreshold via Zod", async () => {
    const { deps } = buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "extreme" as unknown as "major",
        conversationId: "conv-1",
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty conversationId via Zod", async () => {
    const { deps } = buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        conversationId: "",
      }),
    ).rejects.toThrow();
  });

  it("throws CollaborationSessionNotFoundError when the session does not exist", async () => {
    const { deps } = buildScriptedDeps({ resolveSessionResult: null });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "missing",
        brief: "design X",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        conversationId: "conv-1",
      }),
    ).rejects.toBeInstanceOf(CollaborationSessionNotFoundError);
  });

  it("throws CollaborationConversationNotFoundError when the conversation does not exist", async () => {
    const { deps } = buildScriptedDeps({
      resolveSessionResult: { worktreePath: "/wt/abc" },
      resolveConversationResult: null,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        conversationId: "missing-conv",
      }),
    ).rejects.toBeInstanceOf(CollaborationConversationNotFoundError);
  });

  it("derives the primary agent backend from the conversation's agent backend", async () => {
    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps({
      resolveSessionResult: { worktreePath: "/wt/abc" },
      resolveConversationResult: { agentBackend: "codex" },
    });
    const manager = createCollaborationManager(deps);

    const result = await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      negotiationRounds: 4,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
    });

    expect(result).toEqual({ workflowId: "wf-1", status: "started" });

    await runSliceCompletion;

    expect(runSliceCalls).toHaveLength(1);
    const call = runSliceCalls[0];
    if (!call) throw new Error("expected one runSlice call");
    expect(call.input).toMatchObject({
      workflowId: "wf-1",
      brief: "design X",
      worktreePath: "/wt/abc",
      sessionKey: "/p::s",
      negotiationRounds: 4,
      primaryAgentBackend: "codex",
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
    });
    expect(call.input.stopSignal).toBeInstanceOf(AbortSignal);
  });

  it("uses claude as the primary agent backend when the conversation backend is claude", async () => {
    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps({
      resolveSessionResult: { worktreePath: "/wt/abc" },
      resolveConversationResult: { agentBackend: "claude" },
    });
    const manager = createCollaborationManager(deps);

    await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
    });

    await runSliceCompletion;

    const call = runSliceCalls[0];
    if (!call) throw new Error("expected one runSlice call");
    expect(call.input.primaryAgentBackend).toBe("claude");
  });

  it("forwards the workflowId, worktreePath, and resolved codex + claude model config to buildCallAgent", async () => {
    const { deps, buildCallAgentCalls, runSliceCompletion } = buildScriptedDeps(
      {
        resolveSessionResult: { worktreePath: "/wt/xyz" },
        resolveCodexModelConfigResult: {
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
        resolveClaudeModelConfigResult: {
          model: "sonnet",
          reasoningEffort: "xhigh",
        },
      },
    );
    const manager = createCollaborationManager(deps);

    await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      negotiationRounds: 2,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
    });

    await runSliceCompletion;

    expect(buildCallAgentCalls).toEqual([
      {
        workflowId: "wf-1",
        worktreePath: "/wt/xyz",
        codexModel: "gpt-5.5",
        codexReasoningEffort: "high",
        claudeModel: "sonnet",
        claudeReasoningEffort: "xhigh",
      },
    ]);
  });

  it("threads conversation.backendRef into sliceInput.priorBackendRef when present", async () => {
    const savedRef: AgentSessionRef = {
      backend: "claude",
      sessionId: "claude-saved-session",
    };
    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps({
      resolveSessionResult: { worktreePath: "/wt/abc" },
      resolveConversationResult: {
        agentBackend: "claude",
        backendRef: savedRef,
      },
    });
    const manager = createCollaborationManager(deps);

    await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
    });

    await runSliceCompletion;

    const call = runSliceCalls[0];
    if (!call) throw new Error("expected one runSlice call");
    expect(call.input.priorBackendRef).toEqual(savedRef);
  });

  it("passes priorBackendRef as undefined when conversation.backendRef is null", async () => {
    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps({
      resolveSessionResult: { worktreePath: "/wt/abc" },
      resolveConversationResult: {
        agentBackend: "claude",
        backendRef: null,
      },
    });
    const manager = createCollaborationManager(deps);

    await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
    });

    await runSliceCompletion;

    const call = runSliceCalls[0];
    if (!call) throw new Error("expected one runSlice call");
    expect(call.input.priorBackendRef).toBeUndefined();
  });

  it("threads a codex-typed conversation.backendRef into sliceInput.priorBackendRef", async () => {
    const savedRef: AgentSessionRef = {
      backend: "codex",
      threadId: "codex-saved-thread",
    };
    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps({
      resolveSessionResult: { worktreePath: "/wt/abc" },
      resolveConversationResult: {
        agentBackend: "codex",
        backendRef: savedRef,
      },
    });
    const manager = createCollaborationManager(deps);

    await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
    });

    await runSliceCompletion;

    const call = runSliceCalls[0];
    if (!call) throw new Error("expected one runSlice call");
    expect(call.input.priorBackendRef).toEqual(savedRef);
  });

  it("does not throw when the slice fails — failures are logged, not surfaced", async () => {
    const { deps, runSliceCompletion } = buildScriptedDeps({
      runSliceError: new Error("synthetic slice failure"),
    });
    const manager = createCollaborationManager(deps);

    const result = await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      negotiationRounds: 2,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
    });

    expect(result.status).toBe("started");
    // The background promise rejection should be swallowed by the manager's
    // own .catch handler, so awaiting completion should resolve cleanly.
    await expect(runSliceCompletion).resolves.toBeUndefined();
  });

  it("marks the originating conversation awaiting when the background slice throws", async () => {
    const metadataCalls: Array<{
      conversationId: string;
      workflowId: string;
      timestamp: string;
    }> = [];
    let resolveMetadataSynced: () => void = () => undefined;
    const metadataSynced = new Promise<void>((resolve) => {
      resolveMetadataSynced = resolve;
    });
    const { deps, runSliceCompletion, envelopeStore, publishedStatuses } =
      buildScriptedDeps({
        runSliceError: new Error("synthetic slice failure"),
        sliceDepsOverride: {
          ...makeStubSliceDeps(),
          markConversationAwaiting: async (conversationId, input) => {
            metadataCalls.push({ conversationId, ...input });
            resolveMetadataSynced();
          },
        },
      });
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-1",
        status: "running",
        featureSnapshot: { brief: "design X", conversationId: "conv-1" },
      }),
    );
    const manager = createCollaborationManager(deps);

    await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      negotiationRounds: 2,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
    });
    await runSliceCompletion;
    await Promise.race([
      metadataSynced,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for metadata sync")),
          100,
        ),
      ),
    ]);

    expect(metadataCalls).toEqual([
      {
        conversationId: "conv-1",
        workflowId: "wf-1",
        timestamp: "2026-04-28T10:00:00.000Z",
      },
    ]);
    const reread = await repo.get("wf-1");
    expect(reread?.status).toBe("failed");
    expect(reread?.phase).toBe("failed_unhandled");
    expect(reread?.errorSummary).toBe("synthetic slice failure");
    expect(publishedStatuses).toContainEqual(
      expect.objectContaining({
        workflowId: "wf-1",
        status: "failed",
        payload: expect.objectContaining({
          kind: "asymmetric_failed",
          errorSummary: "synthetic slice failure",
        }),
      }),
    );
  });
});

describe("createCollaborationManager.getEnvelope / listActive", () => {
  it("returns the envelope from the repository", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(buildEnvelope({ workflowId: "wf-known" }));

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    const env = await manager.getEnvelope({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-known",
    });

    expect(env?.workflowId).toBe("wf-known");
  });

  it("hydrates featureSnapshot.artifacts from the sidecar so the client-visible shape is unchanged", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-hydrate",
        featureSnapshot: { brief: "design X", conversationId: "conv-1" },
      }),
    );

    const sidecar = new Map<string, CollaborationArtifact[]>([
      [
        "wf-hydrate",
        [
          {
            kind: "final_answer",
            agent: "agent_one",
            answer: "ship it",
            report: "r",
            supporting: [],
          },
        ],
      ],
    ]);

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
      artifactSidecar: sidecar,
    });
    const manager = createCollaborationManager(deps);

    const env = await manager.getEnvelope({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-hydrate",
    });

    const snapshot = env?.featureSnapshot as Record<string, unknown>;
    // Existing bounded blob fields survive, and the stream is spliced back in.
    expect(snapshot["brief"]).toBe("design X");
    const artifacts = snapshot["artifacts"] as Array<{ kind: string }>;
    expect(artifacts.map((a) => a.kind)).toEqual(["final_answer"]);
  });

  it("skips hydration for workflow-origin collaboration envelopes so the durable stream is not dropped by the user schema", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-graph-collab",
        featureSnapshot: { origin: "workflow", executionContextId: "ctx-1" },
      }),
    );

    // The workflow path persists a differently-shaped artifact wrapper to the
    // sidecar; the user schema would reject it, so hydration MUST be skipped
    // rather than silently emptying the stream onto the snapshot.
    const sidecar = new Map<string, CollaborationArtifact[]>([
      [
        "wf-graph-collab",
        [
          {
            kind: "final_answer",
            agent: "agent_one",
            answer: "x",
            report: "r",
            supporting: [],
          },
        ],
      ],
    ]);

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
      artifactSidecar: sidecar,
    });
    const manager = createCollaborationManager(deps);

    const env = await manager.getEnvelope({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-graph-collab",
    });

    const snapshot = env?.featureSnapshot as Record<string, unknown>;
    expect(snapshot["origin"]).toBe("workflow");
    expect(snapshot["artifacts"]).toBeUndefined();
  });

  it("does not inject an artifacts field into non-collaboration envelopes from getEnvelope", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-graph",
        workflowType: "graph_workflow",
        featureSnapshot: { someField: "v" },
      }),
    );

    const { deps } = buildScriptedDeps({ envelopeStoreOverride: envelopeStore });
    const manager = createCollaborationManager(deps);

    const env = await manager.getEnvelope({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-graph",
    });

    const snapshot = env?.featureSnapshot as Record<string, unknown>;
    expect(snapshot["someField"]).toBe("v");
    expect("artifacts" in snapshot).toBe(false);
  });

  it("filters listActive to collaboration envelopes only", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-collab",
        workflowType: "collaboration",
        status: "running",
      }),
    );
    await repo.create(
      buildEnvelope({
        workflowId: "wf-other",
        workflowType: "graph_workflow",
        status: "running",
      }),
    );

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    const active = await manager.listActive({
      projectPath: "/p",
      sessionName: "s",
    });

    expect(active.map((e) => e.workflowId)).toEqual(["wf-collab"]);
  });
});

describe("createCollaborationManager.resume", () => {
  it("rejects an empty resumeToken via Zod", async () => {
    const { deps } = buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    await expect(
      manager.resume({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-1",
        resumeToken: "",
        conversationId: "conv-1",
        userAnswers: {},
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty conversationId via Zod", async () => {
    const { deps } = buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    await expect(
      manager.resume({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-1",
        resumeToken: "tok",
        conversationId: "",
        userAnswers: {},
      }),
    ).rejects.toThrow();
  });

  it("throws CollaborationWorkflowNotFoundError when the envelope is missing", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.resume({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-missing",
        resumeToken: "tok",
        conversationId: "conv-1",
        userAnswers: {},
      }),
    ).rejects.toBeInstanceOf(CollaborationWorkflowNotFoundError);
  });

  it("throws CollaborationConversationMismatchError when the supplied conversationId does not own the workflow", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-paused",
        status: "running",
        featureSnapshot: { brief: "design X", conversationId: "conv-A" },
      }),
    );
    await repo.markPaused("wf-paused", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "tok",
    });

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.resume({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-paused",
        resumeToken: "tok",
        conversationId: "conv-B",
        userAnswers: {},
      }),
    ).rejects.toBeInstanceOf(CollaborationConversationMismatchError);
  });

  it("throws CollaborationNotPausedError when the workflow is not paused", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-running",
        status: "running",
        featureSnapshot: { brief: "design X", conversationId: "conv-1" },
      }),
    );

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.resume({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-running",
        resumeToken: "tok",
        conversationId: "conv-1",
        userAnswers: {},
      }),
    ).rejects.toBeInstanceOf(CollaborationNotPausedError);
  });

  it("throws CollaborationResumeTokenMismatchError when the token does not match", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-paused",
        status: "running",
        featureSnapshot: { brief: "design X", conversationId: "conv-1" },
      }),
    );
    await repo.markPaused("wf-paused", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "secret-token",
    });

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.resume({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-paused",
        resumeToken: "wrong-token",
        conversationId: "conv-1",
        userAnswers: {},
      }),
    ).rejects.toBeInstanceOf(CollaborationResumeTokenMismatchError);
  });

  it("marks the envelope running and records userAnswers when the token matches", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-paused",
        status: "running",
        featureSnapshot: {
          brief: "design X",
          negotiationRounds: 5,
          negotiationRoundsCompleted: 2,
          conversationId: "conv-1",
          primaryAgentBackend: "claude",
          autonomousResolutionThreshold: "major",
        },
      }),
    );
    await repo.markPaused("wf-paused", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "good-token",
    });

    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    const result = await manager.resume({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-paused",
      resumeToken: "good-token",
      conversationId: "conv-1",
      userAnswers: { q1: "yes", q2: "no" },
    });

    expect(result).toEqual({ workflowId: "wf-paused", status: "resumed" });

    const reread = await repo.get("wf-paused");
    expect(reread?.status).toBe("running");
    expect(reread?.pause).toBeUndefined();
    const snapshot = reread?.featureSnapshot as Record<string, unknown>;
    expect(snapshot["userAnswersByQuestionId"]).toEqual({
      q1: "yes",
      q2: "no",
    });

    await runSliceCompletion;
    expect(runSliceCalls).toHaveLength(1);
    expect(runSliceCalls[0]?.input.primaryAgentBackend).toBe("claude");
    expect(runSliceCalls[0]?.input.negotiationRounds).toBe(5);
    expect(runSliceCalls[0]?.input.autonomousResolutionThreshold).toBe("major");
    expect(runSliceCalls[0]?.input.resume?.userAnswersByQuestionId).toEqual({
      q1: "yes",
      q2: "no",
    });
  });
});

describe("createCollaborationManager.stop", () => {
  it("rejects an empty conversationId via Zod", async () => {
    const { deps } = buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    await expect(
      manager.stop({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-1",
        conversationId: "",
      }),
    ).rejects.toThrow();
  });

  it("throws CollaborationWorkflowNotFoundError when the envelope is missing", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.stop({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-missing",
        conversationId: "conv-1",
      }),
    ).rejects.toBeInstanceOf(CollaborationWorkflowNotFoundError);
  });

  it("throws CollaborationConversationMismatchError when the conversationId does not own the workflow", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-1",
        status: "running",
        featureSnapshot: { brief: "design X", conversationId: "conv-A" },
      }),
    );

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.stop({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-1",
        conversationId: "conv-B",
      }),
    ).rejects.toBeInstanceOf(CollaborationConversationMismatchError);
  });

  it("throws CollaborationNotStoppableError when the workflow is already completed", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-done",
        status: "running",
        featureSnapshot: { brief: "design X", conversationId: "conv-1" },
      }),
    );
    await repo.markCompleted("wf-done");

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.stop({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-done",
        conversationId: "conv-1",
      }),
    ).rejects.toBeInstanceOf(CollaborationNotStoppableError);
  });

  it("transitions a running workflow to completed_unresolved with reason user_stopped and no merged artifact", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-1",
        status: "running",
        featureSnapshot: {
          brief: "design X",
          conversationId: "conv-1",
          status: "running",
        },
      }),
    );

    const stopRegistry = createInMemoryCollaborationStopRegistry();
    const controller = stopRegistry.register("wf-1");

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
      stopRegistryOverride: stopRegistry,
    });
    const manager = createCollaborationManager(deps);

    const result = await manager.stop({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-1",
      conversationId: "conv-1",
    });

    expect(result).toEqual({ workflowId: "wf-1", status: "stopped" });
    expect(controller.signal.aborted).toBe(true);

    const reread = await repo.get("wf-1");
    expect(reread?.status).toBe("completed");
    expect(reread?.phase).toBe("asymmetric_user_stopped");
    expect(reread?.errorSummary).toContain("stopped");
    const snapshot = reread?.featureSnapshot as Record<string, unknown>;
    expect(snapshot["status"]).toBe("completed_unresolved");
    expect(snapshot["unresolvedReason"]).toBe("user_stopped");
  });

  it("transitions a paused workflow to completed_unresolved and clears the pause", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-paused",
        status: "running",
        featureSnapshot: { brief: "design X", conversationId: "conv-1" },
      }),
    );
    await repo.markPaused("wf-paused", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "tok",
    });

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    const result = await manager.stop({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-paused",
      conversationId: "conv-1",
    });

    expect(result).toEqual({ workflowId: "wf-paused", status: "stopped" });

    const reread = await repo.get("wf-paused");
    expect(reread?.status).toBe("completed");
    expect(reread?.phase).toBe("asymmetric_user_stopped");
    expect(reread?.pause).toBeUndefined();
  });

  it("publishes terminal status and push notification when direct stop completes a paused workflow", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-paused-notify",
        status: "running",
        featureSnapshot: {
          brief: "design X",
          conversationId: "conv-1",
          negotiationRoundsCompleted: 2,
          status: "paused",
        },
      }),
    );
    await repo.markPaused("wf-paused-notify", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "tok",
    });

    const { deps, publishedStatuses, dispatchedPushes } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    await manager.stop({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-paused-notify",
      conversationId: "conv-1",
    });

    expect(publishedStatuses).toEqual([
      {
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-paused-notify",
        status: "completed",
        timestamp: "2026-04-28T10:00:00.000Z",
        reason: "user_stopped",
        payload: {
          kind: "completed_unresolved",
          reason: "user_stopped",
          negotiationRoundsCompleted: 2,
        },
      },
    ]);
    expect(dispatchedPushes).toEqual([
      {
        kind: "completed-unresolved",
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-paused-notify",
        reason: "user_stopped",
      },
    ]);
  });
});
