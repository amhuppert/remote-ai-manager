import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createRuntimeInstructionReaders } from "./runtime-instructions";

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
        getCodexToolPromptHint: () => "",
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
});
