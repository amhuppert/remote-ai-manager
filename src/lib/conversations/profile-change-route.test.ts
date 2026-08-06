/**
 * R6.5 over HTTP: the profile-change endpoint refuses a settled conversation.
 *
 * The domain operation's own suite proves the rule against real SQLite; this
 * one proves the rule is REACHABLE — that the refusal a caller gets is the
 * standard post-lock error, mapped to a conflict rather than swallowed into a
 * 500, and that the success body carries only the redacted snapshot.
 */

import { describe, expect, it } from "vitest";
import {
  createConversationRouteHandlers,
  type ConversationRouteDeps,
} from "./lifecycle-route-handlers";
import { ConversationProfileLockedError } from "./conversation-profile";
import { UnknownAgentProfileError } from "./profile-change";
import {
  PROFILE_SECRET_SENTINEL,
  REDACTED_SNAPSHOT_FIXTURE,
  SNAPSHOT_FIXTURE,
  buildProfiledConversation,
} from "./testing/profile-snapshot-fixtures";
import { redactAgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import { conversationProfileChangedEventSchema } from "./schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";

const PROJECT_NAME = "demo";
const SESSION_NAME = "feature-x";
const CONVERSATION_ID = "conv-1";

function context() {
  return {
    params: Promise.resolve({
      name: PROJECT_NAME,
      session: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    }),
  };
}

function patch(body: unknown): Request {
  return new Request("http://test/", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function handlers(
  changeConversationProfile: ConversationRouteDeps["changeConversationProfile"],
) {
  const conversation = buildProfiledConversation({ id: CONVERSATION_ID });
  const broadcasts: SSEEvent[] = [];
  const deps: ConversationRouteDeps = {
    resolveProjectPath: async () => "/repo",
    getProjectDisplayName: () => PROJECT_NAME,
    getSession: async () =>
      sessionStateSchema.parse({
        sessionName: SESSION_NAME,
        worktreePath: `/repo/.worktrees/${SESSION_NAME}`,
        branchName: `csm/${SESSION_NAME}`,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        conversations: [conversation],
      }),
    createConversation: async () => conversation,
    renameConversation: async () => {},
    resolveConversationNamingContent: async () => null,
    resolveMessageNamingContent: async () => null,
    generateAndApplyConversationName: async () => null,
    setConversationArchived: async () => {},
    changeConversationProfile,
    broadcast: (event) => {
      broadcasts.push(event);
      return { delivered: true };
    },
  };
  return { ...createConversationRouteHandlers(deps), broadcasts };
}

describe("PATCH conversation profile", () => {
  it("answers a settled profile with 409 and the standard error", async () => {
    const { PATCH_PROFILE } = handlers(async () => {
      throw new ConversationProfileLockedError(CONVERSATION_ID, "legacy");
    });

    const response = await PATCH_PROFILE(
      patch({ profile: "builtin:standard-agent" }),
      context(),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain(
      "predates the agent profile library and has no profile to change",
    );
  });

  it("answers a locked conversation with the same conflict", async () => {
    const { PATCH_PROFILE } = handlers(async () => {
      throw new ConversationProfileLockedError(CONVERSATION_ID, "locked");
    });

    const response = await PATCH_PROFILE(
      patch({ profile: "builtin:standard-agent" }),
      context(),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("already run a turn");
  });

  it("normalizes the tier:id shorthand before resolving", async () => {
    const seen: AgentProfileRef[] = [];
    const { PATCH_PROFILE } = handlers(async (_identity, ref) => {
      seen.push(ref);
      return redactAgentProfileSnapshot(SNAPSHOT_FIXTURE);
    });

    const response = await PATCH_PROFILE(
      patch({ profile: "project:security-reviewer" }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ tier: "project", id: "security-reviewer" }]);

    // The change response is a read surface: redacted identity, no instructions.
    const raw = await response.text();
    expect(raw).not.toContain(PROFILE_SECRET_SENTINEL);
    expect(raw).not.toContain("renderedInstructionBlock");
    expect(raw).toContain(REDACTED_SNAPSHOT_FIXTURE.resolvedInstructionHash);
  });

  it("refuses an unqualified reference rather than guessing a tier", async () => {
    const { PATCH_PROFILE } = handlers(async () =>
      redactAgentProfileSnapshot(SNAPSHOT_FIXTURE),
    );

    const response = await PATCH_PROFILE(
      patch({ profile: "security-reviewer" }),
      context(),
    );

    expect(response.status).toBe(400);
  });

  it("publishes a conversation-scoped profile-changed event carrying only the redacted snapshot", async () => {
    const { PATCH_PROFILE, broadcasts } = handlers(async () =>
      redactAgentProfileSnapshot(SNAPSHOT_FIXTURE),
    );

    const response = await PATCH_PROFILE(
      patch({ profile: "project:security-reviewer" }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(broadcasts).toHaveLength(1);
    const parsed = conversationProfileChangedEventSchema.safeParse(
      broadcasts[0],
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.scope === "session") {
      expect(parsed.data.conversationId).toBe(CONVERSATION_ID);
      expect(parsed.data.sessionName).toBe(SESSION_NAME);
      expect(parsed.data.redactedProfileSnapshot).toEqual(
        REDACTED_SNAPSHOT_FIXTURE,
      );
    }
    // An SSE frame is a read surface like any response body (R6.3).
    expect(JSON.stringify(broadcasts[0])).not.toContain(
      PROFILE_SECRET_SENTINEL,
    );
  });

  it("publishes nothing when the change is refused", async () => {
    const { PATCH_PROFILE, broadcasts } = handlers(async () => {
      throw new ConversationProfileLockedError(CONVERSATION_ID, "locked");
    });

    await PATCH_PROFILE(
      patch({ profile: "builtin:standard-agent" }),
      context(),
    );

    expect(broadcasts).toEqual([]);
  });

  it("reports an unknown profile as 404, not a refusal", async () => {
    const { PATCH_PROFILE } = handlers(async (_identity, ref) => {
      throw new UnknownAgentProfileError(ref);
    });

    const response = await PATCH_PROFILE(
      patch({ profile: "builtin:no-such-profile" }),
      context(),
    );

    expect(response.status).toBe(404);
  });
});
