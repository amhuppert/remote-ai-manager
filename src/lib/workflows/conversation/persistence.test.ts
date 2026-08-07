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
  type ConversationPersistenceDeps,
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
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "sess-1";
const CONVERSATION_ID = "conv-1";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return makeConversationState({
    profileSnapshot: null,
    id: CONVERSATION_ID,
    status: "awaiting",
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    ...overrides,
  });
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

  /** The production sidecar seam the persistence layer now writes through. */
  function sidecarDeps(): ConversationPersistenceDeps {
    return {
      getConversationMachineSnapshot:
        fixture.store.getConversationMachineSnapshot,
      upsertConversationMachineSnapshot:
        fixture.store.upsertConversationMachineSnapshot,
      deleteConversationMachineSnapshot:
        fixture.store.deleteConversationMachineSnapshot,
    };
  }

  /** Read the session conversation's persisted resume token from the sidecar. */
  function reloadSnapshot(conversationId = CONVERSATION_ID): unknown {
    return fixture.store.getConversationMachineSnapshot(
      "session",
      conversationId,
    );
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
    setPersistenceDeps(sidecarDeps());
  });

  afterEach(() => {
    _resetForTesting();
    fixture.close();
  });

  describe("persistConversationSnapshot", () => {
    it("persists the projected snapshot to the sidecar", async () => {
      const snapshot = { value: "idle" } as never;

      persistConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        snapshot,
        { debounceMs: 0 },
      );

      await vi.waitFor(() => {
        expect(reloadSnapshot()).toEqual({ value: "idle" });
      });
    });

    // The persisted snapshot is a resume token, not an archive: the projection
    // codec drops `lastResult.contentBlocks` (a duplicate of the transcript) and
    // the XState `children` subtree, while keeping the machine value and every
    // context scalar the rehydrator resumes from.
    it("drops lastResult.contentBlocks and the children subtree on the persist path", async () => {
      const snapshot = {
        status: "active",
        value: { executing: "conversationTurn" },
        context: {
          _schemaVersion: 1,
          conversationId: CONVERSATION_ID,
          backendRef: { backend: "claude", ref: "sess-live" },
          totals: { totalCostUsd: 1.5, totalTurns: 2 },
          lastResult: {
            costUsd: 1.5,
            error: null,
            aborted: false,
            contentBlocks: [
              { type: "text", text: "x".repeat(5000) },
              { type: "text", text: "y".repeat(5000) },
            ],
          },
        },
        children: {
          "0.executing.conversationTurn": {
            snapshot: { status: "active", input: { big: "z".repeat(5000) } },
            src: "executePrompt",
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

      await vi.waitFor(() => {
        expect(reloadSnapshot()).not.toBeNull();
      });

      const persisted = reloadSnapshot() as {
        value: unknown;
        children?: unknown;
        context: {
          totals: unknown;
          backendRef: unknown;
          lastResult: { costUsd: number; contentBlocks?: unknown };
        };
      };
      // Retained: machine value, context identity/backendRef/totals, lastResult
      // scalars.
      expect(persisted.value).toEqual({ executing: "conversationTurn" });
      expect(persisted.context.backendRef).toEqual({
        backend: "claude",
        ref: "sess-live",
      });
      expect(persisted.context.totals).toEqual({
        totalCostUsd: 1.5,
        totalTurns: 2,
      });
      expect(persisted.context.lastResult.costUsd).toBe(1.5);
      // Dropped: the two large content carriers.
      expect(persisted.context.lastResult.contentBlocks).toBeUndefined();
      expect(persisted.children).toBeUndefined();
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

      await vi.waitFor(() => {
        const persisted = reloadSnapshot() as {
          context: {
            backendRef: unknown;
            forkedFrom: { sourceBackendRef: unknown };
          };
        } | null;
        expect(persisted?.context.backendRef).toEqual({
          backend: "claude",
          ref: "sess-live",
        });
        expect(persisted?.context.forkedFrom.sourceBackendRef).toEqual({
          backend: "codex",
          ref: "thr-src",
        });
      });

      // No persisted ref carries a mirrored legacy key: the on-disk shape is
      // canonical, identical to the live shape.
      for (const { path, value } of collectRefOccurrences(reloadSnapshot())) {
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
    // to fail on every machine transition. The guard must skip the sidecar
    // write entirely.
    it("skips the sidecar write for snapshots whose context is transient", async () => {
      const upsertedIds: string[] = [];
      setPersistenceDeps({
        ...sidecarDeps(),
        upsertConversationMachineSnapshot: (
          owner,
          conversationId,
          snapshot,
        ) => {
          upsertedIds.push(conversationId);
          return fixture.store.upsertConversationMachineSnapshot(
            owner,
            conversationId,
            snapshot,
          );
        },
      });

      persistConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        "compaction-artifact-1",
        { value: "idle", context: { transient: true } } as never,
        { debounceMs: 0 },
      );

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(upsertedIds).toEqual([]);
    });

    it("still persists snapshots whose context is not transient", async () => {
      persistConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        { value: "idle", context: { transient: false } } as never,
        { debounceMs: 0 },
      );

      await vi.waitFor(() => {
        expect(reloadSnapshot()).toEqual({
          value: "idle",
          context: { transient: false },
        });
      });
    });

    // Raw-bytes contract for the canonical cutover: every ref reaching the
    // sidecar is canonical `{backend, ref}` with no mirrored legacy key. The
    // projection drops the XState `children` subtree, so a mid-turn snapshot's
    // persisted form carries the root context ref and no children at all.
    it("persists canonical root refs and drops the active child snapshot subtree", async () => {
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
          forkPending: false,
        },
        role: null,
        transcriptPath: null,
        agentBackend: "claude",
        backendRef: { backend: "claude", ref: "sess-mid-turn" },
        promptCount: 1,
        persistence: "durable",
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
      // Guard: the live snapshot really carries a `children` subtree, so the
      // "dropped" assertion below is not vacuous.
      expect(
        (liveSnapshot as unknown as { children?: unknown }).children,
      ).toBeDefined();
      try {
        persistConversationSnapshot(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
          liveSnapshot,
          { debounceMs: 0 },
        );

        await vi.waitFor(() => {
          expect(reloadSnapshot()).not.toBeNull();
        });

        const persisted = reloadSnapshot();
        // The children subtree is gone from the resume token.
        expect((persisted as { children?: unknown }).children).toBeUndefined();
        const persistedOccurrences = collectRefOccurrences(persisted);
        // The root context ref survives and no persisted ref lives under a
        // `.children.` path.
        expect(
          persistedOccurrences.some((o) => o.path === "$.context.backendRef"),
        ).toBe(true);
        expect(
          persistedOccurrences.some((o) => o.path.includes(".children.")),
        ).toBe(false);
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
        expect(reloadSnapshot()).toBeNull();

        // Advance past the debounce; this fires the timer and flushes the
        // async write through the real write queue.
        await vi.advanceTimersByTimeAsync(600);

        expect(reloadSnapshot()).toEqual({ value: "idle" });
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

        await vi.waitFor(() => {
          expect(reloadSnapshot()).not.toBeNull();
        });

        expect((reloadSnapshot() as { value: unknown }).value).toBe("running");
      } finally {
        actor.stop();
      }
    });
  });

  describe("restoreConversationSnapshot", () => {
    async function seedSnapshot(snapshot: unknown): Promise<void> {
      await fixture.store.upsertConversationMachineSnapshot(
        "session",
        CONVERSATION_ID,
        snapshot,
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
      // The seeded conversation has no sidecar row.
      const result = await restoreConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        1,
      );
      expect(result).toBeNull();
    });

    it("returns null when conversation has no sidecar row", async () => {
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
    it("clears a persisted sidecar snapshot back to absent", async () => {
      await fixture.store.upsertConversationMachineSnapshot(
        "session",
        CONVERSATION_ID,
        { value: "idle" },
      );
      expect(reloadSnapshot()).toEqual({ value: "idle" });

      await clearConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
      );

      expect(reloadSnapshot()).toBeNull();
    });
  });
});
