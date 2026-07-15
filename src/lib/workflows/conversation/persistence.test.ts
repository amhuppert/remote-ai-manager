import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { z } from "zod";
import { createActor, fromPromise, setup } from "xstate";
import {
  persistConversationSnapshot,
  persistSnapshotAfterTransition,
  restoreConversationSnapshot,
  validateRestoredSnapshot,
  clearConversationSnapshot,
  setPersistenceDeps,
  _resetForTesting,
} from "./persistence";
import { conversationMachine } from "./machine";
import type {
  ConversationInput,
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
} from "./types";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { ConversationState } from "@/lib/conversations/schemas";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "sess-1";
const CONVERSATION_ID = "conv-1";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: CONVERSATION_ID,
    scope: "session",
    name: null,
    transcriptPath: null,
    status: "awaiting",
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude" as const,
    backendRef: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    ...overrides,
  };
}

interface RefOccurrence {
  path: string;
  value: Record<string, unknown>;
}

/**
 * Deep-walk arbitrary JSON collecting every object that looks like a session
 * ref (a claude/codex `backend` plus any known handle key), with its path.
 * Deliberately looser than the production matcher so a half-encoded or
 * canonical-only occurrence is still collected and fails the assertions.
 */
function collectRefOccurrences(node: unknown, path = "$"): RefOccurrence[] {
  if (node === null || typeof node !== "object") return [];
  const out: RefOccurrence[] = [];
  const obj = node as Record<string, unknown>;
  if (
    !Array.isArray(node) &&
    (obj.backend === "claude" || obj.backend === "codex") &&
    (typeof obj.ref === "string" ||
      typeof obj.sessionId === "string" ||
      typeof obj.threadId === "string")
  ) {
    out.push({ path, value: obj });
  }
  const entries = Array.isArray(node)
    ? node.map((value, index) => [String(index), value] as const)
    : Object.entries(obj);
  for (const [key, value] of entries) {
    out.push(...collectRefOccurrences(value, `${path}.${key}`));
  }
  return out;
}

