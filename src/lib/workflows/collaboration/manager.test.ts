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
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _resetLoggerForTesting } from "@/lib/logging/logger";
import { getDefaultStallTimeoutForBackend } from "@/lib/agent-backends/catalog";

import {
  buildStandaloneCollaborationCallerInput,
  createCollaborationStartPersister,
  createCollaborationManager,
  createCollaborationSessionContextResolver,
  resolveCollaborationBackendModelConfig,
  prepareCollaborationInitialImages,
  createInMemoryCollaborationStopRegistry,
  CollaborationStartConflictError,
  CollaborationConversationMismatchError,
  CollaborationConversationNotFoundError,
  CollaborationNotPausedError,
  CollaborationNotStoppableError,
  CollaborationProfileResolutionError,
  CollaborationResumeTokenMismatchError,
  CollaborationSessionNotFoundError,
  CollaborationWorkflowNotFoundError,
  type CollaborationManagerDeps,
  type CollaborationStopRegistry,
} from "./manager";
import type { CollaborationLaneAgentsInput } from "./agent-caller-production";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  EMPTY_COLLABORATION_SESSION_CONTEXT,
  MalformedCollaborationSessionContextError,
  MissingCollaborationSessionContextError,
  type CollaborationSessionContext,
  type CollaborationSessionContextDegradation,
} from "./session-context";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentSessionRef } from "@/lib/shared/schemas";
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
import { assembleUserContentBlocks } from "@/lib/workflows/conversation/assemble-user-blocks";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import type { PublishScopedStatusInput } from "@/lib/events/publication";
import { makeFinalAnswer } from "./test-fixtures";
import { buildCollaborationUserTranscriptEntry } from "./transcript";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createStateStore } from "@/lib/state-store/store";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import { seedWholeState } from "@/lib/shared/testing/whole-state-fixture";

describe("resolveCollaborationBackendModelConfig", () => {
  const config = {
    agentBackends: {
      claude: {
        model: "sonnet",
        reasoningEffort: "medium",
        timeoutMs: 45_000,
      },
      codex: {
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        fastMode: true,
        timeoutMs: null,
        stallTimeoutMs: 60_000,
      },
    },
  };

  it.each([
    [
      "claude" as const,
      {
        model: "sonnet",
        reasoningEffort: "medium",
        timeoutMs: 45_000,
        stallTimeoutMs: getDefaultStallTimeoutForBackend("claude"),
      },
    ],
    [
      "codex" as const,
      {
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        codexFastMode: true,
        timeoutMs: 0,
        stallTimeoutMs: 60_000,
      },
    ],
  ])("uses the configured %s profile", (backend, expected) => {
    expect(resolveCollaborationBackendModelConfig(config, backend)).toEqual(
      expected,
    );
  });
});

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

describe("collaboration start persistence", () => {
  function makeConversation(): ConversationState {
    return makeConversationState({
      id: "conv-1",
      name: "Conversation",
      status: "awaiting",
      promptCount: 4,
      lastActivityAt: "2026-07-13T12:00:00.000Z",
    });
  }

  it("rejects a stale concurrent start before appending its transcript", async () => {
    const conversation = makeConversation();
    const appendedIds: string[] = [];
    const persist = createCollaborationStartPersister({
      getTranscriptPath: async () => "/tmp/conv-1.jsonl",
      appendTranscriptEntryOnce: async (_conversationId, entry) => {
        appendedIds.push(entry.id);
      },
      mutateConversation: async (
        _project,
        _session,
        _conversation,
        _label,
        mutate,
      ) => mutate(conversation),
      now: () => "2026-07-13T13:00:00.000Z",
    });
    const input = {
      projectPath: "/p",
      sessionName: "s",
      conversationId: "conv-1",
      expectedPromptCount: 4,
      brief: "design X",
      imageRefs: [],
    };

    await persist({ ...input, workflowId: "wf-1" });
    await expect(
      persist({ ...input, workflowId: "wf-2" }),
    ).rejects.toBeInstanceOf(CollaborationStartConflictError);

    expect(appendedIds).toEqual(["collab-start:wf-1"]);
    expect(conversation.promptCount).toBe(5);
    expect(conversation.status).toBe("running");
  });

  it("compensates the conversation claim when transcript persistence fails", async () => {
    const conversation = makeConversation();
    const persist = createCollaborationStartPersister({
      getTranscriptPath: async () => "/tmp/conv-1.jsonl",
      appendTranscriptEntryOnce: async () => {
        throw new Error("disk full");
      },
      mutateConversation: async (
        _project,
        _session,
        _conversation,
        _label,
        mutate,
      ) => mutate(conversation),
      now: () => "2026-07-13T13:00:00.000Z",
    });

    await expect(
      persist({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-1",
        conversationId: "conv-1",
        expectedPromptCount: 4,
        brief: "design X",
        imageRefs: [],
      }),
    ).rejects.toThrow("disk full");

    expect(conversation.promptCount).toBe(4);
    expect(conversation.status).toBe("awaiting");
    expect(conversation.transcriptPath).toBeNull();
    expect(conversation.lastActivityAt).toBe("2026-07-13T12:00:00.000Z");
  });
});

