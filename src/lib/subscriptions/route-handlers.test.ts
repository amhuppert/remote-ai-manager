import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type {
  ActiveSubscriptionWait,
  RegisterActiveWaitInput,
} from "./active-wait-schemas";
import {
  ActiveWaitConflictError,
  ActiveWaitRegistrationError,
} from "./active-wait-service";
import {
  createSubscriptionRouteHandlers,
  type SubscriptionRouteDeps,
} from "./route-handlers";

const projectPath = "/repos/subscription-tests";
const fixtures: PersistenceFixture[] = [];
const wait: ActiveSubscriptionWait = {
  id: "wait-one",
  subscriptionId: "subscription-one",
  recipient: { projectPath, conversationId: "conversation-one" },
  source: { kind: "workflow", id: "run-one" },
  reason: "Continue after completion",
  expiresAt: "2026-10-01T00:00:00.000Z",
  state: "waiting",
  outcome: null,
  deliveryId: null,
  batchId: null,
  causationBatchIds: [],
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  finishedAt: null,
  lastError: null,
};
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
  const registrations: Array<
    Omit<RegisterActiveWaitInput, "causationBatchIds">
  > = [];
  const deps: SubscriptionRouteDeps = {
    now: () => "2026-09-30T00:00:00.000Z",
    getWaitService: () => ({
      async register(input) {
        registrations.push(input);
        return { ...wait, ...input };
      },
      async list(recipient) {
        recipients.push(recipient);
        return [
          wait,
          { ...wait, id: "wait-two", subscriptionId: "subscription-two" },
        ];
      },
      async get(recipient, id) {
        recipients.push(recipient);
        return id === wait.subscriptionId ? wait : null;
      },
      async getBatch() {
        return null;
      },
      async cancel() {
        return null;
      },
    }),
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
      async listRecorded() {
        return [];
      },
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
    registrations,
    deps,
    handlers: createSubscriptionRouteHandlers(deps, scope),
  };
}

