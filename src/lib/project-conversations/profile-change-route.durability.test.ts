/**
 * R6.5 at PROJECT scope: the refusal a legacy project conversation produces
 * through a production control.
 *
 * A project conversation has no session to hang a route off, so the session
 * PATCH proves nothing about it. This drives the project router's own profile
 * endpoint into the real change operation against real SQLite, so the refusal,
 * the non-backfill, and the redacted success body are claims about the row the
 * project repository actually stores.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createProjectConversationRouteHandlers,
  type ProjectConversationRouteDeps,
} from "./route-handlers";
import { changeConversationProfile } from "@/lib/conversations/profile-change";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  PROFILE_SECRET_SENTINEL,
  buildProfiledConversation,
  buildStoredConversation,
} from "@/lib/conversations/testing/profile-snapshot-fixtures";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import { conversationProfileChangedEventSchema } from "@/lib/conversations/schemas";
import type { ResolvedAgentProfile } from "@/lib/agent-profiles/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";

const PROJECT_PATH = "/repo-plc-profile";
const PROJECT_NAME = "demo";

const REPLACEMENT_INSTRUCTIONS = "Work as a performance specialist.";
const REPLACEMENT: ResolvedAgentProfile = {
  tier: "builtin",
  id: "performance-specialist",
  name: "Performance specialist",
  revision: 1,
  sourceContentHash: computeContentHash(REPLACEMENT_INSTRUCTIONS),
  instructions: REPLACEMENT_INSTRUCTIONS,
};

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
});

afterEach(() => {
  fixture.close();
});

/** Not reachable from the profile route; a call would be a routing defect. */
function unused(): never {
  throw new Error("not used by the profile route");
}

function handlers() {
  const broadcasts: SSEEvent[] = [];
  const deps: ProjectConversationRouteDeps = {
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    getProjectDisplayName: () => PROJECT_NAME,
    getProjectConversation: (projectPath, id) =>
      fixture.store.getProjectConversation(projectPath, id),
    createProjectConversation: unused,
    listProjectConversations: unused,
    readConversationMessagesWithSeq: unused,
    renameProjectConversation: unused,
    resolveConversationNamingContent: unused,
    resolveMessageNamingContent: unused,
    generateAndApplyConversationName: unused,
    setProjectConversationArchived: unused,
    setProjectConversationOpen: unused,
    markProjectConversationRead: unused,
    executeProjectPromptStream: unused,
    isConversationBusy: unused,
    // The production change operation, bound to the real store. Its session
    // argument is the project sentinel, which is how a session-keyed store API
    // addresses the project repository.
    changeConversationProfile: (identity, ref) =>
      changeConversationProfile(
        {
          getConversation: (projectPath, sessionName, conversationId) =>
            fixture.store.getConversation(
              projectPath,
              sessionName,
              conversationId,
            ),
          mutateConversation: (
            projectPath,
            sessionName,
            conversationId,
            label,
            mutate,
          ) =>
            fixture.store.mutateConversation(
              projectPath,
              sessionName,
              conversationId,
              label,
              mutate,
            ),
          resolveProfile: async (_projectPath, candidate) =>
            candidate.id === REPLACEMENT.id ? REPLACEMENT : null,
        },
        identity,
        ref,
      ),
    broadcast: (event) => {
      broadcasts.push(event);
      return { delivered: true };
    },
  };
  return { ...createProjectConversationRouteHandlers(deps), broadcasts };
}

function context(conversationId: string) {
  return {
    params: Promise.resolve({ name: PROJECT_NAME, conversationId }),
  };
}

