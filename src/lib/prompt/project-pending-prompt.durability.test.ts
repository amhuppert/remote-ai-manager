/**
 * A project conversation's draft, proved durable through the real store.
 *
 * The claim R3.3 makes is that a draft survives a page reload, and a reload
 * reads the conversation back out of SQLite. A JS-object fake could not show
 * the sentinel-aware store path routes a session-less conversation to the
 * project repository, so this drives the real project pending-prompt route
 * handler against a real store and reloads through the repository.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { createProjectPendingPromptRouteHandlers } from "./route-handlers";

const PROJECT_PATH = "/repo-drafts";
const PROJECT_NAME = "repo-drafts";
const CONVERSATION_ID = "plc-draft-1";

let fixture: PersistenceFixture;
let handlers: ReturnType<typeof createProjectPendingPromptRouteHandlers>;

function routeContext(conversationId = CONVERSATION_ID) {
  return {
    params: Promise.resolve({
      name: PROJECT_NAME,
      conversationId,
    }),
  };
}

function postBody(body: unknown): Request {
  return new Request(
    `http://localhost/api/projects/${PROJECT_NAME}/conversations/${CONVERSATION_ID}/pending-prompt`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

async function reloadedPendingPromptText(): Promise<string | null | undefined> {
  const reloaded = await fixture.store.getProjectConversation(
    PROJECT_PATH,
    CONVERSATION_ID,
  );
  return reloaded?.pendingPromptText;
}

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  await fixture.seedProjectConversation(
    PROJECT_PATH,
    conversationStateSchema.parse({
      id: CONVERSATION_ID,
      scope: "project",
      status: "idle",
      transcriptPath: null,
      promptCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
      agentBackend: "claude",
    }),
  );
  handlers = createProjectPendingPromptRouteHandlers({
    resolveProjectPath: async () => PROJECT_PATH,
    getProjectConversation: fixture.store.getProjectConversation,
    setConversationPendingPromptText:
      fixture.store.setConversationPendingPromptText,
    clearConversationPendingPromptTextIfMatches:
      fixture.store.clearConversationPendingPromptTextIfMatches,
    log: createCapturingLogger(),
  });
});

afterEach(() => {
  fixture.close();
});

describe("project conversation draft durability (R3.3)", () => {
  it("persists a draft that a reload reads back from the project repository", async () => {
    const response = await handlers.POST(
      postBody({ text: "written before reload" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    // Reloaded through the repository, not read back from the response.
    expect(await reloadedPendingPromptText()).toBe("written before reload");
  });

  it("clears the draft it persisted", async () => {
    await handlers.POST(postBody({ text: "a false start" }), routeContext());

    await handlers.POST(postBody({ text: null }), routeContext());

    expect(await reloadedPendingPromptText()).toBeNull();
  });

  it("clears on submit only while the persisted draft is the submitted one", async () => {
    await handlers.POST(postBody({ text: "submitted draft" }), routeContext());

    // The user kept typing after the submit-clear was issued; the compare
    // guard is what keeps that newer draft from being discarded.
    await handlers.POST(postBody({ text: "typed afterwards" }), routeContext());
    const stale = await handlers.POST(
      postBody({ text: null, expectedText: "submitted draft" }),
      routeContext(),
    );

    expect(await stale.json()).toEqual({ ok: true, updated: false });
    expect(await reloadedPendingPromptText()).toBe("typed afterwards");
  });

  it("404s an unknown project conversation instead of writing", async () => {
    const response = await handlers.POST(
      postBody({ text: "no such conversation" }),
      routeContext("plc-missing"),
    );

    expect(response.status).toBe(404);
    expect(await reloadedPendingPromptText()).toBeNull();
  });
});
