import { describe, expect, it } from "vitest";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import { createCommandCenterCli } from "../../framework/application";
import type { CliHost, FetchInit } from "../../transport";

const projectEnv = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: "token",
  CC_PROJECT: "project-one",
  CC_CONVERSATION_ID: "conversation-one",
  CC_CONVERSATION_SCOPE: "project",
  CC_SESSION: "",
};

const pendingDelivery = {
  id: "delivery-one",
  subscriptionId: "subscription-one",
  recipient: {
    projectPath: "/repos/project-one",
    conversationId: "conversation-one",
  },
  source: { kind: "notepad", id: "notepad-one" },
  fact: {
    occurrenceId: "revision:2",
    eventKind: "notepad.revised",
    category: "revision",
    sourceTitle: "Decisions",
    summary: "Use the new API",
    occurredAt: "2026-09-30T01:00:00Z",
    revision: "2",
    outcome: null,
    retrievalHandle: "cctl notepad get notepad-one",
    actorConversationId: null,
  },
  recordedAt: "2026-09-30T01:00:00Z",
  state: "pending",
  attemptId: null,
  attemptCount: 0,
  queuedAt: null,
  acceptedAt: null,
  finishedAt: null,
  lastError: null,
};

function fixture(response: unknown, env = projectEnv) {
  const requests: Array<{ url: string; init: FetchInit }> = [];
  const host: CliHost = {
    async fetch(url, init) {
      requests.push({ url, init });
      return Response.json(response);
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
  return {
    requests,
    run: (argv: string[], format: "json" | "text" = "json") =>
      runForTest(createCommandCenterCli(host), argv, {
        host: createTestHost(),
        env,
        format,
      }),
  };
}

describe("conversation subscription commands", () => {
  it("reads a project conversation's inbox without acknowledging it", async () => {
    const test = fixture({ deliveries: [], total: 0, limit: 20, offset: 0 });
    const result = await test.run(["inbox", "list"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/conversations/conversation-one/inbox?limit=20&offset=0",
    );
    expect(test.requests[0]?.init.method).toBe("GET");
    expect(test.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-one",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "read",
      payload: { data: { deliveries: [] } },
    });
  });

  it("uses the session route for a session conversation and retains paging filters", async () => {
    const test = fixture(
      { deliveries: [], total: 0, limit: 5, offset: 10 },
      {
        ...projectEnv,
        CC_CONVERSATION_SCOPE: "session",
        CC_SESSION: "session-one",
      },
    );
    const result = await test.run([
      "inbox",
      "list",
      "--limit",
      "5",
      "--offset",
      "10",
      "--all",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/sessions/session-one/conversations/conversation-one/inbox?limit=5&offset=10&all=true",
    );
  });

  it("lists remembered follows including opt-outs with bounded output", async () => {
    const test = fixture({ subscriptions: [], total: 0, limit: 20, offset: 0 });
    const result = await test.run(["subscription", "list"], "text");
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/conversations/conversation-one/subscriptions?limit=20&offset=0",
    );
    expect(result.stdout).toContain("0 total");
  });

  it("preserves the addressed conversation in pagination and item retrieval commands", async () => {
    const test = fixture({
      deliveries: [pendingDelivery],
      total: 2,
      limit: 1,
      offset: 0,
    });
    const result = await test.run(["inbox", "list", "--limit", "1", "--all"]);
    expect(result.exitCode, result.stdout).toBe(0);
    const data = JSON.parse(result.stdout).payload.data;
    expect(data.next).toContain("--offset=1");
    expect(data.next).toContain("--all");
    expect(data.deliveries[0].getCommand).toContain("inbox get");
    expect(data.deliveries[0].getCommand).toContain("delivery-one");
    expect(data.deliveries[0].getCommand).toContain("--project=project-one");
    expect(data.deliveries[0].getCommand).toContain(
      "--conversation=conversation-one",
    );
  });

  it("persists an unfollow with an inspectable mutation receipt", async () => {
    const subscription = {
      id: "subscription-one",
      recipient: {
        projectPath: "/repos/project-one",
        conversationId: "conversation-one",
      },
      source: { kind: "notepad", id: "notepad-one" },
      reason: "Supplied as context",
      mode: "passive",
      eventKinds: null,
      expiresAt: null,
      status: "unfollowed",
      cursor: "revision:2",
      createdAt: "2026-09-30T00:00:00Z",
      updatedAt: "2026-09-30T01:00:00Z",
      unfollowedAt: "2026-09-30T01:00:00Z",
      missingAt: null,
      lastError: null,
    };
    const test = fixture({ subscription });
    const result = await test.run([
      "subscription",
      "unfollow",
      subscription.id,
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.init.method).toBe("DELETE");
    expect(test.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-one",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { subscription } },
    });
  });

  it("reports a malformed unfollow acknowledgement as unknown", async () => {
    const test = fixture({});
    const result = await test.run([
      "subscription",
      "unfollow",
      "subscription-one",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ effect: "unknown" });
    expect(test.requests).toHaveLength(1);
  });

  it("rejects a malformed subscription identifier before any mutation", async () => {
    const test = fixture({});
    const result = await test.run(["subscription", "unfollow", "not an id"]);
    expect(result.exitCode).toBe(2);
    expect(test.requests).toHaveLength(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });
});
