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

const activeWait = {
  id: "wait-one",
  subscriptionId: "subscription-one",
  recipient: {
    projectPath: "/repos/project-one",
    conversationId: "conversation-one",
  },
  source: { kind: "workflow", id: "run-one" },
  reason: "Continue after this run",
  expiresAt: "2026-10-01T01:00:00Z",
  state: "waiting",
  outcome: null,
  deliveryId: null,
  batchId: null,
  causationBatchIds: [],
  createdAt: "2026-09-30T01:00:00Z",
  updatedAt: "2026-09-30T01:00:00Z",
  finishedAt: null,
  lastError: null,
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

const subscription = {
  id: "subscription-one",
  recipient: activeWait.recipient,
  source: { kind: "notepad", id: "notepad-one" },
  reason: "Track the decisions",
  mode: "passive",
  eventKinds: null,
  expiresAt: null,
  status: "following",
  cursor: "revision:2",
  createdAt: activeWait.createdAt,
  updatedAt: activeWait.updatedAt,
  unfollowedAt: null,
  pausedAt: null,
  missingAt: null,
  lastError: null,
};
const detail = { subscription, wait: null, batch: null };

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
  it("discovers source identities, events and supported modes without conversation identity", async () => {
    const catalog = {
      sources: [
        {
          kind: "notepad",
          label: "Notepads",
          description: "Document revisions",
          identityDescription: "Exact notepad id",
          allowedModes: ["passive"],
          eventKinds: [{ id: "notepad-content-revised", label: "Revised" }],
        },
      ],
    };
    const test = fixture(catalog, { ...projectEnv, CC_CONVERSATION_ID: "" });
    const result = await test.run(["subscription", "catalog"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/subscriptions/catalog",
    );
    expect(JSON.parse(result.stdout).payload.data).toEqual(catalog);
  });

  it("explicitly subscribes in passive mode with a detail recovery handle", async () => {
    const test = fixture(detail);
    const result = await test.run([
      "subscription",
      "subscribe",
      "notepad",
      "notepad-one",
      "--reason",
      subscription.reason,
      "--event-kind",
      "notepad-content-revised",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]?.init.method).toBe("POST");
    expect(JSON.parse(test.requests[0]?.init.body ?? "{}")).toEqual({
      source: subscription.source,
      reason: subscription.reason,
      mode: "passive",
      eventKinds: ["notepad-content-revised"],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ kind: "subscription", id: subscription.id }] },
      payload: {
        data: {
          ...detail,
          getCommand: expect.stringContaining("subscription get"),
        },
      },
    });
  });

  it("registers an explicit finite active subscription", async () => {
    const test = fixture({ ...detail, wait: activeWait });
    const result = await test.run([
      "subscription",
      "subscribe",
      "workflow",
      "run-one",
      "--reason",
      "Continue",
      "--mode",
      "active",
      "--expires-in",
      "120",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(test.requests[0]?.init.body ?? "{}")).toMatchObject({
      mode: "active",
      expiresIn: 120,
      source: { kind: "workflow", id: "run-one" },
    });
  });

  it("inspects one subscription with wait and wake evidence without mutation", async () => {
    const test = fixture({ ...detail, wait: activeWait });
    const result = await test.run(["subscription", "get", subscription.id]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.init.method).toBe("GET");
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/conversations/conversation-one/subscriptions/subscription-one",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "read",
      payload: { data: { subscription, wait: activeWait, batch: null } },
    });
  });

  it.each(["pause", "resume", "cancel"])(
    "applies the explicit %s control",
    async (action) => {
      const test = fixture(detail);
      const result = await test.run(["subscription", action, subscription.id]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(test.requests[0]?.init.method).toBe("PATCH");
      expect(JSON.parse(test.requests[0]?.init.body ?? "{}")).toEqual({
        action,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        payload: { data: { subscription } },
      });
    },
  );

  it("changes mode through the same control contract and preserves expiry", async () => {
    const test = fixture(detail);
    const result = await test.run([
      "subscription",
      "mode",
      subscription.id,
      "active",
      "--expires-in",
      "3600",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(test.requests[0]?.init.body ?? "{}")).toEqual({
      action: "mode",
      mode: "active",
      expiresIn: 3600,
    });
  });

  it("reads recorded inbox counts and changes the advisory preference", async () => {
    const counts = fixture({ pendingCount: 2, hintsEnabled: true });
    const read = await counts.run(["inbox", "summary"]);
    expect(read.exitCode, read.stdout).toBe(0);
    expect(counts.requests[0]?.url).toContain("/inbox/summary");
    expect(JSON.parse(read.stdout).payload.data).toEqual({
      pendingCount: 2,
      hintsEnabled: true,
    });
    const prefs = fixture({ hintsEnabled: false });
    const write = await prefs.run(["inbox", "hints", "off"]);
    expect(write.exitCode, write.stdout).toBe(0);
    expect(prefs.requests[0]?.url).toContain("/inbox/preferences");
    expect(prefs.requests[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(prefs.requests[0]?.init.body ?? "{}")).toEqual({
      hintsEnabled: false,
    });
  });

  it.each([
    ["subscription", "subscribe", "unknown", "id", "--reason", "Track"],
    ["subscription", "subscribe", "notepad", "id"],
    ["subscription", "mode", "id", "unknown"],
    ["subscription", "pause", "not an id"],
    ["inbox", "hints", "maybe"],
  ])("rejects invalid control input locally: %j", async (...argv) => {
    const test = fixture(detail);
    const result = await test.run(argv);
    expect(result.exitCode).toBe(2);
    expect(test.requests).toHaveLength(0);
  });

  it("keeps malformed control acknowledgement unknown with the addressed recovery id", async () => {
    const test = fixture({});
    const result = await test.run(["subscription", "pause", subscription.id]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "unknown",
      recovery: { references: [{ kind: "subscription", id: subscription.id }] },
    });
  });

  it("adds stable detail handles to the bounded subscription outline", async () => {
    const test = fixture({
      subscriptions: [subscription],
      total: 2,
      limit: 1,
      offset: 0,
    });
    const result = await test.run(["subscription", "list", "--limit", "1"]);
    expect(result.exitCode, result.stdout).toBe(0);
    const data = JSON.parse(result.stdout).payload.data;
    expect(data.subscriptions[0].getCommand).toContain("subscription get");
    expect(data.subscriptions[0].getCommand).toContain(subscription.id);
    expect(data.subscriptions[0].getCommand).toContain(
      "--conversation=conversation-one",
    );
    expect(data.next).toContain("--offset=1");
  });

  it("bounds subscription reasons in structured and text outlines", async () => {
    const test = fixture({
      subscriptions: [{ ...subscription, reason: "r".repeat(1000) }],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const result = await test.run(["subscription", "list"]);
    expect(result.exitCode, result.stdout).toBe(0);
    const row = JSON.parse(result.stdout).payload.data.subscriptions[0];
    expect(row.reasonSummary.length).toBeLessThanOrEqual(240);
    expect(row.reasonCharacters).toBe(1000);
    expect(row.reason).toBeUndefined();
  });

  it("bounds saved update content in the JSON inbox outline with its full-detail handle", async () => {
    const test = fixture({
      deliveries: [
        {
          ...pendingDelivery,
          fact: { ...pendingDelivery.fact, summary: "s".repeat(10000) },
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const result = await test.run(["inbox", "list"]);
    expect(result.exitCode, result.stdout).toBe(0);
    const row = JSON.parse(result.stdout).payload.data.deliveries[0];
    expect(row.summary.length).toBeLessThanOrEqual(240);
    expect(row.summaryCharacters).toBe(10000);
    expect(row.getCommand).toContain("inbox get");
    expect(row.fact).toBeUndefined();
  });
  it.each(["workflow", "validation", "git_job"])(
    "registers a nonblocking terminal wait for %s in project scope",
    async (kind) => {
      const test = fixture({ wait: activeWait });
      const result = await test.run([
        "subscription",
        "wait",
        kind,
        "run-one",
        "--reason",
        "Continue after this run",
        "--expires-in",
        "120",
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(test.requests).toHaveLength(1);
      expect(test.requests[0]?.url).toBe(
        "http://cc.test/api/projects/project-one/conversations/conversation-one/subscriptions/waits",
      );
      expect(test.requests[0]?.init.method).toBe("POST");
      expect(JSON.parse(test.requests[0]?.init.body ?? "{}")).toEqual({
        source: { kind, id: "run-one" },
        reason: "Continue after this run",
        expiresIn: 120,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        payload: { data: { wait: activeWait } },
      });
    },
  );

  it("rejects nonterminal sources, missing reasons and unbounded wait lifetimes locally", async () => {
    const test = fixture({});
    for (const argv of [
      ["subscription", "wait", "notepad", "notes", "--reason", "Changed"],
      ["subscription", "wait", "workflow", "run-one"],
      [
        "subscription",
        "wait",
        "workflow",
        "run-one",
        "--reason",
        "Done",
        "--expires-in",
        "0",
      ],
      [
        "subscription",
        "wait",
        "workflow",
        "run-one",
        "--reason",
        "Done",
        "--expires-in",
        "604801",
      ],
    ]) {
      expect((await test.run(argv)).exitCode).toBe(2);
    }
    expect(test.requests).toHaveLength(0);
  });

  it("reads bounded waits with scoped pagination and detail handles", async () => {
    const test = fixture({
      waits: [activeWait],
      total: 2,
      limit: 1,
      offset: 0,
    });
    const result = await test.run(["subscription", "waits", "--limit", "1"]);
    expect(result.exitCode, result.stdout).toBe(0);
    const data = JSON.parse(result.stdout).payload.data;
    expect(data.next).toContain("subscription waits");
    expect(data.next).toContain("--offset=1");
    expect(data.next).toContain("--conversation=conversation-one");
    expect(data.waits[0].getCommand).toContain("subscription wait-get");
    expect(data.waits[0].getCommand).toContain("subscription-one");
    expect(data.waits[0].getCommand).toContain("--project=project-one");
  });

  it("uses the session wait detail route when session scope is explicit", async () => {
    const test = fixture(
      { wait: activeWait, batch: null },
      {
        ...projectEnv,
        CC_CONVERSATION_SCOPE: "session",
        CC_SESSION: "session-one",
      },
    );
    const result = await test.run([
      "subscription",
      "wait-get",
      "subscription-one",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/sessions/session-one/conversations/conversation-one/subscriptions/waits/subscription-one",
    );
    expect(test.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-one",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "read",
      payload: { data: { wait: activeWait } },
    });
  });

  it("reports malformed wait acceptance as an unknown mutation effect", async () => {
    const test = fixture({});
    const result = await test.run([
      "subscription",
      "wait",
      "workflow",
      "run-one",
      "--reason",
      "Continue",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ effect: "unknown" });
    expect(test.requests).toHaveLength(1);
  });

  it("exposes uncertain wake evidence separately from a settled source result", async () => {
    const batch = {
      id: "batch-one",
      recipient: activeWait.recipient,
      waitIds: [activeWait.id],
      deliveryIds: ["delivery-one"],
      state: "uncertain",
      queueMessageId: "message-one",
      message: "Workflow finished",
      causationBatchIds: [],
      createdAt: activeWait.createdAt,
      updatedAt: activeWait.updatedAt,
      finishedAt: activeWait.updatedAt,
      lastError: "Acceptance could not be proven",
    };
    const test = fixture({
      wait: {
        ...activeWait,
        state: "settled",
        outcome: "source_terminal",
        batchId: batch.id,
        deliveryId: "delivery-one",
      },
      batch,
    });
    const result = await test.run([
      "subscription",
      "wait-get",
      "subscription-one",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const data = JSON.parse(result.stdout).payload.data;
    expect(data.wait).toMatchObject({
      state: "settled",
      outcome: "source_terminal",
    });
    expect(data.batch).toMatchObject({
      state: "uncertain",
      lastError: batch.lastError,
    });
    expect(data.deliveryCommand).toContain("inbox get");
    expect(data.deliveryCommand).toContain("delivery-one");
    expect(data.deliveryCommand).toContain("--conversation=conversation-one");
  });

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
      pausedAt: null,
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
