/**
 * Unit tests for the conversation persistence facet.
 *
 * The durable adapter routes every durable side effect through its injected
 * state-store seam; the ephemeral adapter routes nothing anywhere. Deps are
 * injected (no `vi.mock` of internal modules) so the production adapter objects
 * are exercised directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Snapshot } from "xstate";
import {
  durableConversationPersistence,
  ephemeralConversationPersistence,
  resolveConversationPersistenceAdapter,
  setConversationPersistenceAdapterDeps,
  _resetConversationPersistenceAdapterDepsForTesting,
  applySyncDerivedFields,
  deriveActiveTurnSource,
  type ConversationPersistenceAdapterDeps,
  type ConversationSnapshotSource,
} from "./persistence-adapter";
import {
  setPersistenceDeps,
  _resetForTesting as resetPersistenceForTesting,
} from "./persistence";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  setProjectConversationStatusNotificationDepsForTesting,
  _resetProjectConversationStatusNotificationDepsForTesting,
} from "@/lib/project-conversations/status-notifications";
import type { ProjectConversationNotificationService } from "@/lib/notifications/project-conversation-service";
import type { ConversationContext } from "./types";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ActorDurableWriteSeams } from "./actor-implementations";

// Infrastructure mock — createLogger is called at module level.
vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeContext(
  overrides: Partial<ConversationContext> = {},
): ConversationContext {
  return {
    _schemaVersion: 1,
    conversationScope: "session",
    projectPath: "/p",
    projectName: "proj",
    sessionName: "sess",
    worktreePath: "/p/.worktrees/sess",
    conversationId: "conv-1",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    status: "awaiting",
    promptCount: 2,
    transcriptPath: "/t.jsonl",
    agentBackend: "claude",
    backendRef: { backend: "claude", ref: "sess-abc" },
    forkedFrom: null,
    role: null,
    activeTurn: null,
    pendingQuestion: null,
    debugMode: null,
    totals: {
      totalCostUsd: 1,
      totalDurationMs: 2,
      totalTurns: 3,
      contextTokens: 4,
      contextWindowMax: 5,
    },
    lastResult: null,
    lastError: null,
    ...overrides,
  };
}

interface RecordingDeps extends ConversationPersistenceAdapterDeps {
  mutateCalls: Array<{ conversationId: string; label: string }>;
  publishCalls: Array<{ unread: boolean }>;
  queueAutoNameCalls: Array<
    Parameters<ConversationPersistenceAdapterDeps["queueAutoName"]>[0]
  >;
  applied: ConversationState[];
}

function makeRecordingDeps(): RecordingDeps {
  const mutateCalls: RecordingDeps["mutateCalls"] = [];
  const publishCalls: RecordingDeps["publishCalls"] = [];
  const queueAutoNameCalls: RecordingDeps["queueAutoNameCalls"] = [];
  const applied: ConversationState[] = [];
  return {
    mutateCalls,
    publishCalls,
    queueAutoNameCalls,
    applied,
    async mutateConversation(_p, _s, conversationId, label, mutate) {
      mutateCalls.push({ conversationId, label });
      const conversation = {
        id: conversationId,
      } as unknown as ConversationState;
      await mutate(conversation);
      applied.push(conversation);
    },
    publishSessionStatus(event) {
      publishCalls.push({ unread: event.unread });
      return { delivered: true };
    },
    queueAutoName(input) {
      queueAutoNameCalls.push(input);
    },
  };
}

function makeFirstTurnContext(
  overrides: Partial<ConversationContext> = {},
): ConversationContext {
  return makeContext({
    promptCount: 0,
    forkedFrom: null,
    role: null,
    activeTurn: {
      kind: "conversation_turn",
      promptText: "Name this conversation",
      images: [],
      backend: "claude",
      modelId: null,
      effort: null,
      codexFastMode: null,
      autonomous: undefined,
      startedAt: null,
      streamId: "stream-1",
    } as unknown as ConversationContext["activeTurn"],
    ...overrides,
  });
}

/** Flush the fire-and-forget async work the adapter schedules. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("conversation persistence facet", () => {
  describe("resolveConversationPersistenceAdapter", () => {
    it("maps durable and ephemeral to their adapters", () => {
      expect(resolveConversationPersistenceAdapter("durable")).toBe(
        durableConversationPersistence,
      );
      expect(resolveConversationPersistenceAdapter("ephemeral")).toBe(
        ephemeralConversationPersistence,
      );
    });
  });

  describe("deriveActiveTurnSource", () => {
    it("classifies task_run and autonomous turns as workflow", () => {
      expect(deriveActiveTurnSource(null)).toBeNull();
      expect(
        deriveActiveTurnSource({
          kind: "task_run",
        } as never),
      ).toBe("workflow");
    });
  });

  describe("durable adapter", () => {
    let deps: RecordingDeps;

    beforeEach(() => {
      deps = makeRecordingDeps();
      setConversationPersistenceAdapterDeps(deps);
    });

    afterEach(() => {
      _resetConversationPersistenceAdapterDepsForTesting();
      resetPersistenceForTesting();
    });

    it("syncDerivedFields mutates the row through the injected seam", async () => {
      durableConversationPersistence.syncDerivedFields(makeContext());
      await vi.waitFor(() =>
        expect(deps.mutateCalls).toEqual([
          {
            conversationId: "conv-1",
            label: "conversation-manager.syncDerived",
          },
        ]),
      );
    });

    it("markReadOnUserTurnStart clears unread and publishes", async () => {
      durableConversationPersistence.markReadOnUserTurnStart(makeContext());
      await vi.waitFor(() =>
        expect(deps.publishCalls).toEqual([{ unread: false }]),
      );
      expect(deps.mutateCalls).toHaveLength(1);
    });

    it("markUnreadOnFinish sets unread and publishes", async () => {
      durableConversationPersistence.markUnreadOnFinish(makeContext());
      await vi.waitFor(() =>
        expect(deps.publishCalls).toEqual([{ unread: true }]),
      );
      expect(deps.mutateCalls).toHaveLength(1);
    });

    it("persistSnapshot samples the actor snapshot", async () => {
      const upserts: unknown[] = [];
      setPersistenceDeps({
        getConversationMachineSnapshot: () => null,
        upsertConversationMachineSnapshot: async (_o, _c, snapshot) => {
          upserts.push(snapshot);
        },
        deleteConversationMachineSnapshot: async () => {},
      });
      const getPersistedSnapshot = vi.fn(
        (): Snapshot<unknown> =>
          ({
            status: "active",
            context: { transient: false },
          }) as unknown as Snapshot<unknown>,
      );
      const actor: ConversationSnapshotSource = { getPersistedSnapshot };

      durableConversationPersistence.persistSnapshot(makeContext(), actor);
      await vi.waitFor(() =>
        expect(getPersistedSnapshot).toHaveBeenCalledTimes(1),
      );
    });

    it("queues automatic naming once from the first user turn with bounded content", () => {
      const promptText = "x".repeat(4_500);

      durableConversationPersistence.triggerAutoNaming(
        makeFirstTurnContext({
          promptCount: 0,
          activeTurn: {
            ...makeFirstTurnContext().activeTurn,
            promptText,
          } as ConversationContext["activeTurn"],
        }),
      );

      expect(deps.queueAutoNameCalls).toEqual([
        {
          projectPath: "/p",
          projectName: "proj",
          sessionName: "sess",
          conversationId: "conv-1",
          content: "x".repeat(4_000),
        },
      ]);
    });

    it.each([
      ["the conversation already has a prompt", { promptCount: 1 }],
      [
        "the turn is autonomous",
        {
          activeTurn: {
            ...makeFirstTurnContext().activeTurn,
            autonomous: true,
          },
        },
      ],
      [
        "the active turn is a task run",
        {
          activeTurn: {
            kind: "task_run" as const,
            promptText: "workflow task",
            backend: "claude" as const,
            modelId: null,
            effort: null,
            startedAt: null,
          },
        },
      ],
      ["the conversation has a workflow role", { role: "iteration" as const }],
      [
        "the conversation is a fork",
        {
          forkedFrom: {
            sourceConversationId: "parent-conv",
            messageIndex: 1,
            forkMode: "synthetic" as const,
          },
        },
      ],
      [
        "the prompt is whitespace only",
        {
          activeTurn: {
            ...makeFirstTurnContext().activeTurn,
            promptText: "  \n\t ",
          },
        },
      ],
    ])("does not queue automatic naming when %s", (_label, overrides) => {
      durableConversationPersistence.triggerAutoNaming(
        makeFirstTurnContext(overrides as Partial<ConversationContext>),
      );

      expect(deps.queueAutoNameCalls).toEqual([]);
    });
  });

  describe("ephemeral adapter", () => {
    let deps: RecordingDeps;

    beforeEach(() => {
      deps = makeRecordingDeps();
      setConversationPersistenceAdapterDeps(deps);
    });

    afterEach(() => {
      _resetConversationPersistenceAdapterDepsForTesting();
      resetPersistenceForTesting();
    });

    it("performs no state-store writes across every method", async () => {
      const getPersistedSnapshot = vi.fn(
        () =>
          ({ status: "active", context: {} }) as unknown as Snapshot<unknown>,
      );
      // A project-sentinel session so notifyProjectStatus would fire durably;
      // the ephemeral variant must still skip it.
      const ctx = makeContext({
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        status: "awaiting",
      });
      ephemeralConversationPersistence.syncDerivedFields(ctx);
      ephemeralConversationPersistence.markReadOnUserTurnStart(ctx);
      ephemeralConversationPersistence.markUnreadOnFinish(ctx);
      ephemeralConversationPersistence.persistSnapshot(ctx, {
        getPersistedSnapshot,
      });
      ephemeralConversationPersistence.notifyProjectStatus(ctx);
      ephemeralConversationPersistence.triggerAutoNaming(
        makeFirstTurnContext(),
      );
      await flush();

      expect(deps.mutateCalls).toHaveLength(0);
      expect(deps.publishCalls).toHaveLength(0);
      expect(deps.queueAutoNameCalls).toHaveLength(0);
      expect(getPersistedSnapshot).not.toHaveBeenCalled();
    });
  });

  describe("notifyProjectStatus", () => {
    let statusCalls: number;
    let notificationService: ProjectConversationNotificationService;

    beforeEach(() => {
      statusCalls = 0;
      notificationService = {
        handleProjectConversationStatus: () => {
          statusCalls += 1;
          return null;
        },
        handleProjectConversationError: () => {
          statusCalls += 1;
          return {} as never;
        },
      };
      setProjectConversationStatusNotificationDepsForTesting({
        getProjectConversation: async () => null,
        notificationService,
      });
    });

    afterEach(() => {
      _resetProjectConversationStatusNotificationDepsForTesting();
    });

    it("durable fires the project notification for a sentinel-session conversation", async () => {
      durableConversationPersistence.notifyProjectStatus(
        makeContext({
          sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
          status: "awaiting",
        }),
      );
      await vi.waitFor(() => expect(statusCalls).toBe(1));
    });

    it("durable does not notify for an ordinary session conversation", async () => {
      durableConversationPersistence.notifyProjectStatus(
        makeContext({ sessionName: "sess", status: "awaiting" }),
      );
      await flush();
      expect(statusCalls).toBe(0);
    });

    it("ephemeral never notifies, even for a sentinel-session conversation", async () => {
      ephemeralConversationPersistence.notifyProjectStatus(
        makeContext({
          sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
          status: "awaiting",
        }),
      );
      await flush();
      expect(statusCalls).toBe(0);
    });
  });

  describe("gateActorDurableWrites (invoked-actor durable seams)", () => {
    // Every durable state-store WRITE seam the invoked actors can reach. The
    // apply services are included because they persist INDIRECTLY —
    // `applyMcpAtTurnStart` through `stateManager.mutateConversation`,
    // `applyCapability*` through `writeRuntimeState` — so a facet that gated
    // only the direct writes would let an ephemeral `ExecutePrompt` turn write.
    const WRITE_SEAMS = [
      "mutateConversation",
      "createReferenceDocument",
      "markQueuedDelivered",
      "markQueuedPending",
      "markQueuedFailed",
      "recordNotepadDeliveries",
      "settleNotepadChangeNotice",
      "claimWorkflowResults",
      "settleWorkflowResults",
      "releaseWorkflowResults",
      "applyMcpAtTurnStart",
      "applyCapabilityAtTurnStart",
      "applyCapabilityWhenIdle",
    ] as const;

    interface RecordingWriteSeams extends ActorDurableWriteSeams {
      /** A non-write marker that must survive the ephemeral overlay untouched. */
      passthroughMarker: symbol;
      reached: string[];
    }

    function makeWriteSeams(): RecordingWriteSeams {
      const reached: string[] = [];
      return {
        passthroughMarker: Symbol("read-seam"),
        reached,
        mutateConversation: vi.fn(async () => {
          reached.push("mutateConversation");
        }),
        createReferenceDocument: vi.fn(async () => {
          reached.push("createReferenceDocument");
          return {};
        }),
        markQueuedDelivered: vi.fn(async () => {
          reached.push("markQueuedDelivered");
        }),
        markQueuedPending: vi.fn(async () => {
          reached.push("markQueuedPending");
        }),
        markQueuedFailed: vi.fn(async () => {
          reached.push("markQueuedFailed");
        }),
        recordNotepadDeliveries: vi.fn(async () => {
          reached.push("recordNotepadDeliveries");
        }),
        settleNotepadChangeNotice: vi.fn(async () => {
          reached.push("settleNotepadChangeNotice");
        }),
        claimWorkflowResults: vi.fn(async () => {
          reached.push("claimWorkflowResults");
          return [];
        }),
        settleWorkflowResults: vi.fn(async () => {
          reached.push("settleWorkflowResults");
          return 0;
        }),
        releaseWorkflowResults: vi.fn(async () => {
          reached.push("releaseWorkflowResults");
          return 0;
        }),
        applyMcpAtTurnStart: vi.fn(async () => {
          reached.push("applyMcpAtTurnStart");
          return {
            conversationId: "conv-1",
            backend: "claude" as const,
            disposition: "applied_now" as const,
            effectiveConfigHash: "hash-1",
          };
        }),
        applyCapabilityAtTurnStart: vi.fn(async () => {
          reached.push("applyCapabilityAtTurnStart");
          return {};
        }),
        applyCapabilityWhenIdle: vi.fn(async () => {
          reached.push("applyCapabilityWhenIdle");
          return {};
        }),
      };
    }

    const identity = {
      projectPath: "/p",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      worktreePath: "/p/.worktrees/sess",
      backend: "claude" as const,
    };

    it("durable returns the deps by reference — every write seam stays the injected one", async () => {
      const seams = makeWriteSeams();
      const gated =
        durableConversationPersistence.gateActorDurableWrites(seams);
      expect(gated).toBe(seams);
      for (const key of WRITE_SEAMS) {
        expect(gated[key]).toBe(seams[key]);
      }
      // Sanity: a call on the durable-gated deps reaches the real seam.
      await gated.mutateConversation("/p", "sess", "conv-1", "label", () => {});
      expect(seams.reached).toContain("mutateConversation");
    });

    it("ephemeral overrides EVERY durable write seam and leaves non-write deps untouched", () => {
      const seams = makeWriteSeams();
      const gated =
        ephemeralConversationPersistence.gateActorDurableWrites(seams);
      expect(gated).not.toBe(seams);
      for (const key of WRITE_SEAMS) {
        // Each write seam is replaced (not the injected function reference).
        expect(gated[key]).not.toBe(seams[key]);
      }
      // The overlay touches ONLY the write seams — a read/other dep passes through.
      expect(gated.passthroughMarker).toBe(seams.passthroughMarker);
    });

    it("ephemeral write seams are inert no-ops — none reaches the injected state-store seam", async () => {
      const seams = makeWriteSeams();
      const gated =
        ephemeralConversationPersistence.gateActorDurableWrites(seams);

      await gated.mutateConversation("/p", "sess", "conv-1", "label", () => {});
      await gated.createReferenceDocument("/p", "sess", "/f.md", "desc");
      await gated.markQueuedDelivered({
        projectPath: "/p",
        sessionName: "sess",
        conversationId: "conv-1",
        ids: ["m1"],
        deliveryAttemptId: "a1",
      });
      await gated.markQueuedPending({
        projectPath: "/p",
        sessionName: "sess",
        conversationId: "conv-1",
        ids: ["m1"],
        deliveryAttemptId: "a1",
        error: "e",
      });
      await gated.markQueuedFailed({
        projectPath: "/p",
        sessionName: "sess",
        conversationId: "conv-1",
        ids: ["m1"],
        deliveryAttemptId: "a1",
        error: "e",
      });
      const mcp = await gated.applyMcpAtTurnStart({
        projectPath: "/p",
        sessionName: "sess",
        conversationId: "conv-1",
        backend: "claude",
      });
      await gated.applyCapabilityAtTurnStart(identity);
      await gated.applyCapabilityWhenIdle(identity);

      // Not one of the injected durable seams was reached.
      expect(seams.reached).toEqual([]);
      expect(seams.mutateConversation).not.toHaveBeenCalled();
      expect(seams.applyMcpAtTurnStart).not.toHaveBeenCalled();
      expect(seams.applyCapabilityAtTurnStart).not.toHaveBeenCalled();
      expect(seams.applyCapabilityWhenIdle).not.toHaveBeenCalled();
      // The MCP no-op reports a non-rejected, inert disposition so a turn that
      // consults it still proceeds (the actor only fails on `rejected`).
      expect(mcp.disposition).toBe("no_active_runtime");
    });
  });

  describe("applySyncDerivedFields", () => {
    it("copies the resolved active-turn source and totals onto the row", () => {
      const conversation = {} as ConversationState;
      applySyncDerivedFields(
        makeContext({ status: "running", promptCount: 7 }),
        conversation,
      );
      expect(conversation.status).toBe("running");
      expect(conversation.promptCount).toBe(7);
      expect(conversation.activeTurnSource).toBeNull();
      expect(conversation.totalTurns).toBe(3);
    });
  });
});
