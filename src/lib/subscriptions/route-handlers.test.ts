import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  createSubscriptionRouteHandlers,
  type SubscriptionRouteDeps,
} from "./route-handlers";

const projectPath = "/repos/subscription-tests";
const fixtures: PersistenceFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function fixture(
  scope: "session" | "project",
  role: "iteration" | null = null,
) {
  const persistence = createPersistenceFixture();
  fixtures.push(persistence);
  persistence.seedProject(projectPath);
  persistence.seedSession(projectPath, "session-one");
  const conversation = makeConversationState({
    id: "conversation-one",
    scope,
    role,
  });
  if (scope === "session")
    await persistence.seedConversation(
      projectPath,
      "session-one",
      conversation,
    );
  else await persistence.seedProjectConversation(projectPath, conversation);
  const context = {
    params: Promise.resolve({
      name: "project-one",
      session: "session-one",
      conversationId: conversation.id,
    }),
  };
  const recipients: Array<{ projectPath: string; conversationId: string }> = [];
  const deps: SubscriptionRouteDeps = {
    resolveProjectPath: async (name) =>
      name === "project-one" ? projectPath : null,
    getSession: (project, session) =>
      persistence.store.getSession(project, session),
    getProjectConversation: (project, id) =>
      persistence.store.getProjectConversation(project, id),
    auth: {
      async validateOptionalToken(request) {
        return request.headers.has("authorization")
          ? { kind: "valid" }
          : { kind: "absent" };
      },
    },
    getService: () => ({
      async list(recipient) {
        recipients.push(recipient);
        return [];
      },
      async unfollow() {
        return null;
      },
      async readInbox(recipient, query) {
        recipients.push(recipient);
        return {
          items: [],
          total: 0,
          limit: query.limit ?? 20,
          offset: query.offset ?? 0,
        };
      },
      async getDelivery() {
        return null;
      },
    }),
  };
  return {
    context,
    recipients,
    deps,
    handlers: createSubscriptionRouteHandlers(deps, scope),
  };
}

describe("subscription HTTP boundary", () => {
  it.each(["session", "project"] as const)(
    "serves the %s conversation without starting or acknowledging a turn",
    async (scope) => {
      const test = await fixture(scope);
      const response = await test.handlers.inboxGET(
        new Request("http://test/inbox?limit=5&offset=3&all=true"),
        test.context,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        deliveries: [],
        total: 0,
        limit: 5,
        offset: 3,
      });
      expect(test.recipients).toEqual([
        { projectPath, conversationId: "conversation-one" },
      ]);
    },
  );

  it("refuses a missing scoped recipient rather than falling through to another conversation", async () => {
    const test = await fixture("project");
    const response = await test.handlers.listGET(
      new Request("http://test/subscriptions"),
      {
        params: Promise.resolve({
          name: "project-one",
          conversationId: "missing",
        }),
      },
    );
    expect(response.status).toBe(404);
    expect(test.recipients).toHaveLength(0);
  });

  it("refuses a workflow lane without creating automatic follows", async () => {
    const test = await fixture("session", "iteration");
    const response = await test.handlers.inboxGET(
      new Request("http://test/inbox"),
      test.context,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "SUBSCRIPTIONS_ORDINARY_ONLY",
    });
    expect(test.recipients).toHaveLength(0);
  });

  it("rejects malformed pagination before reading sources", async () => {
    const test = await fixture("project");
    const response = await test.handlers.inboxGET(
      new Request("http://test/inbox?limit=0&all=perhaps"),
      test.context,
    );
    expect(response.status).toBe(400);
    expect(test.recipients).toHaveLength(0);
  });

  it("requires an authenticated agent's attribution to match the addressed recipient", async () => {
    const test = await fixture("project");
    const response = await test.handlers.unfollowDELETE(
      new Request("http://test/subscriptions/other", {
        method: "DELETE",
        headers: {
          authorization: "Bearer token",
          "x-cc-conversation-id": "other-conversation",
        },
      }),
      test.context,
    );
    expect(response.status).toBe(403);
    expect(test.recipients).toHaveLength(0);
  });
});
