import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const prompt = JSON.stringify({
  backend: "codex",
  prompt: "Inspect the worktree",
});
describe("native agent commands", () => {
  it.each([
    "instruction: a literal profile rule",
    "Terminal \u001b[31m sample",
  ])("renders profile prose as data: %s", async (instructions) => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          id: "reviewer",
          tier: "global",
          revision: 3,
          name: "Reviewer",
          description: "Inspect changes",
          instructions,
          recommendedFor: ["workflow_validator"],
          tags: ["review"],
          readOnly: false,
        }),
    });
    const result = await fixture.run(
      ["agent", "get", "global:reviewer"],
      "text",
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      instructions.startsWith("instruction:")
        ? "| instruction: a literal profile rule"
        : "Terminal \\u001b[31m sample",
    );
  });

  it("keeps explicit public scope on cancellation follow-up without publishing the token", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply({ ok: true, status: "failed" }),
    });
    const result = await fixture.run([
      "agent",
      "cancel",
      "agent-one",
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
  });

  it("launches a validated payload and retains its receipt when waiting cannot read status", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/prompt.json": prompt },
      respond: ({ init }) =>
        init.method === "POST"
          ? jsonReply({ runId: "agent-one" }, 202)
          : jsonReply({ error: "unavailable", code: "overloaded" }, 503),
    });
    const result = await fixture.run([
      "agent",
      "run",
      "--file",
      "/prompt.json",
      "--wait",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ kind: "agent-run", id: "agent-one" }] },
    });
    expect(fixture.requests).toHaveLength(2);
    expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toEqual({
      backend: "codex",
      prompt: "Inspect the worktree",
    });
  });
  it("returns a completed wait result in one envelope", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/prompt.json": prompt },
      respond: ({ init }) =>
        init.method === "POST"
          ? jsonReply({ runId: "agent-one" }, 202)
          : jsonReply({
              runId: "agent-one",
              backend: "codex",
              status: "completed",
              summary: "Done",
              referenceDocuments: [
                { filePath: "notes.md", description: "Findings" },
              ],
            }),
    });
    const result = await fixture.run([
      "agent",
      "run",
      "--file",
      "/prompt.json",
      "--wait",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: { runId: "agent-one", status: "completed", summary: "Done" },
      },
    });
  });
  it.each(["Provider failed\nsecond line", "é".repeat(300), ""])(
    "keeps the accepted agent receipt when its failure diagnostic is %j",
    async (error) => {
      const fixture = createCcRuntimeFixture({
        files: { "/prompt.json": prompt },
        respond: (request) =>
          request.init.method === "POST"
            ? jsonReply({ runId: "agent-one" }, 202)
            : jsonReply({
                runId: "agent-one",
                backend: "codex",
                status: "failed",
                error,
              }),
      });
      const result = await fixture.run([
        "agent",
        "run",
        "--file",
        "/prompt.json",
        "--wait",
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        error: { code: "CC_OPERATION_FAILED" },
        recovery: { references: [{ kind: "agent-run", id: "agent-one" }] },
        payload: { data: { status: "failed", error } },
      });
    },
  );
  it("rejects a timeout without wait", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/prompt.json": prompt },
      respond: () => jsonReply({}),
    });
    expect(
      (
        await fixture.run([
          "agent",
          "run",
          "--file",
          "/prompt.json",
          "--timeout",
          "2m",
        ])
      ).exitCode,
    ).toBe(2);
    expect(fixture.requests).toHaveLength(0);
  });
  it("ends a zero-budget wait with applied recovery and no cancellation request", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/prompt.json": prompt },
      respond: () => jsonReply({ runId: "agent-one" }),
    });
    const result = await fixture.run([
      "agent",
      "run",
      "--file",
      "/prompt.json",
      "--wait",
      "--timeout",
      "0ms",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      error: { message: expect.stringContaining("timed out") },
      recovery: { references: [{ id: "agent-one" }] },
    });
    expect(fixture.requests).toHaveLength(1);
  });
  it("reads profile metadata from project context and rejects unqualified references locally", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_SESSION: undefined },
      respond: () =>
        jsonReply({
          profiles: [],
          diagnostics: [
            { tier: "global", id: "broken", reason: "Invalid file" },
          ],
        }),
    });
    const result = await fixture.run(["agent", "list"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: { data: { diagnostics: [{ id: "broken" }] } },
    });
    expect((await fixture.run(["agent", "get", "unqualified"])).exitCode).toBe(
      2,
    );
    expect(fixture.requests).toHaveLength(1);
  });
  it("renders profile instructions from the qualified project library route", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_SESSION: undefined },
      respond: () =>
        jsonReply({
          id: "reviewer",
          tier: "global",
          revision: 3,
          name: "Reviewer",
          description: "Inspect changes",
          instructions: "Review the evidence thoroughly.",
          recommendedFor: ["workflow_validator"],
          tags: ["review"],
          readOnly: false,
        }),
    });
    const result = await fixture.run(
      ["agent", "get", "global:reviewer"],
      "text",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Review the evidence thoroughly.");
    expect(fixture.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/agent-profiles/global/reviewer",
    );
  });
});
