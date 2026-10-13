import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  projectConversationTarget,
  sessionConversationTarget,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createRuntimeInstructionReaders } from "./runtime-instructions";

const AGENT_HINT = "agent-run-hint";
const RUN_HINT = "run-launch-hint";

describe("the runtime's instructions, prepared for a turn or read at rest (design C5b §5)", () => {
  let fixture: PersistenceFixture;
  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject("/repo");
    fixture.seedSession("/repo", "session");
  });
  afterEach(() => fixture.close());

  /** The production readers over the fixture's store, with a worktree whose `memory-bank/focus.md` exists. */
  function readers() {
    return createRuntimeInstructionReaders({
      execution: {
        getSessionState: (projectPath, sessionName) =>
          fixture.store.getSession(projectPath, sessionName),
        fileExists: (filePath) => filePath.endsWith("memory-bank/focus.md"),
        getConversation: (projectPath, sessionName, conversationId) =>
          fixture.store.getConversation(
            projectPath,
            sessionName,
            conversationId,
          ),
        getCodexToolPromptHint: () => AGENT_HINT,
        getRunToolPromptHint: () => RUN_HINT,
      },
      context: {
        getReferenceDocuments: (projectPath, sessionName) =>
          fixture.store.getReferenceDocuments(projectPath, sessionName),
        getActiveAlignmentInjection: async () => null,
        getWorkflowLaneInstructions: async () => null,
      },
      effects: {
        createReferenceDocument: (
          projectPath,
          sessionName,
          filePath,
          description,
        ) =>
          fixture.store.createReferenceDocument(
            projectPath,
            sessionName,
            filePath,
            description,
          ),
      },
    });
  }
  const conversation = {
    conversationId: "conv-1",
    projectPath: "/repo",
    projectName: "repo",
    target: sessionConversationTarget("repo", "session", "conv-1"),
    worktreePath: "/repo/.worktrees/session",
    backend: "claude" as const,
    executionClass: "governed-execution" as const,
    persistedRef: null,
  };
  const selection = { autonomous: false };

  it("reads them at rest, as the memory index preview does, without registering anything", async () => {
    const at = readers();

    const read = await at.readInstructions(conversation, selection);

    expect(read.sessionInstructions.length).toBeGreaterThan(0);
    expect(
      await fixture.store.getReferenceDocuments("/repo", "session"),
    ).toEqual([]);
  });

  it("prepares them for a turn, registering the session's focus memory first", async () => {
    await readers().instructions(conversation, selection);

    expect(
      (await fixture.store.getReferenceDocuments("/repo", "session")).map(
        (document) => document.filePath,
      ),
    ).toEqual(["memory-bank/focus.md"]);
  });

  describe("the delegation hint each conversation receives", () => {
    async function hintsOf(
      target: ConversationTarget,
    ): Promise<{ run: boolean; agent: boolean }> {
      const read = await readers().readInstructions(
        { ...conversation, target },
        selection,
      );
      return {
        run: read.sessionInstructions.includes(RUN_HINT),
        agent: read.sessionInstructions.includes(AGENT_HINT),
      };
    }

    it("tells a session conversation that may own a run to launch one", async () => {
      await fixture.seedConversation(
        "/repo",
        "session",
        makeConversationState({ id: "conv-1" }),
      );

      expect(await hintsOf(conversation.target)).toEqual({
        run: true,
        agent: false,
      });
    });

    it("keeps the one-shot agent hint for a run seat, which cannot own a run", async () => {
      await fixture.seedConversation(
        "/repo",
        "session",
        makeConversationState({ id: "seat-1", role: "iteration" }),
      );

      expect(
        await hintsOf(sessionConversationTarget("repo", "session", "seat-1")),
      ).toEqual({ run: false, agent: true });
    });

    it("keeps the one-shot agent hint for a conversation of an archived session", async () => {
      fixture.seedSession("/repo", "archived", { archived: true });
      await fixture.seedConversation(
        "/repo",
        "archived",
        makeConversationState({ id: "conv-2" }),
      );

      expect(
        await hintsOf(sessionConversationTarget("repo", "archived", "conv-2")),
      ).toEqual({ run: false, agent: true });
    });

    it("keeps the one-shot agent hint for a conversation of a finished session, which takes no new run", async () => {
      fixture.seedSession("/repo", "finished", { finished: true });
      await fixture.seedConversation(
        "/repo",
        "finished",
        makeConversationState({ id: "conv-3" }),
      );

      expect(
        await hintsOf(sessionConversationTarget("repo", "finished", "conv-3")),
      ).toEqual({ run: false, agent: true });
    });

    it("keeps the one-shot agent hint for a project conversation, which has no session to launch into", async () => {
      await fixture.seedProjectConversation(
        "/repo",
        makeConversationState({ id: "project-1", scope: "project" }),
      );

      expect(
        await hintsOf(projectConversationTarget("repo", "project-1")),
      ).toEqual({ run: false, agent: true });
    });
  });
});
