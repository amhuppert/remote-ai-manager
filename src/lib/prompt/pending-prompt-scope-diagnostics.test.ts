/**
 * What the pending-prompt pair EMITS about the conversation it wrote.
 *
 * Structured-log fields are a public identity surface (R1.3), and the draft
 * handler is now project-reachable, so its diagnostics are asserted in both
 * directions: the internal session sentinel never appears at project scope, and
 * the real session name is still reported at session scope — the fix has to
 * remove the sentinel, not the diagnostic.
 */

import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import {
  createPendingPromptRouteHandlers,
  createProjectPendingPromptRouteHandlers,
} from "./route-handlers";

const PROJECT_PATH = "/repos/cc";
const CONVERSATION_ID = "conv-1";

const conversation = conversationStateSchema.parse({
  id: CONVERSATION_ID,
  status: "idle",
  transcriptPath: null,
  promptCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  lastActivityAt: "2026-01-01T00:00:00Z",
  agentBackend: "claude",
});

function draftRequest(): Request {
  return new Request("http://localhost/pending-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "a draft" }),
  });
}

describe("pending-prompt diagnostics carry scope, not a storage key", () => {
  it("reports project scope with no session field", async () => {
    const log = createCapturingLogger();
    const writes: string[] = [];
    const handlers = createProjectPendingPromptRouteHandlers({
      resolveProjectPath: async () => PROJECT_PATH,
      getProjectConversation: async () => conversation,
      setConversationPendingPromptText: async (_p, storeSessionName) => {
        // The store IS keyed by the sentinel — that is the internal adapter
        // boundary the diagnostics must not follow it across.
        writes.push(storeSessionName);
      },
      clearConversationPendingPromptTextIfMatches: async () => true,
      log,
    });

    const response = await handlers.POST(draftRequest(), {
      params: Promise.resolve({
        name: "cc",
        conversationId: CONVERSATION_ID,
      }),
    });

    expect(response.status).toBe(200);
    expect(writes).toEqual([PROJECT_CONVERSATION_SESSION_SENTINEL]);
    expect(log.entries.map((e) => e.message)).toContain(
      "pending_prompt.update_completed",
    );
    expect(log.allFieldValues()).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    for (const entry of log.entries) {
      expect(entry.fields).not.toHaveProperty("sessionName");
      expect(entry.fields["scope"]).toBe("project");
    }
  });

  it("still reports the real session name at session scope", async () => {
    const log = createCapturingLogger();
    const handlers = createPendingPromptRouteHandlers({
      resolveProjectPath: async () => PROJECT_PATH,
      getSession: async () =>
        sessionStateSchema.parse({
          sessionName: "feature-x",
          worktreePath: `${PROJECT_PATH}/.worktrees/feature-x`,
          branchName: "csm/feature-x",
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-01T00:00:00Z",
          conversations: [conversation],
        }),
      setConversationPendingPromptText: async () => {},
      clearConversationPendingPromptTextIfMatches: async () => true,
      log,
    });

    await handlers.POST(draftRequest(), {
      params: Promise.resolve({
        name: "cc",
        session: "feature-x",
        conversationId: CONVERSATION_ID,
      }),
    });

    const completed = log.entries.find(
      (e) => e.message === "pending_prompt.update_completed",
    );
    expect(completed?.fields).toMatchObject({
      scope: "session",
      sessionName: "feature-x",
      conversationId: CONVERSATION_ID,
    });
  });
});
