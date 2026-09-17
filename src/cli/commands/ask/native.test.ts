import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const payload = {
  questions: [
    { question: "Which delivery?", options: [{ label: "Full migration" }] },
  ],
};

describe("CC question batches", () => {
  it("registers one batch and returns its real ID with the required handoff", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/questions.json": JSON.stringify(payload) },
      respond: () => jsonReply({ ok: true, questionBatchId: "batch-one" }),
    });
    const result = await fixture.run(["ask", "--file", "/questions.json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      effect: "applied",
      payload: { kind: "inline", data: { questionBatchId: "batch-one" } },
      recovery: {
        kind: "reported",
        references: [{ kind: "question-batch", id: "batch-one" }],
      },
      instruction: expect.stringMatching(/end your turn/i),
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/sessions/session-one/conversations/conversation-one/ask",
    );
    expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toMatchObject(
      payload,
    );
  });

  it("rejects an empty batch before resolving credentials or calling the server", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/questions.json": JSON.stringify({ questions: [] }) },
      env: { CC_API_TOKEN: undefined },
      respond: () => {
        throw new Error("invalid payload must stay local");
      },
    });
    const result = await fixture.run(["ask", "--file", "/questions.json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["questions"] }),
        ]),
      },
    });
    expect(fixture.requests).toHaveLength(0);
  });
});
