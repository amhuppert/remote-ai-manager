import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { loadActorInput } from "./actor-input-loader";

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

  function deps() {
    return {
      getSession: fixture.store.getSession,
      getProjectConversation: fixture.store.getProjectConversation,
      getProjectDisplayName: () => "cc",
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
