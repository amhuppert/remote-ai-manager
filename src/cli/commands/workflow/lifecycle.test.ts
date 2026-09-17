import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";
const plan = JSON.stringify({ name: "Plan", definition: {} });
const receipt = {
  executionId: "execution-one",
  status: "running",
  origin: { kind: "one_off", planName: "Plan" },
  originConversationId: "conversation-one",
  deepLink: "/projects/project-one/sessions/session-one",
  startedAt: "2026-09-17T00:00:00Z",
};
const boundary = {
  cursor: 2,
  occurredAt: "2026-09-17T00:01:00Z",
  executionId: "execution-one",
  boundaryKind: "completion",
  status: "completed",
  contextId: null,
  pendingActions: [],
  outputs: { summary: "Done" },
  name: "Plan",
  origin: receipt.origin,
  originConversationId: "conversation-one",
  startedAt: receipt.startedAt,
  completedAt: "2026-09-17T00:01:00Z",
  haltReason: null,
  abandonment: null,
  documents: [],
  deepLink: receipt.deepLink,
};
describe("native workflow lifecycle", () => {
  it.each(["launch", "reattach"])(
    "keeps explicit public scope on the %s continuation",
    async (mode) => {
      const fixture = createCcRuntimeFixture({
        files: { "/plan.json": plan },
        respond: () => jsonReply({ receipt }),
      });
      const command =
        mode === "launch"
          ? ["workflow", "run", "--file", "/plan.json"]
          : [
              "workflow",
              "wait",
              "execution-one",
              "--cursor",
              "4",
              "--timeout",
              "0ms",
            ];
      const result = await fixture.run([
        ...command,
        "--server",
        "http://other.test",
        "--project",
        "other-project",
        "--session",
        "other-session",
        "--conversation",
        "other-conversation",
        "--token",
        "secret-override",
      ]);
      const hint = JSON.parse(result.stdout).hint;
      for (const flag of [
        "--server=http://other.test",
        "--project=other-project",
        "--session=other-session",
        "--conversation=other-conversation",
      ])
        expect(hint).toContain(flag);
      expect(result.stdout).not.toContain("secret-override");
    },
  );

  it("keeps one-off launch receipt and boundary result in a single envelope", async () => {
    const fixture = createCcRuntimeFixture({
      files: {
        "/plan.json": plan,
        "/inputs.json": JSON.stringify({ target: "cc" }),
      },
      respond: ({ init }) =>
        init.method === "POST"
          ? jsonReply({ receipt })
          : jsonReply({ result: boundary }),
    });
    const result = await fixture.run([
      "workflow",
      "run",
      "--file",
      "/plan.json",
      "--inputs",
      "/inputs.json",
      "--wait",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ id: "execution-one" }] },
      payload: { data: { receipt, result: boundary, cursor: "2" } },
    });
    expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toMatchObject({
      plan: { name: "Plan" },
      inputs: { target: "cc" },
    });
  });
  it("preserves accepted receipt and cursor on failed observation without cancelling", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/plan.json": plan },
      respond: ({ init }) =>
        init.method === "POST"
          ? jsonReply({ receipt })
          : jsonReply({ error: "Unavailable" }, 503),
    });
    const result = await fixture.run([
      "workflow",
      "run",
      "--file",
      "/plan.json",
      "--wait",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: { receipt, executionId: "execution-one", cursor: null },
      },
      recovery: { references: [{ id: "execution-one" }] },
    });
    const timeout = await fixture.run([
      "workflow",
      "wait",
      "execution-one",
      "--cursor",
      "41",
      "--timeout",
      "0ms",
    ]);
    expect(JSON.parse(timeout.stdout)).toMatchObject({
      effect: "read",
      payload: { data: { executionId: "execution-one", cursor: "41" } },
    });
    expect(
      fixture.requests.filter((request) => request.url.endsWith("/cancel")),
    ).toHaveLength(0);
  });
  it("retains parked saved-definition launches and user approval instruction", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          execution: {
            executionId: "execution-one",
            status: "awaiting_definition_approval",
          },
          receipt: { status: "awaiting_definition_approval" },
        }),
    });
    const result = await fixture.run(["workflow", "start", "definition-one"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      instruction: expect.stringContaining("Approve"),
      recovery: { references: [{ id: "execution-one" }] },
    });
  });
  it("uses principal identity for lifecycle acts and preserves the execution returned by the server", async () => {
    const execution = { executionId: "execution-one", status: "paused" };
    const fixture = createCcRuntimeFixture({
      env: { CC_CONVERSATION: "issuer-one" },
      respond: () => jsonReply({ execution }),
    });
    const result = await fixture.run([
      "workflow",
      "live",
      "pause",
      "--conversation",
      "other-target",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { execution } },
    });
    expect(
      JSON.parse(
        fixture.requests[0]?.init.headers["x-cc-conversation-identity"] ??
          "null",
      ),
    ).toMatchObject({ conversationId: "issuer-one" });
  });
  it("refuses one-off project conversation launch before HTTP", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_CONVERSATION_SCOPE: "project" },
      files: { "/plan.json": plan },
      respond: () => jsonReply({ receipt }),
    });
    const result = await fixture.run([
      "workflow",
      "run",
      "--file",
      "/plan.json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(fixture.requests).toHaveLength(0);
  });
});
