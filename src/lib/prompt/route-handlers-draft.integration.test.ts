import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  promptCoreConversation,
  type CoreConversationPromptDeps,
} from "@/lib/conversation-core/prompt-route";
import { runPromptRequestSchema } from "./schemas";

const PROJECT = "/repo";
const SESSION = "session";
const ID = "conversation";
const RAW = "  prompt with exact whitespace  ";
let fixture: PersistenceFixture;
beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, SESSION);
  await fixture.seedConversation(
    PROJECT,
    SESSION,
    makeConversationState({ id: ID, pendingPromptText: RAW }),
  );
});
afterEach(() => fixture.close());

async function prompt(
  options: { refused?: boolean; beforeAdmission?(): Promise<void> } = {},
) {
  const conversation = await fixture.store.getConversation(
    PROJECT,
    SESSION,
    ID,
  );
  if (conversation === null) throw new Error("fixture conversation missing");
  const deps: CoreConversationPromptDeps = {
    async sendUserMessage() {
      await options.beforeAdmission?.();
      if (options.refused === true)
        return {
          kind: "refused",
          code: "stopping",
          message: "Conversation is stopping",
        };
      return {
        kind: "accepted",
        cause: "input-1",
        settled: Promise.resolve({
          status: "succeeded",
          conversationId: ID,
          finalText: "done",
          structuredOutput: null,
          outputIssue: null,
          openQuestionId: null,
          failure: null,
        }),
      };
    },
    admission: async () => null,
    adoptBackend: async () => {},
    clearPendingPromptText:
      fixture.store.clearConversationPendingPromptTextIfMatches,
    async dispatchCommand() {
      throw new Error("This is an ordinary prompt");
    },
    commandRefusal: async () => null,
    admitCommandModel: async ({ selection }) => ({ ok: true, selection }),
    log: createCapturingLogger(),
  };
  const response = await promptCoreConversation(deps, {
    projectPath: PROJECT,
    target: sessionConversationTarget("repo", SESSION, ID),
    conversation,
    body: runPromptRequestSchema.parse({
      prompt: RAW.trim(),
      submittedPendingPromptText: RAW,
    }),
  });
  await response.text();
  return response;
}

async function reloadedDraft() {
  return (await fixture.recreateStore().getConversation(PROJECT, SESSION, ID))
    ?.pendingPromptText;
}

describe("core prompt draft ownership", () => {
  it("clears the exact submitted raw draft after admission", async () => {
    expect((await prompt()).status).toBe(200);
    expect(await reloadedDraft()).toBeNull();
  });
  it("preserves a newer draft written before admission", async () => {
    await prompt({
      beforeAdmission: () =>
        fixture.store.setConversationPendingPromptText(
          PROJECT,
          SESSION,
          ID,
          "newer draft",
        ),
    });
    expect(await reloadedDraft()).toBe("newer draft");
  });
  it("preserves the submitted draft when the core refuses admission", async () => {
    expect((await prompt({ refused: true })).status).toBe(503);
    expect(await reloadedDraft()).toBe(RAW);
  });
});
