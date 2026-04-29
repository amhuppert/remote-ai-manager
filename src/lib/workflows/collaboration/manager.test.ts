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
  CollaborationNotPausedError,
  CollaborationResumeTokenMismatchError,
  CollaborationSessionNotFoundError,
  CollaborationWorkflowNotFoundError,
  type CollaborationManagerDeps,
} from "./manager";
import type {
  CollaborationSliceDeps,
  CollaborationSliceInput,
  CollaborationSliceResult,
} from "./slice";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import { createWorkflowEnvelopeRepository } from "@/lib/workflows/primitives/workflow-envelope-repository";
import type { WorkflowEnvelope } from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";

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

function makeStubSliceDeps(): CollaborationSliceDeps {
  // The manager only forwards this object to runSlice; tests substitute
  // runSlice itself, so the slice deps shape is irrelevant beyond being
  // present. Cast intentionally minimizes setup noise.
  return {} as CollaborationSliceDeps;
}

interface ScriptedDepsOptions {
  resolveSessionResult?: { worktreePath: string } | null | "throw";
  runSliceResult?: CollaborationSliceResult;
  runSliceError?: Error;
  envelopeStoreOverride?: ReturnType<
    typeof createInMemoryWorkflowEnvelopeStore
  >;
}

function buildScriptedDeps(options: ScriptedDepsOptions = {}): {
  deps: Partial<CollaborationManagerDeps>;
  runSliceCalls: Array<{
    input: CollaborationSliceInput;
    deps: CollaborationSliceDeps;
  }>;
  buildCallAgentCalls: Array<{
    workflowId: string;
    worktreePath: string;
  }>;
  envelopeStore: ReturnType<typeof createInMemoryWorkflowEnvelopeStore>;
  runSliceCompletion: Promise<void>;
} {
  const runSliceCalls: Array<{
    input: CollaborationSliceInput;
    deps: CollaborationSliceDeps;
  }> = [];
  const buildCallAgentCalls: Array<{
    workflowId: string;
    worktreePath: string;
  }> = [];
  let resolveCompletion: () => void = () => undefined;
  const runSliceCompletion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const envelopeStore =
    options.envelopeStoreOverride ?? createInMemoryWorkflowEnvelopeStore();

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
    createDeps: () => makeStubSliceDeps(),
    buildLaneService: () =>
      createLaneService({ store: createInMemoryLaneStore() }),
    buildCallAgent: (input) => {
      buildCallAgentCalls.push({
        workflowId: input.workflowId,
        worktreePath: input.worktreePath,
      });
      return async () => {
        throw new Error("stub callAgent should not be called in tests");
      };
    },
    runSlice: async (input, sliceDeps) => {
      runSliceCalls.push({ input, deps: sliceDeps });
      try {
        if (options.runSliceError) throw options.runSliceError;
        return (
          options.runSliceResult ?? {
            kind: "completed",
            rounds: 2,
            mergedDesignArtifactId: "art-1",
            transcriptArtifactId: "art-2",
            openQuestionsArtifactId: "art-3",
          }
        );
      } finally {
        resolveCompletion();
      }
    },
    createEnvelopeRepository: () =>
      createWorkflowEnvelopeRepository({ store: envelopeStore }),
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
    envelopeStore,
    runSliceCompletion,
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
        maxIterations: 3,
        scribeBackend: "claude",
      }),
    ).rejects.toThrow();
  });

  it("rejects out-of-range maxIterations via Zod", async () => {
    const { deps } = buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        maxIterations: 0,
        scribeBackend: "claude",
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
        maxIterations: 3,
        scribeBackend: "claude",
      }),
    ).rejects.toBeInstanceOf(CollaborationSessionNotFoundError);
  });

  it("returns a workflowId immediately and runs the slice in the background", async () => {
    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps({
      resolveSessionResult: { worktreePath: "/wt/abc" },
    });
    const manager = createCollaborationManager(deps);

    const result = await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      maxIterations: 4,
      scribeBackend: "codex",
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
      maxIterations: 4,
      scribeBackend: "codex",
    });
  });

  it("forwards the workflowId and worktreePath to buildCallAgent", async () => {
    const { deps, buildCallAgentCalls, runSliceCompletion } = buildScriptedDeps(
      {
        resolveSessionResult: { worktreePath: "/wt/xyz" },
      },
    );
    const manager = createCollaborationManager(deps);

    await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      maxIterations: 2,
      scribeBackend: "claude",
    });

    await runSliceCompletion;

    expect(buildCallAgentCalls).toEqual([
      { workflowId: "wf-1", worktreePath: "/wt/xyz" },
    ]);
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
      maxIterations: 2,
      scribeBackend: "claude",
    });

    expect(result.status).toBe("started");
    // The background promise rejection should be swallowed by the manager's
    // own .catch handler, so awaiting completion should resolve cleanly.
    await expect(runSliceCompletion).resolves.toBeUndefined();
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
        userAnswers: {},
      }),
    ).rejects.toBeInstanceOf(CollaborationWorkflowNotFoundError);
  });

  it("throws CollaborationNotPausedError when the workflow is not paused", async () => {
    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-running",
        status: "running",
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
        featureSnapshot: { brief: "design X", rounds: 2 },
      }),
    );
    await repo.markPaused("wf-paused", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "good-token",
    });

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    const result = await manager.resume({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-paused",
      resumeToken: "good-token",
      userAnswers: { q1: "yes", q2: "no" },
    });

    expect(result).toEqual({ workflowId: "wf-paused", status: "resumed" });

    const reread = await repo.get("wf-paused");
    expect(reread?.status).toBe("running");
    expect(reread?.pause).toBeUndefined();
    const snapshot = reread?.featureSnapshot as Record<string, unknown>;
    expect(snapshot["userAnswersByRound"]).toEqual({
      "2": { q1: "yes", q2: "no" },
    });
  });
});