describe("subscription HTTP boundary", () => {
  it.each(["session", "project"] as const)(
    "registers a %s terminal wait with a finite default lifetime",
    async (scope) => {
      const test = await fixture(scope);
      const response = await test.handlers.waitPOST(
        new Request("http://test/subscriptions/waits", {
          method: "POST",
          headers: {
            authorization: "Bearer token",
            "x-cc-conversation-id": "conversation-one",
          },
          body: JSON.stringify({ source: wait.source, reason: wait.reason }),
        }),
        test.context,
      );
      expect(response.status).toBe(201);
      expect(test.registrations).toEqual([
        {
          recipient: wait.recipient,
          source: wait.source,
          reason: wait.reason,
          expiresAt: "2026-10-01T00:00:00.000Z",
        },
      ]);
      expect(await response.json()).toEqual({ wait });
    },
  );

  it("translates a bounded lifetime from seconds rather than accepting caller causation", async () => {
    const test = await fixture("project");
    const response = await test.handlers.waitPOST(
      new Request("http://test/subscriptions/waits", {
        method: "POST",
        body: JSON.stringify({
          source: { kind: "validation", id: "validation-one" },
          reason: "Results",
          expiresIn: 120,
        }),
      }),
      test.context,
    );
    expect(response.status).toBe(201);
    expect(test.registrations[0]?.expiresAt).toBe("2026-09-30T00:02:00.000Z");
    for (const body of [
      { source: wait.source, reason: "Results", expiresIn: 0 },
      { source: wait.source, reason: "Results", expiresIn: 604801 },
      { source: wait.source, reason: "Results", expiresIn: 1.5 },
      {
        source: wait.source,
        reason: "Results",
        causationBatchIds: ["invented"],
      },
      { source: { kind: "notepad", id: "notes" }, reason: "Results" },
      { source: wait.source, reason: "   " },
      { source: wait.source, reason: "Results", predicate: { status: "done" } },
    ]) {
      const invalid = await test.handlers.waitPOST(
        new Request("http://test/subscriptions/waits", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        test.context,
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        code: "INVALID_ACTIVE_WAIT",
      });
    }
    expect(test.registrations).toHaveLength(1);
  });

  it("enforces the same recipient and ordinary-role policy for wait registration", async () => {
    const test = await fixture("project");
    const mismatched = await test.handlers.waitPOST(
      new Request("http://test/subscriptions/waits", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "x-cc-conversation-id": "someone-else",
        },
        body: JSON.stringify({ source: wait.source, reason: wait.reason }),
      }),
      test.context,
    );
    expect(mismatched.status).toBe(403);
    expect(test.registrations).toHaveLength(0);
    const lane = await fixture("session", "iteration");
    const refused = await lane.handlers.waitPOST(
      new Request("http://test/subscriptions/waits", {
        method: "POST",
        body: JSON.stringify({ source: wait.source, reason: wait.reason }),
      }),
      lane.context,
    );
    expect(refused.status).toBe(409);
    expect(lane.registrations).toHaveLength(0);
  });

  it("pages waits and resolves the detail by subscription id within the recipient", async () => {
    const test = await fixture("project");
    const response = await test.handlers.waitsGET(
      new Request("http://test/subscriptions/waits?limit=1&offset=1"),
      test.context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      waits: [{ ...wait, id: "wait-two", subscriptionId: "subscription-two" }],
      total: 2,
      limit: 1,
      offset: 1,
    });
    const detail = await test.handlers.waitGET(
      new Request("http://test/subscriptions/waits/subscription-one"),
      {
        params: Promise.resolve({
          name: "project-one",
          conversationId: "conversation-one",
          subscriptionId: wait.subscriptionId,
        }),
      },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({ wait, batch: null });
    const missing = await test.handlers.waitGET(
      new Request("http://test/subscriptions/waits/missing"),
      {
        params: Promise.resolve({
          name: "project-one",
          conversationId: "conversation-one",
          subscriptionId: "missing",
        }),
      },
    );
    expect(missing.status).toBe(404);
    expect(
      test.recipients.every(
        (recipient) =>
          recipient.projectPath === projectPath &&
          recipient.conversationId === "conversation-one",
      ),
    ).toBe(true);
  });

  it("refuses to silently unfollow a queued or unresolved wake", async () => {
    const test = await fixture("project");
    const waits = test.deps.getWaitService();
    const subscriptions = test.deps.getService();
    let unfollowed = false;
    test.deps.getWaitService = () => ({
      ...waits,
      async cancel() {
        throw new ActiveWaitConflictError();
      },
    });
    test.deps.getService = () => ({
      ...subscriptions,
      async unfollow() {
        unfollowed = true;
        return null;
      },
    });
    const response = await test.handlers.unfollowDELETE(
      new Request("http://test/subscriptions/subscription-one", {
        method: "DELETE",
      }),
      {
        params: Promise.resolve({
          name: "project-one",
          conversationId: "conversation-one",
          subscriptionId: wait.subscriptionId,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED",
    });
    expect(unfollowed).toBe(false);
  });

  it("returns the saved opt-out receipt after active wait cancellation", async () => {
    const test = await fixture("project");
    const waits = test.deps.getWaitService();
    const subscriptions = test.deps.getService();
    const subscription = {
      id: wait.subscriptionId,
      recipient: wait.recipient,
      source: wait.source,
      reason: wait.reason,
      mode: "active" as const,
      eventKinds: null,
      expiresAt: wait.expiresAt,
      status: "unfollowed" as const,
      cursor: null,
      createdAt: wait.createdAt,
      updatedAt: wait.updatedAt,
      unfollowedAt: wait.updatedAt,
      missingAt: null,
      lastError: null,
    };
    test.deps.getWaitService = () => ({
      ...waits,
      async cancel() {
        return { ...wait, state: "cancelled", finishedAt: wait.updatedAt };
      },
    });
    test.deps.getService = () => ({
      ...subscriptions,
      async listRecorded() {
        return [subscription];
      },
      async unfollow() {
        throw new Error("Cancellation already owns the opt-out mutation");
      },
    });
    const response = await test.handlers.unfollowDELETE(
      new Request("http://test/subscriptions/subscription-one", {
        method: "DELETE",
      }),
      {
        params: Promise.resolve({
          name: "project-one",
          conversationId: "conversation-one",
          subscriptionId: wait.subscriptionId,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subscription });
  });

  it("preserves a typed registration refusal and rejects malformed JSON", async () => {
    const test = await fixture("project");
    const waits = test.deps.getWaitService();
    test.deps.getWaitService = () => ({
      ...waits,
      async register() {
        throw new ActiveWaitRegistrationError(
          "ACTIVE_WAIT_RECIPIENT_INELIGIBLE",
          "The conversation is no longer eligible",
          409,
        );
      },
    });
    const response = await test.handlers.waitPOST(
      new Request("http://test/subscriptions/waits", {
        method: "POST",
        body: JSON.stringify({ source: wait.source, reason: wait.reason }),
      }),
      test.context,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "ACTIVE_WAIT_RECIPIENT_INELIGIBLE",
      error: "The conversation is no longer eligible",
    });
    const malformed = await test.handlers.waitPOST(
      new Request("http://test/subscriptions/waits", {
        method: "POST",
        body: "{",
      }),
      test.context,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      code: "INVALID_ACTIVE_WAIT",
    });
  });

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