function patch(body: unknown): Request {
  return new Request("http://test/", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function reload(conversationId: string) {
  const restarted = fixture.recreateStore();
  return await restarted.getProjectConversation(PROJECT_PATH, conversationId);
}

describe("PATCH project conversation profile", () => {
  it("refuses a legacy project conversation with the standard post-lock error", async () => {
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      buildStoredConversation({ id: "plc-legacy", scope: "project" }),
    );

    const response = await handlers().profilePATCH(
      patch({ profile: `builtin:${REPLACEMENT.id}` }),
      context("plc-legacy"),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain(
      "predates the agent profile library and has no profile to change",
    );

    // The refused attempt must not backfill the row it refused (D18).
    const reloaded = await reload("plc-legacy");
    expect(reloaded?.profileSnapshot).toBeNull();
    expect(reloaded?.profileLockedAt).toBeNull();
  });

  it("refuses a project conversation that has already run a turn", async () => {
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      buildProfiledConversation({ id: "plc-locked", scope: "project" }),
    );

    const response = await handlers().profilePATCH(
      patch({ profile: `builtin:${REPLACEMENT.id}` }),
      context("plc-locked"),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("already run a turn");
  });

  it("swaps an unlocked project conversation and answers redacted", async () => {
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      buildProfiledConversation({
        id: "plc-unlocked",
        scope: "project",
        profileLockedAt: null,
      }),
    );

    const h = handlers();
    const response = await h.profilePATCH(
      patch({ profile: `builtin:${REPLACEMENT.id}` }),
      context("plc-unlocked"),
    );

    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(PROFILE_SECRET_SENTINEL);
    expect(raw).not.toContain("renderedInstructionBlock");
    expect(raw).toContain(REPLACEMENT.sourceContentHash);

    const reloaded = await reload("plc-unlocked");
    expect(reloaded?.profileSnapshot?.id).toBe(REPLACEMENT.id);

    // The project scope publishes the same conversation-scoped update the
    // session scope does, with no session name to carry.
    const parsed = conversationProfileChangedEventSchema.safeParse(
      h.broadcasts[0],
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.scope === "project") {
      expect(parsed.data.projectName).toBe(PROJECT_NAME);
      expect(parsed.data.conversationId).toBe("plc-unlocked");
      expect(parsed.data.redactedProfileSnapshot.id).toBe(REPLACEMENT.id);
    }
    expect(JSON.stringify(h.broadcasts)).not.toContain(PROFILE_SECRET_SENTINEL);
  });

  it("publishes nothing when a refused change leaves the row untouched", async () => {
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      buildProfiledConversation({ id: "plc-no-event", scope: "project" }),
    );

    const h = handlers();
    await h.profilePATCH(
      patch({ profile: `builtin:${REPLACEMENT.id}` }),
      context("plc-no-event"),
    );

    expect(h.broadcasts).toEqual([]);
  });

  it("reports an unknown profile as a miss, not a refusal", async () => {
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      buildProfiledConversation({
        id: "plc-unknown-ref",
        scope: "project",
        profileLockedAt: null,
      }),
    );

    const response = await handlers().profilePATCH(
      patch({ profile: "builtin:no-such-profile" }),
      context("plc-unknown-ref"),
    );

    expect(response.status).toBe(404);
  });

  it("404s an id the project does not have", async () => {
    const response = await handlers().profilePATCH(
      patch({ profile: `builtin:${REPLACEMENT.id}` }),
      context("plc-missing"),
    );

    expect(response.status).toBe(404);
  });

  it("addresses the project repository through the sentinel session", async () => {
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      buildProfiledConversation({
        id: "plc-sentinel",
        scope: "project",
        profileLockedAt: null,
      }),
    );

    await handlers().profilePATCH(
      patch({ profile: `builtin:${REPLACEMENT.id}` }),
      context("plc-sentinel"),
    );

    // Same row, read back through the session-keyed API with the sentinel: the
    // route wrote to the project repository and not to a session of that name.
    const viaSentinel = await fixture
      .recreateStore()
      .getConversation(
        PROJECT_PATH,
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        "plc-sentinel",
      );
    expect(viaSentinel?.profileSnapshot?.id).toBe(REPLACEMENT.id);
  });
});