interface ScriptedDepsOptions {
  resolveSessionResult?:
    | {
        worktreePath: string;
        creationMode?: SessionState["creationMode"] | undefined;
      }
    | null
    | "throw";
  resolveConversationResult?:
    | {
        agentBackend: AgentBackendId;
        backendRef?: AgentSessionRef | null;
        promptCount?: number;
        profileSnapshot?: AgentProfileSnapshot | null;
      }
    | null
    | "throw";
  runSliceResult?: AsymmetricCollaborationSliceResult;
  runSliceError?: Error;
  resolveAgentTwoProfileSnapshotError?: Error;
  envelopeStoreOverride?: ReturnType<
    typeof createInMemoryWorkflowEnvelopeStore
  >;
  stopRegistryOverride?: CollaborationStopRegistry;
  sliceDepsOverride?: AsymmetricCollaborationSliceDeps;
  resolveCodexModelConfigResult?: {
    model: string;
    reasoningEffort?: string;
    codexFastMode?: boolean;
    timeoutMs?: number;
    stallTimeoutMs?: number;
  };
  resolveClaudeModelConfigResult?: {
    model: string;
    reasoningEffort?: string;
    timeoutMs?: number;
    stallTimeoutMs?: number;
  };
  persistStartError?: Error;
  resolveSessionContextResult?: CollaborationSessionContext | Error;
  resolveSessionContextDegraded?: CollaborationSessionContextDegradation;
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
    agents: CollaborationLaneAgentsInput;
  }>;
  publishedStatuses: Array<
    Omit<
      PublishScopedStatusInput,
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
  persistedStarts: Array<
    Parameters<CollaborationManagerDeps["persistStart"]>[0]
  >;
  resolveSessionContextCalls: Array<
    Parameters<CollaborationManagerDeps["resolveSessionContext"]>[0]
  >;
  resolveProfileCalls: Array<
    Parameters<CollaborationManagerDeps["resolveAgentTwoProfileSnapshot"]>[0]
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
    agents: CollaborationLaneAgentsInput;
  }> = [];
  const publishedStatuses: Array<
    Omit<
      PublishScopedStatusInput,
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
  const persistedStarts: Array<
    Parameters<CollaborationManagerDeps["persistStart"]>[0]
  > = [];
  const resolveSessionContextCalls: Array<
    Parameters<CollaborationManagerDeps["resolveSessionContext"]>[0]
  > = [];
  const resolveProfileCalls: Array<
    Parameters<CollaborationManagerDeps["resolveAgentTwoProfileSnapshot"]>[0]
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
      const result = options.resolveConversationResult ?? {
        agentBackend: "claude",
        backendRef: null,
        promptCount: 0,
      };
      return { ...result, promptCount: result.promptCount ?? 0 };
    },
    prepareInitialImages: async ({
      conversationId,
      workflowId,
      brief,
      images,
    }) => {
      const assembled = assembleUserContentBlocks({
        promptText: brief,
        images,
        startIndex: 0,
      });
      const imagesById = new Map(
        images.map((image) => [image.attachmentId, image]),
      );
      return {
        brief: assembled.rewrittenPromptText,
        imageRefs: assembled.assignments.map((assignment) => {
          const image = imagesById.get(assignment.attachmentId)!;
          return {
            index: assignment.serverIndex,
            mediaType: image.mediaType,
            path: `/tmp/${conversationId}/${workflowId}/${assignment.serverIndex}`,
            base64Data: image.base64Data,
          };
        }),
      };
    },
    resolveSessionContext: async (input) => {
      resolveSessionContextCalls.push(input);
      if (options.resolveSessionContextResult instanceof Error) {
        throw options.resolveSessionContextResult;
      }
      return {
        context:
          options.resolveSessionContextResult ??
          EMPTY_COLLABORATION_SESSION_CONTEXT,
        degraded: options.resolveSessionContextDegraded ?? null,
      };
    },
    persistStart: async (input) => {
      persistedStarts.push(input);
      if (options.persistStartError) throw options.persistStartError;
    },
    stopRegistry,
    createDeps: () => options.sliceDepsOverride ?? makeStubSliceDeps(),
    buildLaneService: () =>
      createLaneService({ store: createInMemoryLaneStore() }),
    buildCallAgent: (input) => {
      buildCallAgentCalls.push({
        workflowId: input.workflowId,
        worktreePath: input.worktreePath,
        agents: input.agents,
      });
      return async () => {
        throw new Error("stub callAgent should not be called in tests");
      };
    },
    // The registry-backed default resolves real backend factories; scripted
    // deps run against synthetic models, so validation is a no-op here.
    validateModelAndEffort: () => {},
    resolveAgentTwoProfileSnapshot: async (input) => {
      resolveProfileCalls.push(input);
      if (options.resolveAgentTwoProfileSnapshotError) {
        throw options.resolveAgentTwoProfileSnapshotError;
      }
      return buildAgentProfileSnapshot({
        tier: input.ref?.tier ?? "builtin",
        id: input.ref?.id ?? "standard-agent",
        name: input.ref ? `Profile ${input.ref.id}` : "Standard Agent",
        revision: 1,
        sourceContentHash: computeContentHash(
          input.ref ? `instructions for ${input.ref.id}` : "",
        ),
        instructions: input.ref ? `instructions for ${input.ref.id}` : "",
      });
    },
    resolveCodexModelConfig: async () => ({
      model: "gpt-5.4",
      codexFastMode: false,
      timeoutMs: 0,
      stallTimeoutMs: 60_000,
      ...options.resolveCodexModelConfigResult,
    }),
    resolveClaudeModelConfig: async () => ({
      model: "opus",
      timeoutMs: 0,
      stallTimeoutMs: 0,
      ...options.resolveClaudeModelConfigResult,
    }),
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
    persistedStarts,
    resolveSessionContextCalls,
    resolveProfileCalls,
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

  it("fails closed on an unresolvable Agent Two profile, leaving nothing durable", async () => {
    const { deps, persistedStarts, runSliceCalls, resolveProfileCalls } =
      buildScriptedDeps({
        resolveAgentTwoProfileSnapshotError: new Error("unknown profile"),
      });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        conversationId: "conv-1",
        agentTwo: {
          backend: "claude",
          profile: { tier: "global", id: "gone" },
        },
      }),
    ).rejects.toBeInstanceOf(CollaborationProfileResolutionError);

    expect(resolveProfileCalls).toEqual([
      { projectPath: "/p", ref: { tier: "global", id: "gone" } },
    ]);
    expect(persistedStarts).toHaveLength(0);
    expect(runSliceCalls).toHaveLength(0);
  });

  it("staffs agent_two with the resolved profile snapshot and agent_one with the conversation's, verbatim", async () => {
    const conversationSnapshot = buildAgentProfileSnapshot({
      tier: "project",
      id: "conversation-reviewer",
      name: "Conversation Reviewer",
      revision: 4,
      sourceContentHash: computeContentHash("review as staffed"),
      instructions: "review as staffed",
    });
    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps({
      resolveConversationResult: {
        agentBackend: "claude",
        profileSnapshot: conversationSnapshot,
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
      agentTwo: { backend: "codex", profile: { tier: "global", id: "critic" } },
    });
    await runSliceCompletion;

    const sliceInput = runSliceCalls[0]!.input;
    // Agent One inherits the conversation's stored snapshot byte-for-byte —
    // never re-resolved.
    expect(sliceInput.agents?.agent_one.profileSnapshot).toEqual(
      conversationSnapshot,
    );
    const agentTwoSnapshot = sliceInput.agents?.agent_two.profileSnapshot;
    expect(agentTwoSnapshot).toMatchObject({ tier: "global", id: "critic" });
    expect(agentTwoSnapshot?.renderedInstructionBlock).toContain(
      "instructions for critic",
    );
  });

  it("runs a same-backend pair as two distinct lanes with their own settings", async () => {
    const { deps, runSliceCalls, runSliceCompletion, buildCallAgentCalls } =
      buildScriptedDeps({
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
      modelId: "fable",
      effort: "max",
      agentTwo: { backend: "claude", model: "opus", reasoningEffort: "high" },
    });
    await runSliceCompletion;

    const agents = runSliceCalls[0]!.input.agents;
    expect(agents?.agent_one).toMatchObject({
      backend: "claude",
      model: "fable",
      effort: "max",
    });
    expect(agents?.agent_two).toMatchObject({
      backend: "claude",
      model: "opus",
      effort: "high",
    });
    expect(buildCallAgentCalls[0]!.agents.agent_one.model).toBe("fable");
    expect(buildCallAgentCalls[0]!.agents.agent_two.model).toBe("opus");
  });

  it("persists ordered start images before forwarding their refs to the initial slice", async () => {
    const { deps, runSliceCalls, runSliceCompletion, persistedStarts } =
      buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    const result = await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design from the images",
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
      images: [
        {
          attachmentId: "first",
          mediaType: "image/png",
          base64Data: "one",
        },
        {
          attachmentId: "second",
          mediaType: "image/jpeg",
          base64Data: "two",
        },
      ],
    });

    await runSliceCompletion;

    expect(runSliceCalls[0]?.input.imageRefs).toEqual([
      {
        index: 0,
        mediaType: "image/png",
        path: "/tmp/conv-1/wf-1/0",
        base64Data: "one",
      },
      {
        index: 1,
        mediaType: "image/jpeg",
        path: "/tmp/conv-1/wf-1/1",
        base64Data: "two",
      },
    ]);
    expect(result).toEqual({ workflowId: "wf-1", status: "started" });
    expect(persistedStarts).toEqual([
      expect.objectContaining({
        workflowId: "wf-1",
        conversationId: "conv-1",
        brief: "design from the images",
        expectedPromptCount: 0,
        imageRefs: [
          {
            index: 0,
            mediaType: "image/png",
            path: "/tmp/conv-1/wf-1/0",
            base64Data: "one",
          },
          {
            index: 1,
            mediaType: "image/jpeg",
            path: "/tmp/conv-1/wf-1/1",
            base64Data: "two",
          },
        ],
      }),
    ]);
  });

  it("does not schedule the slice when durable start persistence fails", async () => {
    const { deps, runSliceCalls, persistedStarts } = buildScriptedDeps({
      persistStartError: new Error("disk full"),
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        conversationId: "conv-1",
      }),
    ).rejects.toThrow("disk full");

    expect(persistedStarts).toHaveLength(1);
    expect(runSliceCalls).toHaveLength(0);
  });

  it("keeps the accepted collaboration image isolated from a concurrent losing start", async () => {
    const configDir = await mkdtemp(
      path.join(tmpdir(), "cc-collaboration-image-race-"),
    );
    const db = _createTestDb({ inMemory: true });
    const store = createStateStore({ db, writeQueue: createWriteQueue() });
    const projectPath = "/projects/example";
    const sessionName = "sess-1";
    const conversationId = "conv-1";
    const transcriptEntries: Array<
      ReturnType<typeof buildCollaborationUserTranscriptEntry> & { id: string }
    > = [];
    try {
      seedWholeState(db, {
        projects: {
          [projectPath]: {
            rootPath: projectPath,
            sessions: {
              [sessionName]: sessionStateSchema.parse({
                sessionName,
                worktreePath: "/tmp/sess-1",
                branchName: "cc/sess-1",
                createdAt: "2026-07-13T12:00:00.000Z",
                lastActivityAt: "2026-07-13T12:00:00.000Z",
                conversations: [
                  {
                    id: conversationId,
                    transcriptPath: null,
                    status: "new",
                    promptCount: 0,
                    createdAt: "2026-07-13T12:00:00.000Z",
                    lastActivityAt: "2026-07-13T12:00:00.000Z",
                    agentBackend: "claude",
                  },
                ],
              }),
            },
          },
        },
        archivedProjects: [],
        pinnedProjects: [],
      });

      const { deps, runSliceCalls } = buildScriptedDeps();
      deps.resolveConversation = async () => {
        const conversation = await store.getConversation(
          projectPath,
          sessionName,
          conversationId,
        );
        return conversation
          ? {
              agentBackend: conversation.agentBackend,
              backendRef: conversation.backendRef,
              promptCount: conversation.promptCount,
            }
          : null;
      };
      const bytesByWorkflow = new Map<string, string>();
      let preparedCount = 0;
      let releasePrepared: () => void = () => undefined;
      const bothPrepared = new Promise<void>((resolve) => {
        releasePrepared = resolve;
      });
      deps.prepareInitialImages = async (input) => {
        bytesByWorkflow.set(
          input.workflowId,
          input.images[0]?.base64Data ?? "",
        );
        const prepared = await prepareCollaborationInitialImages(
          input,
          configDir,
        );
        preparedCount += 1;
        if (preparedCount === 2) releasePrepared();
        await bothPrepared;
        return prepared;
      };
      deps.persistStart = createCollaborationStartPersister({
        getTranscriptPath: async () =>
          path.join(configDir, "transcripts", `${conversationId}.jsonl`),
        appendTranscriptEntryOnce: async (_id, entry) => {
          transcriptEntries.push(entry);
        },
        mutateConversation: store.mutateConversation,
        now: () => "2026-07-13T13:00:00.000Z",
      });
      const manager = createCollaborationManager(deps);
      const start = (base64Data: string) =>
        manager.start({
          projectPath,
          sessionName,
          brief: "compare [Image #1]",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId,
          images: [
            {
              attachmentId: crypto.randomUUID(),
              mediaType: "image/png",
              base64Data,
              inlineMarkerIndex: 1,
            },
          ],
        });
      const outcomes = await Promise.allSettled([
        start(Buffer.from("request-a").toString("base64")),
        start(Buffer.from("request-b").toString("base64")),
      ]);

      const accepted = outcomes.find(
        (
          outcome,
        ): outcome is PromiseFulfilledResult<{
          workflowId: string;
          status: "started";
        }> => outcome.status === "fulfilled",
      );
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      expect(accepted).toBeDefined();
      expect(rejected?.reason).toBeInstanceOf(CollaborationStartConflictError);
      expect(transcriptEntries).toHaveLength(1);
      expect(runSliceCalls).toHaveLength(1);

      const acceptedWorkflowId = accepted!.value.workflowId;
      const acceptedBytes = bytesByWorkflow.get(acceptedWorkflowId);
      const transcriptEntry = transcriptEntries[0];
      if (!transcriptEntry || !Array.isArray(transcriptEntry.content)) {
        throw new Error("accepted transcript entry missing");
      }
      const transcriptImage = transcriptEntry.content.find(
        (block) => block.type === "image_ref",
      );
      expect(transcriptImage?.type).toBe("image_ref");
      if (!transcriptImage || transcriptImage.type !== "image_ref") {
        throw new Error("accepted transcript image ref missing");
      }
      expect(
        (await readFile(transcriptImage.imagePath)).toString("base64"),
      ).toBe(acceptedBytes);
      expect(runSliceCalls[0]?.input.imageRefs?.[0]).toMatchObject({
        path: transcriptImage.imagePath,
        base64Data: acceptedBytes,
      });
    } finally {
      db.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("does not persist a start when fallible runtime preparation fails", async () => {
    const { deps, runSliceCalls, persistedStarts } = buildScriptedDeps();
    deps.resolveCodexModelConfig = async () => {
      throw new Error("config unavailable");
    };
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        conversationId: "conv-1",
      }),
    ).rejects.toThrow("config unavailable");

    expect(persistedStarts).toHaveLength(0);
    expect(runSliceCalls).toHaveLength(0);
  });

  it("keeps inline markers associated when a strip image precedes an inline image", async () => {
    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps();
    const manager = createCollaborationManager(deps);

    await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "compare [Image #1]",
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
      images: [
        {
          attachmentId: "strip",
          mediaType: "image/png",
          base64Data: "strip-data",
        },
        {
          attachmentId: "inline",
          mediaType: "image/jpeg",
          base64Data: "inline-data",
          inlineMarkerIndex: 1,
        },
      ],
    });

    await runSliceCompletion;
    expect(runSliceCalls[0]?.input.brief).toBe("compare [Image #0]");
    expect(
      runSliceCalls[0]?.input.imageRefs?.map((image) => image.base64Data),
    ).toEqual(["inline-data", "strip-data"]);
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
          timeoutMs: 120_000,
          stallTimeoutMs: 30_000,
        },
        resolveClaudeModelConfigResult: {
          model: "sonnet",
          reasoningEffort: "xhigh",
          timeoutMs: 90_000,
          stallTimeoutMs: 0,
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
        agents: {
          agent_one: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "xhigh",
            timeoutMs: 90_000,
            stallTimeoutMs: 0,
          },
          agent_two: {
            backend: "codex",
            model: "gpt-5.5",
            reasoningEffort: "high",
            fastMode: false,
            timeoutMs: 120_000,
            stallTimeoutMs: 30_000,
          },
        },
      },
    ]);
  });

  it("overrides the claude lane's model config with the request model/effort when the primary backend is claude", async () => {
    const { deps, buildCallAgentCalls, runSliceCompletion } = buildScriptedDeps(
      {
        resolveSessionResult: { worktreePath: "/wt/xyz" },
        resolveConversationResult: { agentBackend: "claude" },
        resolveCodexModelConfigResult: {
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
        resolveClaudeModelConfigResult: {
          model: "opus",
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
      modelId: "fable",
      effort: "max",
    });

    await runSliceCompletion;

    expect(buildCallAgentCalls).toEqual([
      {
        workflowId: "wf-1",
        worktreePath: "/wt/xyz",
        agents: {
          agent_one: {
            backend: "claude",
            model: "fable",
            reasoningEffort: "max",
            timeoutMs: 0,
            stallTimeoutMs: 0,
          },
          agent_two: {
            backend: "codex",
            model: "gpt-5.5",
            reasoningEffort: "high",
            fastMode: false,
            timeoutMs: 0,
            stallTimeoutMs: 60_000,
          },
        },
      },
    ]);
  });

  it("overrides the codex lane's model config with the request model/effort when the primary backend is codex", async () => {
    const { deps, buildCallAgentCalls, runSliceCompletion } = buildScriptedDeps(
      {
        resolveSessionResult: { worktreePath: "/wt/xyz" },
        resolveConversationResult: { agentBackend: "codex" },
        resolveCodexModelConfigResult: {
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
        resolveClaudeModelConfigResult: {
          model: "opus",
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
      modelId: "gpt-5.5-codex",
      effort: "medium",
      codexFastMode: true,
    });

    await runSliceCompletion;

    expect(buildCallAgentCalls).toEqual([
      {
        workflowId: "wf-1",
        worktreePath: "/wt/xyz",
        agents: {
          agent_one: {
            backend: "codex",
            model: "gpt-5.5-codex",
            reasoningEffort: "medium",
            fastMode: true,
            timeoutMs: 0,
            stallTimeoutMs: 60_000,
          },
          agent_two: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "xhigh",
            timeoutMs: 0,
            stallTimeoutMs: 0,
          },
        },
      },
    ]);
  });

  it.each([false, true])(
    "carries an explicit Codex fast-mode value of %s into the Codex-primary slice runtime",
    async (codexFastMode) => {
      const { deps, buildCallAgentCalls, runSliceCalls, runSliceCompletion } =
        buildScriptedDeps({
          resolveConversationResult: { agentBackend: "codex" },
        });
      const manager = createCollaborationManager(deps);

      await manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 2,
        autonomousResolutionThreshold: "major",
        conversationId: "conv-1",
        codexFastMode,
      });

      await runSliceCompletion;

      expect(buildCallAgentCalls[0]?.agents.agent_one.fastMode).toBe(
        codexFastMode,
      );
      expect(runSliceCalls[0]?.input.agents?.agent_one.fastMode).toBe(
        codexFastMode,
      );
    },
  );

  it.each([false, true])(
    "uses and persists the resolved global Codex fast-mode default of %s when a Codex-primary start omits it",
    async (codexFastMode) => {
      const {
        deps,
        buildCallAgentCalls,
        persistedStarts,
        runSliceCalls,
        runSliceCompletion,
      } = buildScriptedDeps({
        resolveConversationResult: { agentBackend: "codex" },
        resolveCodexModelConfigResult: {
          model: "gpt-5.4",
          codexFastMode,
        },
      });
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

      expect(buildCallAgentCalls[0]?.agents.agent_one.fastMode).toBe(
        codexFastMode,
      );
      expect(runSliceCalls[0]?.input.agents?.agent_one.fastMode).toBe(
        codexFastMode,
      );
      expect(persistedStarts[0]?.codexFastMode).toBe(codexFastMode);
    },
  );

  it.each([false, true])(
    "does not apply a conversation Codex fast-mode value of %s to the secondary Codex lane",
    async (codexFastMode) => {
      const { deps, buildCallAgentCalls, runSliceCalls, runSliceCompletion } =
        buildScriptedDeps({
          resolveConversationResult: { agentBackend: "claude" },
          resolveCodexModelConfigResult: {
            model: "gpt-5.4",
            codexFastMode: true,
          },
        });
      const manager = createCollaborationManager(deps);

      await manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 2,
        autonomousResolutionThreshold: "major",
        conversationId: "conv-1",
        codexFastMode,
      });

      await runSliceCompletion;

      // The Claude-backed agent_one lane never gains a fast-mode setting, and
      // the secondary Codex lane keeps its config-resolved value (true) — the
      // request's fast-mode choice belongs to agent_one only.
      expect(buildCallAgentCalls[0]?.agents.agent_one.fastMode).toBeUndefined();
      expect(buildCallAgentCalls[0]?.agents.agent_two.fastMode).toBe(true);
      expect(
        runSliceCalls[0]?.input.agents?.agent_one.fastMode,
      ).toBeUndefined();
      expect(runSliceCalls[0]?.input.agents?.agent_two.fastMode).toBe(true);
    },
  );

  it("keeps the request effort out of the non-primary lane when only effort is sent", async () => {
    const { deps, buildCallAgentCalls, runSliceCompletion } = buildScriptedDeps(
      {
        resolveSessionResult: { worktreePath: "/wt/xyz" },
        resolveConversationResult: { agentBackend: "claude" },
        resolveCodexModelConfigResult: { model: "gpt-5.5" },
        resolveClaudeModelConfigResult: { model: "opus" },
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
      effort: "low",
    });

    await runSliceCompletion;

    expect(buildCallAgentCalls).toEqual([
      {
        workflowId: "wf-1",
        worktreePath: "/wt/xyz",
        agents: {
          agent_one: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "low",
            timeoutMs: 0,
            stallTimeoutMs: 0,
          },
          // No reasoningEffort: the request effort belongs to agent_one only.
          agent_two: {
            backend: "codex",
            model: "gpt-5.5",
            fastMode: false,
            timeoutMs: 0,
            stallTimeoutMs: 60_000,
          },
        },
      },
    ]);
  });

  it("threads both flow agents' effective model settings into sliceInput.agents and buildCallAgent (request overrides apply to agent_one only)", async () => {
    const { deps, runSliceCalls, buildCallAgentCalls, runSliceCompletion } =
      buildScriptedDeps({
        resolveSessionResult: { worktreePath: "/wt/abc" },
        resolveConversationResult: { agentBackend: "claude" },
        resolveCodexModelConfigResult: {
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
        resolveClaudeModelConfigResult: { model: "opus" },
      });
    const manager = createCollaborationManager(deps);

    await manager.start({
      projectPath: "/p",
      sessionName: "s",
      brief: "design X",
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-1",
      modelId: "fable",
      effort: "max",
    });

    await runSliceCompletion;

    const call = runSliceCalls[0];
    if (!call) throw new Error("expected one runSlice call");
    // toMatchObject: agent_two additionally carries its (default) profile
    // snapshot, covered by the staffing tests.
    expect(call.input.agents).toMatchObject({
      agent_one: { backend: "claude", model: "fable", effort: "max" },
      agent_two: {
        backend: "codex",
        model: "gpt-5.5",
        effort: "high",
        fastMode: false,
      },
    });
    expect(buildCallAgentCalls[0]?.agents).toEqual({
      agent_one: expect.objectContaining({
        backend: "claude",
        model: "fable",
        reasoningEffort: "max",
      }),
      agent_two: expect.objectContaining({
        backend: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",
      }),
    });
  });

  it("threads conversation.backendRef into sliceInput.priorBackendRef when present", async () => {
    const savedRef: AgentSessionRef = {
      backend: "claude",
      ref: "claude-saved-session",
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
      ref: "codex-saved-thread",
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

describe("createCollaborationManager.start — session context capture", () => {
  const CAPTURED: CollaborationSessionContext = {
    alignment: {
      version: 4,
      contentHash: "hash-4",
      text: "## Charter\n\nShip the thing.",
      snapshotPath: ".cc/session-alignment/snapshots/hash-4.md",
    },
    activeTicketBlock: "<active-ticket>\nidentifier: p#7\n</active-ticket>",
  };

  function recordingStopRegistry(): {
    registry: CollaborationStopRegistry;
    registered: string[];
  } {
    const inner = createInMemoryCollaborationStopRegistry();
    const registered: string[] = [];
    return {
      registered,
      registry: {
        register(workflowId) {
          registered.push(workflowId);
          return inner.register(workflowId);
        },
        signal: (workflowId) => inner.signal(workflowId),
        signalFor: (workflowId) => inner.signalFor(workflowId),
        release: (workflowId) => inner.release(workflowId),
      },
    };
  }

  it("resolves the context for the session's worktree and creation mode", async () => {
    const { deps, resolveSessionContextCalls } = buildScriptedDeps({
      resolveSessionResult: {
        worktreePath: "/tmp/example/.worktrees/sess-1",
        creationMode: "normal",
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

    expect(resolveSessionContextCalls).toEqual([
      {
        projectPath: "/p",
        sessionName: "s",
        worktreePath: "/tmp/example/.worktrees/sess-1",
        creationMode: "normal",
        workflowId: "wf-1",
        conversationId: "conv-1",
      },
    ]);
  });

  it("threads the captured snapshot into the slice input verbatim", async () => {
    const { deps, runSliceCalls, runSliceCompletion } = buildScriptedDeps({
      resolveSessionContextResult: CAPTURED,
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

    expect(runSliceCalls).toHaveLength(1);
    expect(runSliceCalls[0]!.input.sessionContext).toBe(CAPTURED);
  });

  it("fails closed without claiming the conversation when charter capture fails", async () => {
    const { registry, registered } = recordingStopRegistry();
    const { deps, persistedStarts, runSliceCalls } = buildScriptedDeps({
      resolveSessionContextResult: new Error("charter read failed"),
      stopRegistryOverride: registry,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.start({
        projectPath: "/p",
        sessionName: "s",
        brief: "design X",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        conversationId: "conv-1",
      }),
    ).rejects.toThrow("charter read failed");

    expect(persistedStarts).toEqual([]);
    expect(runSliceCalls).toEqual([]);
    expect(registered).toEqual([]);
  });
});

/**
 * Uses the REAL logger against a temp config dir rather than a fake sink, so
 * the no-bodies-no-secrets assertion covers the bytes an operator can actually
 * read — a stubbed logger could not prove the charter never reaches disk.
 */
describe("collaboration manager session-context logging", () => {
  const CHARTER_TEXT =
    "## Alignment charter\n\nNEVER-LOG-CHARTER-BODY: prefer boring technology.";
  const TICKET_BLOCK =
    "<active-ticket>\nidentifier: p#42\ntitle: NEVER-LOG-TICKET-TITLE\n</active-ticket>";
  const CAPTURED: CollaborationSessionContext = {
    alignment: {
      version: 8,
      contentHash: "hash-8",
      text: CHARTER_TEXT,
      snapshotPath: ".cc/session-alignment/snapshots/hash-8.md",
    },
    activeTicketBlock: TICKET_BLOCK,
  };

  let tmpRoot: string;
  let savedConfigDir: string | undefined;
  let savedSilent: string | undefined;
  let savedLevel: string | undefined;
  let savedLogFile: string | undefined;

  function rawLogText(): string {
    const file = path.join(tmpRoot, "logs", "global.log");
    return existsSync(file) ? readFileSync(file, "utf-8") : "";
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "cc-collab-manager-log-"));
    savedConfigDir = process.env["CC_CONFIG_DIR"];
    savedSilent = process.env["CC_LOG_SILENT"];
    savedLevel = process.env["CC_LOG_LEVEL"];
    savedLogFile = process.env["CC_LOG_FILE"];
    _resetLoggerForTesting();
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_SCOPED"];
    // CC_LOG_SILENT=1 suppresses every level, not just the stderr mirror.
    delete process.env["CC_LOG_SILENT"];
    process.env["CC_CONFIG_DIR"] = tmpRoot;
    process.env["CC_LOG_LEVEL"] = "info";
  });

  afterEach(() => {
    _resetLoggerForTesting();
    if (savedSilent === undefined) delete process.env["CC_LOG_SILENT"];
    else process.env["CC_LOG_SILENT"] = savedSilent;
    if (savedLevel === undefined) delete process.env["CC_LOG_LEVEL"];
    else process.env["CC_LOG_LEVEL"] = savedLevel;
    if (savedConfigDir === undefined) delete process.env["CC_CONFIG_DIR"];
    else process.env["CC_CONFIG_DIR"] = savedConfigDir;
    if (savedLogFile === undefined) delete process.env["CC_LOG_FILE"];
    else process.env["CC_LOG_FILE"] = savedLogFile;
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("never writes charter or ticket bodies into the log", async () => {
    const { deps } = buildScriptedDeps({
      resolveSessionContextResult: CAPTURED,
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

    const text = rawLogText();
    expect(text).not.toContain("NEVER-LOG-CHARTER-BODY");
    expect(text).not.toContain("NEVER-LOG-TICKET-TITLE");
    expect(text).not.toContain("<active-ticket>");
    expect(text).not.toContain("snapshots/hash-8.md");
  });
});

describe("createCollaborationSessionContextResolver", () => {
  it("captures the charter for the run's worktree and pairs it with the ticket block", async () => {
    const captureCalls: Array<{
      projectPath: string;
      sessionName: string;
      worktreePath: string;
    }> = [];
    const resolve = createCollaborationSessionContextResolver({
      captureActiveCharterForRun: async (input) => {
        captureCalls.push(input);
        return { version: 2, contentHash: "hash-2", text: "## Charter" };
      },
      getLiveTicketBlock: async () => "<active-ticket>\n</active-ticket>",
    });

    const capture = await resolve({
      projectPath: "/p",
      sessionName: "s",
      worktreePath: "/wt/s",
      creationMode: "normal",
      workflowId: "wf-1",
      conversationId: "conv-1",
    });

    expect(captureCalls).toEqual([
      { projectPath: "/p", sessionName: "s", worktreePath: "/wt/s" },
    ]);
    expect(capture.context).toEqual({
      alignment: { version: 2, contentHash: "hash-2", text: "## Charter" },
      activeTicketBlock: "<active-ticket>\n</active-ticket>",
    });
    expect(capture.degraded).toBeNull();
  });

  it("skips charter capture for an alignment-ineligible session but still reads the ticket", async () => {
    let captureCount = 0;
    const resolve = createCollaborationSessionContextResolver({
      captureActiveCharterForRun: async () => {
        captureCount += 1;
        return { version: 2, contentHash: "hash-2", text: "## Charter" };
      },
      getLiveTicketBlock: async () => "<active-ticket>\n</active-ticket>",
    });

    const capture = await resolve({
      projectPath: "/p",
      sessionName: "s",
      worktreePath: "/wt/s",
      creationMode: "optimistic",
      workflowId: "wf-1",
      conversationId: "conv-1",
    });

    expect(captureCount).toBe(0);
    expect(capture.context).toEqual({
      alignment: null,
      activeTicketBlock: "<active-ticket>\n</active-ticket>",
    });
  });

  it("degrades to a null ticket block when the ticket read fails", async () => {
    const resolve = createCollaborationSessionContextResolver({
      captureActiveCharterForRun: async () => null,
      getLiveTicketBlock: async () => {
        throw new Error("ticket repo unavailable");
      },
    });

    const capture = await resolve({
      projectPath: "/p",
      sessionName: "s",
      worktreePath: "/wt/s",
      creationMode: "normal",
      workflowId: "wf-1",
      conversationId: "conv-1",
    });

    expect(capture.context).toEqual(EMPTY_COLLABORATION_SESSION_CONTEXT);
    // The production-wired resolver is what the manager's failure telemetry
    // reads its source from, so the attribution has to survive this composition.
    expect(capture.degraded).toEqual({
      source: "ticket",
      error: "ticket repo unavailable",
    });
  });
});

describe("createCollaborationManager.getEnvelope / listActive", () => {
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
      ["wf-hydrate", [makeFinalAnswer({ summary: "ship it" })]],
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
      ["wf-graph-collab", [makeFinalAnswer({ summary: "x" })]],
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

    const { deps } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
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

  const PERSISTED_CONTEXT: CollaborationSessionContext = {
    alignment: {
      version: 6,
      contentHash: "hash-6",
      text: "## Charter\n\nKeep the seams narrow.",
      snapshotPath: ".cc/session-alignment/snapshots/hash-6.md",
    },
    activeTicketBlock: "<active-ticket>\nidentifier: p#3\n</active-ticket>",
  };

  async function seedPausedEnvelope(
    sessionContext: unknown,
  ): Promise<ReturnType<typeof createInMemoryWorkflowEnvelopeStore>> {
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
          ...(sessionContext === undefined ? {} : { sessionContext }),
        },
      }),
    );
    await repo.markPaused("wf-paused", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "good-token",
    });
    return envelopeStore;
  }

  it("refuses to resume a run with no captured session context, leaving it paused", async () => {
    const envelopeStore = await seedPausedEnvelope(undefined);
    const { deps, runSliceCalls, resolveSessionContextCalls } =
      buildScriptedDeps({ envelopeStoreOverride: envelopeStore });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.resume({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-paused",
        resumeToken: "good-token",
        conversationId: "conv-1",
        userAnswers: { q1: "yes" },
      }),
    ).rejects.toBeInstanceOf(MissingCollaborationSessionContextError);

    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    const reread = await repo.get("wf-paused");
    expect(reread?.status).toBe("paused");
    expect(runSliceCalls).toEqual([]);
    // Live re-resolution would give the two peers different premises than the
    // ones they negotiated under before the pause.
    expect(resolveSessionContextCalls).toEqual([]);
  });

  it("refuses to resume a run whose captured session context is malformed", async () => {
    const envelopeStore = await seedPausedEnvelope({
      alignment: { version: "six" },
    });
    const { deps, runSliceCalls } = buildScriptedDeps({
      envelopeStoreOverride: envelopeStore,
    });
    const manager = createCollaborationManager(deps);

    await expect(
      manager.resume({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-paused",
        resumeToken: "good-token",
        conversationId: "conv-1",
        userAnswers: {},
      }),
    ).rejects.toBeInstanceOf(MalformedCollaborationSessionContextError);

    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    expect((await repo.get("wf-paused"))?.status).toBe("paused");
    expect(runSliceCalls).toEqual([]);
  });

  it("reuses the persisted session context verbatim instead of re-resolving it", async () => {
    const envelopeStore = await seedPausedEnvelope(PERSISTED_CONTEXT);
    const {
      deps,
      runSliceCalls,
      runSliceCompletion,
      resolveSessionContextCalls,
    } = buildScriptedDeps({ envelopeStoreOverride: envelopeStore });
    const manager = createCollaborationManager(deps);

    await manager.resume({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-paused",
      resumeToken: "good-token",
      conversationId: "conv-1",
      userAnswers: {},
    });
    await runSliceCompletion;

    expect(runSliceCalls[0]?.input.sessionContext).toEqual(PERSISTED_CONTEXT);
    expect(resolveSessionContextCalls).toEqual([]);
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
          sessionContext: PERSISTED_CONTEXT,
        },
      }),
    );
    await repo.markPaused("wf-paused", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "good-token",
    });

    const { deps, runSliceCalls, buildCallAgentCalls, runSliceCompletion } =
      buildScriptedDeps({
        envelopeStoreOverride: envelopeStore,
        resolveCodexModelConfigResult: {
          model: "gpt-5.5",
          timeoutMs: 120_000,
          stallTimeoutMs: 30_000,
        },
        resolveClaudeModelConfigResult: {
          model: "sonnet",
          timeoutMs: 90_000,
          stallTimeoutMs: 0,
        },
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
    expect(buildCallAgentCalls[0]?.agents).toEqual({
      agent_one: expect.objectContaining({
        backend: "claude",
        timeoutMs: 90_000,
        stallTimeoutMs: 0,
      }),
      agent_two: expect.objectContaining({
        backend: "codex",
        timeoutMs: 120_000,
        stallTimeoutMs: 30_000,
      }),
    });
  });

  it.each([false, true])(
    "restores a persisted Codex-primary fast-mode value of %s for resumed Codex calls",
    async (codexFastMode) => {
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
            primaryAgentBackend: "codex",
            autonomousResolutionThreshold: "major",
            sessionContext: PERSISTED_CONTEXT,
            codexFastMode,
          },
        }),
      );
      await repo.markPaused("wf-paused", {
        pauseKind: "post_turn",
        gateKind: "human_approval",
        resumeToken: "good-token",
      });

      const { deps, runSliceCalls, buildCallAgentCalls, runSliceCompletion } =
        buildScriptedDeps({ envelopeStoreOverride: envelopeStore });
      const manager = createCollaborationManager(deps);

      await manager.resume({
        projectPath: "/p",
        sessionName: "s",
        workflowId: "wf-paused",
        resumeToken: "good-token",
        conversationId: "conv-1",
        userAnswers: { q1: "continue" },
      });
      await runSliceCompletion;

      expect(buildCallAgentCalls[0]?.agents.agent_one).toEqual(
        expect.objectContaining({ backend: "codex", fastMode: codexFastMode }),
      );
      expect(runSliceCalls[0]?.input.agents?.agent_one.fastMode).toBe(
        codexFastMode,
      );
    },
  );

  it("does not restore a persisted fast-mode field onto a Claude-primary run", async () => {
    const envelopeStore = await seedPausedEnvelope(PERSISTED_CONTEXT);
    const repo = createWorkflowEnvelopeRepository({ store: envelopeStore });
    const existing = await repo.get("wf-paused");
    if (!existing) throw new Error("paused envelope missing");
    await repo.update("wf-paused", {
      featureSnapshot: {
        ...(existing.featureSnapshot as Record<string, unknown>),
        codexFastMode: true,
      },
    });

    const { deps, runSliceCalls, buildCallAgentCalls, runSliceCompletion } =
      buildScriptedDeps({ envelopeStoreOverride: envelopeStore });
    const manager = createCollaborationManager(deps);

    await manager.resume({
      projectPath: "/p",
      sessionName: "s",
      workflowId: "wf-paused",
      resumeToken: "good-token",
      conversationId: "conv-1",
      userAnswers: {},
    });
    await runSliceCompletion;

    expect(buildCallAgentCalls[0]?.agents.agent_one.fastMode).toBeUndefined();
    expect(buildCallAgentCalls[0]?.agents.agent_two.fastMode).toBeUndefined();
    expect(runSliceCalls[0]?.input.agents?.agent_one.fastMode).toBeUndefined();
    expect(runSliceCalls[0]?.input.agents?.agent_two.fastMode).toBeUndefined();
  });
});

describe("createCollaborationManager.stop", () => {
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

describe("buildStandaloneCollaborationCallerInput", () => {
  const managerFacts = {
    projectPath: "/projects/example",
    sessionName: "sess-1",
    worktreePath: "/worktrees/sess-1",
    workflowId: "wf-scope",
    conversationId: "conv-originating",
    laneService: createLaneService({ store: createInMemoryLaneStore() }),
    agents: {
      agent_one: {
        backend: "claude" as const,
        model: "opus",
        timeoutMs: 0,
        stallTimeoutMs: 0,
      },
      agent_two: {
        backend: "codex" as const,
        model: "gpt-5.2",
        timeoutMs: 0,
        stallTimeoutMs: 0,
      },
    },
  };

  it("grants the originating session scope, so the standalone Codex lane can run the ticket block's cctl commands", () => {
    const callerInput = buildStandaloneCollaborationCallerInput(managerFacts);

    expect(callerInput.grantsOriginatingSessionScope).toBe(true);
    expect(callerInput.originatingConversationId).toBe("conv-originating");
    expect(callerInput.projectPath).toBe("/projects/example");
    expect(callerInput.sessionName).toBe("sess-1");
  });
});