describe("conversation persistence", () => {
  let fixture: PersistenceFixture;

  /** Reload the seeded conversation through the real serialization boundary. */
  async function reloadConversation(): Promise<ConversationState> {
    const conversation = await fixture.deps.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    if (!conversation) {
      throw new Error("seeded conversation missing after reload");
    }
    return conversation;
  }

  beforeEach(async () => {
    _resetForTesting();
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      makeConversation(),
    );
    setPersistenceDeps(fixture.deps);
  });

  afterEach(() => {
    _resetForTesting();
    fixture.close();
  });

  describe("persistConversationSnapshot", () => {
    it("persists the snapshot to the conversation record", async () => {
      const snapshot = { value: "idle" } as never;

      persistConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        snapshot,
        { debounceMs: 0 },
      );

      await vi.waitFor(async () => {
        const reloaded = await reloadConversation();
        expect(reloaded.machineSnapshot).toEqual({ value: "idle" });
      });
    });

    it("persists context refs as canonical bytes without mutating the live snapshot", async () => {
      const snapshot = {
        value: "idle",
        context: {
          _schemaVersion: 1,
          conversationId: CONVERSATION_ID,
          backendRef: { backend: "claude", ref: "sess-live" },
          forkedFrom: {
            sourceConversationId: "parent",
            messageIndex: 1,
            sourceBackendRef: { backend: "codex", ref: "thr-src" },
          },
        },
      } as never;

      persistConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        snapshot,
        { debounceMs: 0 },
      );

      await vi.waitFor(async () => {
        const reloaded = await reloadConversation();
        const persisted = reloaded.machineSnapshot as {
          context: {
            backendRef: unknown;
            forkedFrom: { sourceBackendRef: unknown };
          };
        };
        expect(persisted.context.backendRef).toEqual({
          backend: "claude",
          ref: "sess-live",
        });
        expect(persisted.context.forkedFrom.sourceBackendRef).toEqual({
          backend: "codex",
          ref: "thr-src",
        });
      });

      // No persisted ref carries a mirrored legacy key: the on-disk shape is
      // canonical, identical to the live shape.
      const reloaded = await reloadConversation();
      for (const { path, value } of collectRefOccurrences(
        reloaded.machineSnapshot,
      )) {
        expect(value, `persisted ref not canonical at ${path}`).toEqual({
          backend: value.backend,
          ref: value.ref,
        });
      }

      const live = snapshot as {
        context: {
          backendRef: unknown;
          forkedFrom: { sourceBackendRef: unknown };
        };
      };
      expect(live.context.backendRef).toEqual({
        backend: "claude",
        ref: "sess-live",
      });
      expect(live.context.forkedFrom.sourceBackendRef).toEqual({
        backend: "codex",
        ref: "thr-src",
      });
    });

    // A transient lane (compaction's synthetic `compaction-<artifactId>`
    // conversation) has no ConversationState record, so the write path used
    // to fail with `snapshot_save_failed` on every machine transition. The
    // guard must skip the state-store write entirely.
    it("skips the state-store write for snapshots whose context is transient", async () => {
      const mutatedConversationIds: string[] = [];
      const mutateConversation: typeof fixture.deps.mutateConversation = (
        projectPath,
        sessionName,
        conversationId,
        label,
        mutate,
      ) => {
        mutatedConversationIds.push(conversationId);
        return fixture.deps.mutateConversation(
          projectPath,
          sessionName,
          conversationId,
          label,
          mutate,
        );
      };
      setPersistenceDeps({ ...fixture.deps, mutateConversation });

      persistConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        "compaction-artifact-1",
        { value: "idle", context: { transient: true } } as never,
        { debounceMs: 0 },
      );

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(mutatedConversationIds).toEqual([]);
    });

    it("still persists snapshots whose context is not transient", async () => {
      persistConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        { value: "idle", context: { transient: false } } as never,
        { debounceMs: 0 },
      );

      await vi.waitFor(async () => {
        const reloaded = await reloadConversation();
        expect(reloaded.machineSnapshot).toEqual({
          value: "idle",
          context: { transient: false },
        });
      });
    });

    // Raw-bytes contract for the canonical cutover: every ref reaching
    // `machine_snapshot` is canonical `{backend, ref}` with no mirrored legacy
    // key, on the root context AND inside active XState child snapshots
    // (`children.*.snapshot.input.backendRef`), so the walk must be recursive.
    it("persists every ref occurrence as canonical bytes, including inside active child snapshots", async () => {
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
            async () => ({ transcriptPath: "/tmp/transcript.jsonl" }),
          ),
          // Never settles: the persisted snapshot is captured while the
          // executePrompt child is active and still holds its input.
          executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
            () => new Promise<PromptActorResult>(() => {}),
          ),
        },
      });
      const input: ConversationInput = {
        projectPath: PROJECT_PATH,
        projectName: "my-project",
        sessionName: SESSION_NAME,
        worktreePath: "/repo/.worktrees/sess-1",
        conversationId: CONVERSATION_ID,
        createdAt: "2024-01-01T00:00:00Z",
        forkedFrom: {
          sourceConversationId: "parent-conv",
          messageIndex: 2,
          sourceBackend: "codex",
          sourceBackendRef: { backend: "codex", ref: "thr-fork-src" },
          forkLocator: null,
          forkMode: "native",
        },
        role: null,
        transcriptPath: null,
        agentBackend: "claude",
        backendRef: { backend: "claude", ref: "sess-mid-turn" },
        promptCount: 1,
      };
      const actor = createActor(machine, { input });
      actor.start();
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "hello",
        streamId: "stream-1",
      });
      await vi.waitFor(() => {
        expect(JSON.stringify(actor.getSnapshot().value)).toContain(
          "conversationTurn",
        );
      });

      const liveSnapshot = actor.getPersistedSnapshot();
      try {
        persistConversationSnapshot(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
          liveSnapshot,
          { debounceMs: 0 },
        );

        await vi.waitFor(async () => {
          const reloaded = await reloadConversation();
          expect(reloaded.machineSnapshot).not.toBeNull();
        });

        const reloaded = await reloadConversation();
        const persistedOccurrences = collectRefOccurrences(
          reloaded.machineSnapshot,
        );
        // The corpus must contain the root context ref AND at least one ref
        // inside a child snapshot — otherwise the contract passes vacuously.
        expect(
          persistedOccurrences.some((o) => o.path === "$.context.backendRef"),
        ).toBe(true);
        expect(
          persistedOccurrences.some((o) => o.path.includes(".children.")),
        ).toBe(true);
        for (const { path, value } of persistedOccurrences) {
          expect(value, `persisted ref not canonical at ${path}`).toEqual({
            backend: value.backend,
            ref: value.ref,
          });
        }

        // The captured live snapshot must stay canonical too — the write path
        // clones before rewriting, so the live tree is never mutated.
        for (const { path, value } of collectRefOccurrences(liveSnapshot)) {
          expect(value, `live ref not canonical at ${path}`).toEqual({
            backend: value.backend,
            ref: value.ref,
          });
        }
      } finally {
        actor.stop();
      }
    });

    it("debounces writes by default", async () => {
      vi.useFakeTimers();
      try {
        persistConversationSnapshot(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
          {
            value: "idle",
          } as never,
        );

        // Nothing persisted before the debounce window elapses.
        const beforeDebounce = await reloadConversation();
        expect(beforeDebounce.machineSnapshot).toBeNull();

        // Advance past the debounce; this fires the timer and flushes the
        // async write through the real write queue.
        await vi.advanceTimersByTimeAsync(600);

        const afterDebounce = await reloadConversation();
        expect(afterDebounce.machineSnapshot).toEqual({ value: "idle" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("persistSnapshotAfterTransition", () => {
    // Regression: XState runs transition actions while the macrostep is still
    // resolving, so capturing `getPersistedSnapshot()` synchronously inside
    // the `persistSnapshot` action persisted the PREVIOUS macrostep — the
    // durable snapshot lagged one event behind (a BACKEND_INIT persist missed
    // the backendRef it had just assigned).
    it("persists the state the actor settles into AFTER the event, not the previous macrostep", async () => {
      const machine = setup({}).createMachine({
        initial: "idle",
        states: {
          idle: {
            on: {
              GO: {
                target: "running",
                actions: ({ self }) =>
                  persistSnapshotAfterTransition(
                    {
                      projectPath: PROJECT_PATH,
                      sessionName: SESSION_NAME,
                      conversationId: CONVERSATION_ID,
                    },
                    self,
                    { debounceMs: 0 },
                  ),
              },
            },
          },
          running: {},
        },
      });
      const actor = createActor(machine);
      actor.start();
      try {
        actor.send({ type: "GO" });

        await vi.waitFor(async () => {
          const reloaded = await reloadConversation();
          expect(reloaded.machineSnapshot).not.toBeNull();
        });

        const reloaded = await reloadConversation();
        expect((reloaded.machineSnapshot as { value: unknown }).value).toBe(
          "running",
        );
      } finally {
        actor.stop();
      }
    });
  });

  describe("restoreConversationSnapshot", () => {
    async function seedSnapshot(snapshot: unknown): Promise<void> {
      await fixture.deps.mutateConversation(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "test.seed-snapshot",
        (conversation) => {
          conversation.machineSnapshot = snapshot;
        },
      );
    }

    it("returns snapshot when schema version matches", async () => {
      const snapshot = {
        context: { _schemaVersion: 1, conversationId: CONVERSATION_ID },
        value: "idle",
      };
      await seedSnapshot(snapshot);

      const result = await restoreConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        1,
      );
      expect(result).toEqual(snapshot);
    });

    it("returns null when schema version mismatches", async () => {
      const snapshot = {
        context: { _schemaVersion: 99, conversationId: CONVERSATION_ID },
        value: "idle",
      };
      await seedSnapshot(snapshot);

      const result = await restoreConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        1,
      );
      expect(result).toBeNull();
    });

    it("returns null when no snapshot exists", async () => {
      // The seeded conversation already has a null machineSnapshot.
      const result = await restoreConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        1,
      );
      expect(result).toBeNull();
    });

    it("returns null when conversation not found", async () => {
      const result = await restoreConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        "missing-conv",
        1,
      );
      expect(result).toBeNull();
    });
  });

  describe("validateRestoredSnapshot", () => {
    it("returns snapshot when schema version matches", () => {
      const snapshot = {
        context: { _schemaVersion: 1, conversationId: CONVERSATION_ID },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, CONVERSATION_ID, 1);

      expect(result).toEqual(snapshot);
    });

    it("normalizes an active debug snapshot that has no session generation", () => {
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: CONVERSATION_ID,
          debugMode: {
            active: true,
            recording: true,
            logFilePath: "/tmp/debug.jsonl",
            enteredAt: "2024-01-01T00:00:00Z",
          },
        },
        value: "debug",
      };

      const result = validateRestoredSnapshot(
        snapshot,
        CONVERSATION_ID,
        1,
      ) as unknown as {
        context: {
          debugMode: { debugSessionId?: string };
          debugGenerationNeedsPersistence?: boolean;
        };
      };

      expect(result.context.debugMode.debugSessionId).toEqual(
        expect.any(String),
      );
      expect(result.context.debugGenerationNeedsPersistence).toBe(true);
    });

    it("returns null when schema version mismatches", () => {
      const snapshot = {
        context: { _schemaVersion: 99, conversationId: CONVERSATION_ID },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, CONVERSATION_ID, 1);

      expect(result).toBeNull();
    });

    it("returns null when snapshot is null", () => {
      const result = validateRestoredSnapshot(null, CONVERSATION_ID, 1);
      expect(result).toBeNull();
    });

    it("normalizes a legacy context.backendRef to the canonical ref shape", () => {
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: CONVERSATION_ID,
          backendRef: { backend: "claude", sessionId: "sess-legacy" },
        },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, CONVERSATION_ID, 1);

      expect(result).not.toBeNull();
      const { context } = z
        .object({ context: z.object({ backendRef: z.unknown() }) })
        .parse(result);
      expect(context.backendRef).toEqual({
        backend: "claude",
        ref: "sess-legacy",
      });
    });

    it("normalizes a superset context.backendRef and a legacy forkedFrom.sourceBackendRef", () => {
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: CONVERSATION_ID,
          backendRef: {
            backend: "codex",
            ref: "thr-super",
            threadId: "thr-super",
          },
          forkedFrom: {
            sourceConversationId: "parent",
            messageIndex: 0,
            sourceBackendRef: { backend: "codex", threadId: "thr-fork" },
          },
        },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, CONVERSATION_ID, 1);

      expect(result).not.toBeNull();
      const { context } = z
        .object({
          context: z.object({
            backendRef: z.unknown(),
            forkedFrom: z.object({
              sourceBackendRef: z.unknown(),
              messageIndex: z.number(),
            }),
          }),
        })
        .parse(result);
      expect(context.backendRef).toEqual({
        backend: "codex",
        ref: "thr-super",
      });
      expect(context.forkedFrom.sourceBackendRef).toEqual({
        backend: "codex",
        ref: "thr-fork",
      });
      expect(context.forkedFrom.messageIndex).toBe(0);
    });

    // A snapshot persisted mid-turn (by this build's shadow encoder, by
    // migration 0005, or by an old build writing pure legacy refs) carries
    // encoded refs inside active child snapshots too. Restoration must hand
    // the actor a fully canonical tree.
    it("normalizes shadow and legacy refs inside child snapshots back to canonical", () => {
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: CONVERSATION_ID,
          backendRef: {
            backend: "claude",
            ref: "sess-root",
            sessionId: "sess-root",
          },
        },
        value: { executing: "conversationTurn" },
        children: {
          "0.conversation.executing.conversationTurn": {
            snapshot: {
              status: "active",
              input: {
                conversationId: CONVERSATION_ID,
                backendRef: { backend: "claude", sessionId: "sess-child" },
                forkedFrom: {
                  sourceConversationId: "parent",
                  messageIndex: 0,
                  sourceBackendRef: {
                    backend: "codex",
                    ref: "thr-child",
                    threadId: "thr-child",
                  },
                },
              },
            },
            src: "executePrompt",
          },
        },
      };

      const result = validateRestoredSnapshot(snapshot, CONVERSATION_ID, 1);

      expect(result).not.toBeNull();
      for (const { path, value } of collectRefOccurrences(result)) {
        expect(value, `restored ref not canonical at ${path}`).toEqual({
          backend: value.backend,
          ref: value.ref,
        });
      }
      const childInput = (
        result as unknown as {
          children: Record<
            string,
            { snapshot: { input: Record<string, unknown> } }
          >;
        }
      ).children["0.conversation.executing.conversationTurn"]!.snapshot.input;
      expect(childInput.backendRef).toEqual({
        backend: "claude",
        ref: "sess-child",
      });
    });

    it("returns null when snapshot has no context", () => {
      const result = validateRestoredSnapshot(
        { value: "idle" },
        CONVERSATION_ID,
        1,
      );
      expect(result).toBeNull();
    });

    it("coerces legacy persisted activeTurn (no kind) to conversation_turn variant and preserves all fields", () => {
      // Shaped like a pre-discriminator activeTurn — no `kind` field. The
      // restorer must add kind='conversation_turn' so the new machine code
      // matches the variant.
      const legacyActiveTurn = {
        promptText: "do the thing",
        images: [],
        backend: "claude",
        modelId: null,
        effort: null,
        autonomous: false,
        startedAt: "2024-01-01T00:00:00Z",
        streamId: "stream-legacy",
      };
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: CONVERSATION_ID,
          activeTurn: { ...legacyActiveTurn },
        },
        value: "executing",
      };

      const result = validateRestoredSnapshot(snapshot, CONVERSATION_ID, 1);

      expect(result).not.toBeNull();
      const restoredActiveTurn = (
        result as unknown as {
          context: { activeTurn: Record<string, unknown> };
        }
      ).context.activeTurn;
      expect(restoredActiveTurn).toEqual({
        kind: "conversation_turn",
        ...legacyActiveTurn,
      });

      // Re-serializing the in-memory shape into the persisted JSON form
      // round-trips the legacy fields verbatim — only `kind` is added.
      const reSerialized = JSON.parse(JSON.stringify(restoredActiveTurn));
      const { kind, ...withoutKind } = reSerialized as {
        kind: string;
      } & typeof legacyActiveTurn;
      expect(kind).toBe("conversation_turn");
      expect(withoutKind).toEqual(legacyActiveTurn);
    });

    it("round-trips a task_run activeTurn variant unchanged", () => {
      const taskRunActiveTurn = {
        kind: "task_run",
        startedAt: "2024-02-02T00:00:00Z",
        outputFormat: {
          type: "json_schema",
          schema: { type: "object" },
        },
      };
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: "conv-2",
          activeTurn: { ...taskRunActiveTurn },
        },
        value: "executing",
      };

      const result = validateRestoredSnapshot(snapshot, "conv-2", 1);

      expect(result).not.toBeNull();
      const restoredActiveTurn = (
        result as unknown as {
          context: { activeTurn: Record<string, unknown> };
        }
      ).context.activeTurn;
      expect(restoredActiveTurn).toEqual(taskRunActiveTurn);

      const reSerialized = JSON.parse(JSON.stringify(restoredActiveTurn));
      expect(reSerialized).toEqual(taskRunActiveTurn);
    });

    it("leaves a null activeTurn untouched", () => {
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: "conv-3",
          activeTurn: null,
        },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, "conv-3", 1);

      expect(result).not.toBeNull();
      const restored = result as unknown as {
        context: { activeTurn: unknown };
      };
      expect(restored.context.activeTurn).toBeNull();
    });
  });

  describe("clearConversationSnapshot", () => {
    it("clears a persisted machineSnapshot back to null", async () => {
      await fixture.deps.mutateConversation(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "test.seed-snapshot",
        (conversation) => {
          conversation.machineSnapshot = { value: "idle" };
        },
      );
      const seeded = await reloadConversation();
      expect(seeded.machineSnapshot).toEqual({ value: "idle" });

      await clearConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
      );

      const reloaded = await reloadConversation();
      expect(reloaded.machineSnapshot).toBeNull();
    });
  });
});
