import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";
const lane = {
  CC_WORKFLOW_EXECUTION_ID: "execution-one",
  CC_WORKFLOW_CONTEXT_ID: "context-one",
  CC_AGENT_BACKEND: "codex",
};
describe("native workflow lane commands", () => {
  it("completes the addressed task with independent issuing principal and preserves the stop instruction", async () => {
    const fixture = createCcRuntimeFixture({
      env: lane,
      respond: () =>
        jsonReply({
          ok: true,
          remainingTaskCount: 2,
          stopInstruction: "End this turn now to rotate context.",
        }),
    });
    const result = await fixture.run([
      "workflow",
      "task",
      "complete",
      "task-one",
      "--summary",
      "Built and tested",
      "--conversation",
      "target-other",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      instruction: "End this turn now to rotate context.",
      payload: { data: { remainingTaskCount: 2, taskId: "task-one" } },
    });
    expect(fixture.requests[0]?.url).toContain(
      "/contexts/context-one/tasks/task-one/complete",
    );
    expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toEqual({
      executionId: "execution-one",
      summary: "Built and tested",
    });
    expect(
      JSON.parse(
        fixture.requests[0]?.init.headers["x-cc-lane-identity"] ?? "null",
      ),
    ).toMatchObject({ conversationId: "conversation-one" });
  });
  it("preserves collaboration receipt and end-turn instruction", async () => {
    const fixture = createCcRuntimeFixture({
      env: lane,
      respond: () =>
        jsonReply({ ok: true, status: "started", workflowId: "collab-one" }),
    });
    const result = await fixture.run([
      "workflow",
      "collab",
      "request",
      "--brief",
      "Review the interface",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ id: "collab-one" }] },
      instruction: expect.stringContaining("End your turn"),
    });
  });
  it("keeps replayed graph expansion receipts and server refusal details", async () => {
    const fixture = createCcRuntimeFixture({
      env: lane,
      files: {
        "/expansion.json": JSON.stringify({
          requestId: "request-one",
          contexts: [],
          tasks: [],
        }),
      },
      respond: () =>
        jsonReply({
          replayed: true,
          liveRevision: 3,
          createdContextIds: ["child-one"],
          createdTaskIds: [],
          rejoinContextIds: ["context-two"],
        }),
    });
    const result = await fixture.run([
      "workflow",
      "graph",
      "expand",
      "--file",
      "/expansion.json",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { replayed: true, liveRevision: 3 } },
    });
    expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toMatchObject({
      executionId: "execution-one",
      request: { requestId: "request-one" },
    });
    const refused = createCcRuntimeFixture({
      env: lane,
      respond: () =>
        jsonReply(
          {
            error: "Lane is halted",
            code: "context_halted",
            details: { halt: "review" },
            instruction: "Wait for the review.",
          },
          409,
        ),
    });
    expect(
      JSON.parse(
        (
          await refused.run([
            "workflow",
            "task",
            "add",
            "--title",
            "New",
            "--instructions",
            "Do the work",
          ])
        ).stdout,
      ),
    ).toMatchObject({
      effect: "not_applied",
      error: {
        details: {
          serverCode: "context_halted",
          serverDetails: { halt: "review" },
        },
      },
      instruction: "Wait for the review.",
    });
  });
  it("requires lane identity and registers encoded shared-document paths", async () => {
    const fixture = createCcRuntimeFixture({
      env: lane,
      files: {
        "/doc.json": JSON.stringify({
          description: "Contract",
          readWhen: "Before implementation",
        }),
      },
      respond: () => jsonReply({ ok: true }),
    });
    expect(
      (
        await fixture.run([
          "workflow",
          "shared-doc",
          "upsert",
          ".cc/docs/api contract.md",
          "--file",
          "/doc.json",
        ])
      ).exitCode,
    ).toBe(0);
    expect(fixture.requests[0]?.url).toContain(
      "/shared-documents/.cc/docs/api%20contract.md",
    );
    const noLane = createCcRuntimeFixture({
      respond: () => jsonReply({ ok: true }),
    });
    expect(
      (
        await noLane.run([
          "workflow",
          "task",
          "add",
          "--title",
          "New",
          "--instructions",
          "Do the work",
        ])
      ).exitCode,
    ).toBe(2);
    expect(noLane.requests).toHaveLength(0);
  });
});
