import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type {
  CheckpointActorProjection,
  CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import {
  loadActorInput,
  conversationAggregateFields,
} from "./actor-input-loader";
import { createActor, fromPromise, waitFor } from "xstate";
import type { PromptActorResult, ExecutePromptInput } from "./types";
import { conversationMachine } from "./machine";
import { applySyncDerivedFields } from "./persistence-adapter";

/**
 * The shared actor input loader is the seam every out-of-band actor
 * materialization goes through: answer delivery, queue drain, enqueue and
 * debug-mode. It is session-keyed, so a project conversation arrives carrying
 * the sentinel — and the sentinel names no session row (D5).
 *
 * Resolution is proved through the real repositories: the two scopes live in
 * different tables, so a JS-object fake would prove nothing about which one the
 * loader reaches.
 */

const PROJECT_PATH = "/repos/cc";
const ts = "2026-01-01T00:00:00.000Z";

describe("loadActorInput (R4.3 / D5)", () => {
  let fixture: ReturnType<typeof createPersistenceFixture>;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
  });

  afterEach(() => {
    fixture.close();
  });

  let checkpointKeys: CheckpointScopeKey[] = [];
  let checkpointProjection: CheckpointActorProjection | null = null;

  function deps() {
    checkpointKeys = [];
    return {
      getSession: fixture.store.getSession,
      getProjectConversation: fixture.store.getProjectConversation,
      getProjectDisplayName: () => "cc",
      async hydrateCheckpointAuthority(key: CheckpointScopeKey) {
        checkpointKeys.push(key);
        return {
          projection: checkpointProjection,
          state: { active: null, latestAccepted: null },
          outcome: { kind: "none" as const },
          continuationRetired: false,
        };
      },
    };
  }

  function conversation(overrides: Record<string, unknown> = {}) {
    return conversationStateSchema.parse({
      id: "conv-1",
      status: "idle",
      transcriptPath: null,
      promptCount: 0,
      createdAt: ts,
      lastActivityAt: ts,
      agentBackend: "claude",
      ...overrides,
    });
  }

  it.each(["session", "project"] as const)(
    "preserves %s row accounting through construction and synchronization",
    async (scope) => {
      const stored = conversation({
        scope,
        promptCount: 7,
        totalCostUsd: 1.25,
        totalDurationMs: 1200,
        totalTurns: 11,
        contextTokens: 800,
        contextWindowMax: 200000,
        lastActivityAt: "2026-02-01T00:00:00.000Z",
      });
      const sessionName =
        scope === "project"
          ? PROJECT_CONVERSATION_SESSION_SENTINEL
          : "csm/feature";
      if (scope === "project") {
        await fixture.seedProjectConversation(PROJECT_PATH, stored);
      } else {
        fixture.seedSession(PROJECT_PATH, sessionName);
        await fixture.seedConversation(PROJECT_PATH, sessionName, stored);
      }
      const loaded = await loadActorInput(
        deps(),
        PROJECT_PATH,
        sessionName,
        stored.id,
      );
      const actor = createActor(
        conversationMachine.provide({
          actors: {
            prepareTurn: fromPromise(async () => ({
              transcriptPath: "/test/transcript.jsonl",
            })),
            executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
              async () => ({
                backendRef: null,
                costUsd: 0.75,
                durationMs: 300,
                numTurns: 2,
                contextTokens: 900,
                contextWindow: 200000,
                inputTokens: null,
                outputTokens: null,
                cachedInputTokens: null,
                contentBlocks: [],
                aborted: false,
                compacted: false,
                error: null,
                continuationDisposition: "retain",
              }),
            ),
          },
        }),
        {
          input: {
            ...loaded.conversation,
            target: targetFromStoreSessionName(
              loaded.projectName,
              sessionName,
              stored.id,
            ),

            projectPath: PROJECT_PATH,

            worktreePath: loaded.sessionWorktreePath,

            persistence: loaded.persistence,
          },
        },
      );
      const context = actor.getSnapshot().context;
      expect(Object.keys(context.totals).sort()).toEqual(
        [...conversationAggregateFields].sort(),
      );
      const synchronized = structuredClone(stored);
      applySyncDerivedFields(context, synchronized);
      for (const field of [
        "totalCostUsd",
        "totalDurationMs",
        "totalTurns",
        "contextTokens",
        "contextWindowMax",
        "promptCount",
        "lastActivityAt",
      ] as const) {
        expect(synchronized[field], field).toBe(stored[field]);
      }
      expect(context.lastActivityAt).toBe(stored.lastActivityAt);
      actor.start();
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "next turn",
        streamId: "next",
      });
      await waitFor(actor, (snapshot) => snapshot.context.promptCount === 8);
      applySyncDerivedFields(actor.getSnapshot().context, synchronized);
      expect(synchronized).toMatchObject({
        totalCostUsd: 2,
        totalDurationMs: 1500,
        totalTurns: 13,
        contextTokens: 900,
        contextWindowMax: 200000,
        promptCount: 8,
      });
      actor.stop();
    },
  );

  describe("checkpoint authority", () => {
    it.each(["session", "project"] as const)(
      "reads the %s conversation's active checkpoint by its storage scope before the actor exists",
      async (scope) => {
        const stored = conversation({ scope, promptCount: 3 });
        const sessionName =
          scope === "project"
            ? PROJECT_CONVERSATION_SESSION_SENTINEL
            : "csm/feature";
        if (scope === "project") {
          await fixture.seedProjectConversation(PROJECT_PATH, stored);
        } else {
          fixture.seedSession(PROJECT_PATH, sessionName);
          await fixture.seedConversation(PROJECT_PATH, sessionName, stored);
        }
        checkpointProjection = { operationId: "op-7", phase: "retiring" };
        const loaded = await loadActorInput(
          deps(),
          PROJECT_PATH,
          sessionName,
          stored.id,
        );
        expect(loaded.checkpoint).toEqual({
          operationId: "op-7",
          phase: "retiring",
        });
        expect(checkpointKeys).toEqual([
          scope === "project"
            ? {
                scope: "project",
                projectPath: PROJECT_PATH,
                sessionName: null,
                conversationId: stored.id,
              }
            : {
                scope: "session",
                projectPath: PROJECT_PATH,
                sessionName: "csm/feature",
                conversationId: stored.id,
              },
        ]);
        checkpointProjection = null;
      },
    );

    it("loads a null projection when no checkpoint owns the conversation", async () => {
      const stored = conversation({ scope: "session" });
      fixture.seedSession(PROJECT_PATH, "csm/feature");
      await fixture.seedConversation(PROJECT_PATH, "csm/feature", stored);
      const loaded = await loadActorInput(
        deps(),
        PROJECT_PATH,
        "csm/feature",
        stored.id,
      );
      expect(loaded.checkpoint).toBeNull();
    });
  });

  describe("session scope", () => {
    beforeEach(async () => {
      fixture.seedSession(PROJECT_PATH, "csm/feature");
      await fixture.seedConversation(
        PROJECT_PATH,
        "csm/feature",
        conversation({ agentBackend: "codex", promptCount: 3 }),
      );
    });

    it("resolves from the session repository and binds the session worktree", async () => {
      const input = await loadActorInput(
        deps(),
        PROJECT_PATH,
        "csm/feature",
        "conv-1",
      );

      expect(input.conversationScope).toBe("session");
      expect(input.sessionWorktreePath).toBe(
        `${PROJECT_PATH}/.worktrees/csm/feature`,
      );
      expect(input.persistence).toBe("durable");
      expect(input.conversation.agentBackend).toBe("codex");
      expect(input.conversation.promptCount).toBe(3);
    });

    it("throws when the session has no such conversation", async () => {
      await expect(
        loadActorInput(deps(), PROJECT_PATH, "csm/feature", "missing"),
      ).rejects.toThrow("Conversation not found: missing");
    });

    it("throws when the session does not exist", async () => {
      await expect(
        loadActorInput(deps(), PROJECT_PATH, "csm/other", "conv-1"),
      ).rejects.toThrow("Session not found: csm/other");
    });
  });

  describe("project scope", () => {
    beforeEach(async () => {
      await fixture.seedProjectConversation(
        PROJECT_PATH,
        conversation({
          scope: "project",
          agentBackend: "codex",
          promptCount: 2,
        }),
      );
    });

    it("resolves the project conversation with NO session record present", async () => {
      // The defect: the loader reached `getSession(projectPath, "__project__")`,
      // which names no row, so every out-of-band materialization of a project
      // conversation died with `Session not found: __project__`.
      const input = await loadActorInput(
        deps(),
        PROJECT_PATH,
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        "conv-1",
      );

      expect(input.conversationScope).toBe("project");
      // Bound to the project root — a project conversation executes there, and
      // has no session worktree to bind to.
      expect(input.sessionWorktreePath).toBe(PROJECT_PATH);
      expect(input.persistence).toBe("durable");
      expect(input.projectName).toBe("cc");
      expect(input.conversation.agentBackend).toBe("codex");
      expect(input.conversation.promptCount).toBe(2);
    });

    it("throws when the project has no such conversation", async () => {
      await expect(
        loadActorInput(
          deps(),
          PROJECT_PATH,
          PROJECT_CONVERSATION_SESSION_SENTINEL,
          "missing",
        ),
      ).rejects.toThrow("Conversation not found: missing");
    });

    it("never consults the session repository at project scope", async () => {
      // A seeded session named by the sentinel must not be what the loader
      // finds: the sentinel is a storage key, not a session to look up.
      fixture.seedSession(PROJECT_PATH, PROJECT_CONVERSATION_SESSION_SENTINEL);

      const input = await loadActorInput(
        deps(),
        PROJECT_PATH,
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        "conv-1",
      );

      expect(input.conversationScope).toBe("project");
      expect(input.sessionWorktreePath).toBe(PROJECT_PATH);
    });
  });
});
